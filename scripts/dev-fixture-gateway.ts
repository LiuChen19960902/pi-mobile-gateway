// Dev/test fixture: the REAL gateway planes (server.ts + router.ts + mgmt.ts +
// credentials/devices) driven by the REAL PiRuntime wired to a scripted fake
// pi session. Only pi itself is fake — every protocol layer on both sides is
// production code.
//
// Isolation by construction: both listeners bind 127.0.0.1, the device
// registry and session dir live in mkdtemp directories, HOME is redirected to
// a temp dir (the directories/workspace service resolves home via
// os.homedir()), and nothing touches ~/.pi, real models, or any non-loopback
// network.
//
// Machine-readable stdout contract (everything else must go to stderr):
//   FIXTURE_READY {"dataPort":N,"mgmtPort":N,"pairingText":"...","shortCode":"000000","fixtureSessionId":"...","fixtureCwd":"..."}
//
// The process stays alive until its stdin closes (the test harness destroys
// it) or it receives SIGTERM/SIGINT.

import "../src/http-runtime.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { AgentSessionEvent, PromptOptions, SessionManager } from "@earendil-works/pi-coding-agent";
import { BridgeHub } from "../src/bridge.ts";
import { createRegistry } from "../src/devices.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { startMgmtPlane } from "../src/mgmt.ts";
import { encodePairingText } from "../src/pairing.ts";
import { PiRuntime, type PiSessionLike } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";
import { startDataPlane } from "../src/server.ts";

const log = (message: string): void => {
	process.stderr.write(`[fixture] ${message}\n`);
};

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** One scripted pi session. `prompt()` replays a deterministic streaming
 * turn: assistant text deltas, the final message, settle, end. */
class ScriptedSession implements PiSessionLike {
	sessionId: string;
	sessionFile: string | undefined;
	isStreaming = false;
	isCompacting = false;
	model = { id: "fixture-model", provider: "fixture" };
	thinkingLevel = "medium";
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly timers: NodeJS.Timeout[] = [];
	private aborted = false;

	private readonly manager: SessionManager;
	/** bindExtensions 下发的扩展 UI 上下文（状态桥测试用）。 */
	bindings: Record<string, unknown> | undefined;

	constructor(sessionManager: SessionManager) {
		this.manager = sessionManager;
		this.sessionId = sessionManager.getSessionId();
		this.sessionFile = sessionManager.getSessionFile();
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	bindExtensions(bindings: Record<string, unknown>): Promise<void> {
		this.bindings = bindings;
		return Promise.resolve();
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private schedule(delayMs: number, emit: () => void): void {
		if (this.aborted) return;
		this.timers.push(
			setTimeout(() => {
				if (!this.aborted) emit();
			}, delayMs),
		);
	}

	prompt(
		text: string,
		options?: {
			streamingBehavior?: "steer" | "followUp";
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			preflightResult?: PromptOptions["preflightResult"];
		},
	): Promise<void> {
		// Deterministic streaming turn, shaped like a real pi assistant run.
		// pi admits the prompt first (prompt() resolves) and streams the run
		// asynchronously afterwards — replay that ordering, or every event
		// would land before the router's `sent` frame and invert the race the
		// client must survive. Deltas are staggered so `abort()` has a live
		// stream to interrupt.
		if (text === "fixture:handled") {
			options?.preflightResult?.("handled");
			return Promise.resolve();
		}
		if (text === "fixture:status") {
			// 状态桥场景：扩展在运行期 setStatus，稍后清除；不产生 streaming 回合。
			const uiContext = this.bindings?.uiContext as { setStatus(key: string, text?: string): void } | undefined;
			options?.preflightResult?.("handled");
			uiContext?.setStatus("fixture", "1 agent running");
			this.schedule(80, () => uiContext?.setStatus("fixture", undefined));
			return Promise.resolve();
		}
		options?.preflightResult?.("started");
		this.isStreaming = true;
		// 与 pi 原生一致，但保持基线形状：text-only 请求 content 仍是 string；
		// 带 images 时才升级为 [{type:"text",text}, ...images] 数组。图片随消息
		// 落盘，之后 history 能看到（带 dataOmitted 剥图）、attachment 帧能按
		// entryId+imageIndex 取回原图。
		const images = options?.images ?? [];
		const userMessage = (images.length > 0
			? { role: "user", content: [{ type: "text", text }, ...images] }
			: { role: "user", content: text }) as unknown as Parameters<SessionManager["appendMessage"]>[0];
		this.schedule(20, () => {
			this.emit({ type: "message_start", message: userMessage } as AgentSessionEvent);
			this.emit({ type: "message_end", message: userMessage } as AgentSessionEvent);
			this.manager.appendMessage(userMessage);
		});
		const reply = `回复:${text}`;
		this.schedule(25, () => {
			this.emit({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
			this.emit({ type: "turn_start" } as AgentSessionEvent);
		});
		this.schedule(75, () => {
			this.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "你好" },
			} as AgentSessionEvent);
		});
		this.schedule(125, () => {
			this.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "，世界" },
			} as AgentSessionEvent);
		});
		this.schedule(175, () => {
			this.isStreaming = false;
			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: reply }],
			} as unknown as Parameters<SessionManager["appendMessage"]>[0];
			// assistant 同样先 emit 再 append（与 pi 的 AgentSession 同序）。
			this.emit({ type: "message_end", message: assistantMessage } as AgentSessionEvent);
			this.manager.appendMessage(assistantMessage);
		});
		this.schedule(200, () => this.emit({ type: "agent_settled", aborted: this.aborted } as AgentSessionEvent));
		this.schedule(210, () => this.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent));
		return Promise.resolve();
	}

	abort(): Promise<void> {
		// 真实 pi 中止后回合仍会落定：没有最终 message_end，流式半成品保留。
		this.aborted = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.length = 0;
		this.isStreaming = false;
		this.emit({ type: "agent_settled", aborted: this.aborted } as AgentSessionEvent);
		this.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
		return Promise.resolve();
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		return { steering: [], followUp: [] };
	}

	getSteeringMessages(): readonly string[] {
		return [];
	}

	getFollowUpMessages(): readonly string[] {
		return [];
	}

	getContextUsage() {
		return { percent: 42, contextWindow: 100_000, tokens: 42_000 };
	}

	dispose(): void {}
}

/** A pre-existing session on disk, so the conformance test can exercise the
 * "select existing session → subscribe → history page" path too. */
function writeFixtureSession(sessionDir: string, cwd: string): void {
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({ type: "model_change", id: "e0", parentId: null, provider: "fixture", modelId: "fixture-model" }),
		JSON.stringify({
			type: "message",
			id: "e1",
			parentId: "e0",
			message: { role: "user", content: "hello" },
		}),
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

const dirs: string[] = [];
const cleanup = (): void => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};
// 任何模块解析 home 之前先重定向：directories/workspace 服务走
// os.homedir()（POSIX 上优先读 $HOME），不重定向的话每次一致性测试都会
// 在真实 ~ 下留下一个 `工作区-*` 空目录。
const fixtureHome = mkdtempSync(join(tmpdir(), "pi-mgw-fix-home-"));
process.env.HOME = fixtureHome;
dirs.push(fixtureHome);
log(`HOME redirected to ${fixtureHome}`);
process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});
process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});

const sessionsDir = mkdtempSync(join(tmpdir(), "pi-mgw-fix-sessions-"));
const deviceDir = mkdtempSync(join(tmpdir(), "pi-mgw-fix-devices-"));
dirs.push(sessionsDir, deviceDir);

// New-session flow needs a real directory for the `cwd` frame.
const fixtureCwd = mkdtempSync(join(tmpdir(), "pi-mgw-fix-cwd-"));
dirs.push(fixtureCwd);
writeFixtureSession(sessionsDir, fixtureCwd);

const registry = createRegistry(join(deviceDir, "devices.json"));
// 与生产装配一致：桥接模式与持久化都走真实代码，只把运行目录隔离到 fixture HOME。
const hostModeStore = new HostModeStore(join(fixtureHome, "host-mode.json"));
const bridge = new BridgeHub({ root: join(fixtureHome, "mobile-bridge"), log });
const sessions = new Map<string, ScriptedSession>();
const runtime = new PiRuntime({
	agentDir: join(fixtureHome, ".pi", "agent"),
	sessionDir: sessionsDir,
	sessionFactory: async ({ sessionManager }) => {
		const session = new ScriptedSession(sessionManager);
		sessions.set(session.sessionId, session);
		return session;
	},
	idleDisposeMs: 60_000,
	log: (message) => log(`[pi-runtime] ${message}`),
});

const dataPlane = await startDataPlane({
	registry,
	port: 0,
	host: "127.0.0.1",
	onClient: (send) =>
		connectClient(runtime, send, {
			log: (message) => log(`[router] ${message}`),
			hostModeStore,
			bridge,
		}),
});
const mgmtPlane = await startMgmtPlane({
	registry,
	port: 0,
	dataPort: dataPlane.port,
	publicUrl: () => `ws://127.0.0.1:${dataPlane.port}/ws/mobile`,
});

const pairing = registry.createPairing("conformance-client");
const pairingText = encodePairingText({
	version: 1,
	publicUrl: `ws://127.0.0.1:${dataPlane.port}/ws/mobile`,
	pairingCode: pairing.code,
	expiresAt: pairing.expiresAt,
});

process.stdout.write(
	`FIXTURE_READY ${JSON.stringify({
		dataPort: dataPlane.port,
		mgmtPort: mgmtPlane.port,
		pairingText,
		shortCode: pairing.shortCode,
		fixtureSessionId: SESSION_ID,
		fixtureCwd,
	})}\n`,
);

// Stay alive for the harness; exit when stdin closes (ProcessBuilder.destroy
// also works). This mirrors `new Promise(() => {})` in pi's own RPC host.
process.stdin.resume();
process.stdin.on("end", () => {
	void dataPlane
		.close()
		.then(() => mgmtPlane.close())
		.then(() => cleanup());
});
