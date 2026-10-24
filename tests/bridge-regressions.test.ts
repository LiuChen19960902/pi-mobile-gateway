// 复审 F3–F9 的回归用例：生产 router + 扩展 IPC，合成 socket/上下文，不运行模型。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoredQueuePrefix } from "../bridge-extension/src/editor.ts";
import mobileBridge, { dequeueFailureCode, queueOutcomeOnAbort } from "../bridge-extension/src/index.ts";
import { BridgeHub } from "../src/bridge.ts";
import type { BridgeLauncher } from "../src/bridge-launch.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";

const dirs: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();

after(() => {
	for (const socket of sockets) socket.destroy();
	for (const server of servers) server.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

async function listen(server: Server, path: string): Promise<void> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

interface RouterFixture {
	root: string;
	sessionId: string;
	refuseSnapshots: () => void;
	replyHistoryTooLarge: () => void;
	failAbortWithQueuedText: (text: string | null, disposition?: string | null) => void;
	failDequeueWith: (code: string) => void;
	pushEvent: (event: Record<string, unknown>) => void;
}

async function startRouterFixture(): Promise<RouterFixture> {
	const root = tempDir("pi-mgw-regression-");
	const registry = join(root, "registry");
	mkdirSync(registry, { recursive: true });
	const socketPath = join(root, "fixture.sock");
	const sessionId = "11111111-2222-3333-4444-555555555555";
	const descriptor = {
		schema: 1,
		extensionVersion: "0.2.0",
		instanceId: "fixture-instance",
		epoch: "fixture-epoch",
		sessionId,
		pid: process.pid,
		socketPath,
		owner: true,
		startedAt: Date.now(),
		cwd: root,
		sessionFile: null,
	};
	const snapshot = {
		...descriptor,
		seq: 1,
		busy: true,
		pending: false,
		leafId: null,
		model: null,
		thinkingLevel: "off",
		editor: "unavailable",
		partial: null,
		tools: [],
	};
	writeFileSync(join(registry, `${sessionId}.json`), `${JSON.stringify(descriptor)}\n`);
	let refuse = false;
	let historyTooLarge = false;
	let abortFailureText: string | null = null;
	let abortFailureDisposition: string | null = null;
	let dequeueFailureReplyCode: string | null = null;
	let eventSeq = 0;
	const liveSockets = new Set<Socket>();
	const pushEvent = (event: Record<string, unknown>) => {
		eventSeq += 1;
		const frame = { kind: "event", seq: eventSeq, isCompacting: false, isStreaming: true, event };
		for (const live of liveSockets) live.write(`${JSON.stringify(frame)}\n`);
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		liveSockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
			liveSockets.delete(socket);
		});
		socket.on("error", () => socket.destroy());
		socket.write(`${JSON.stringify({ kind: "hello", snapshot })}\n`);
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as { id?: string; op?: string };
				if (request.op === "snapshot" && refuse) {
					socket.destroy();
					continue;
				}
				const payload =
					request.op === "dequeue" && dequeueFailureReplyCode !== null
						? { ok: false, code: dequeueFailureReplyCode }
						: request.op === "abort" && abortFailureText !== null
							? {
									ok: false,
									code: "submission-failed",
									queuedText: abortFailureText,
									...(abortFailureDisposition ? { queuedDisposition: abortFailureDisposition } : {}),
								}
							: request.op === "snapshot"
								? { ok: true, snapshot }
								: request.op === "history" && historyTooLarge
									? {
											ok: true,
											entries: [
												{
													id: "huge",
													type: "message",
													message: { role: "assistant", content: "x".repeat(24 * 1024 * 1024) },
												},
											],
											hasMore: false,
											oldestEntryId: "huge",
											leafId: "huge",
											model: null,
											thinkingLevel: "off",
											busy: true,
											pending: false,
										}
									: request.op === "history"
										? { ok: true, entries: [], hasMore: false, oldestEntryId: null }
										: { ok: false, code: "busy" };
				socket.write(`${JSON.stringify({ kind: "reply", id: request.id, ...payload })}\n`);
			}
		});
	});
	await listen(server, socketPath);
	return {
		root,
		sessionId,
		refuseSnapshots: () => {
			refuse = true;
		},
		replyHistoryTooLarge: () => {
			historyTooLarge = true;
		},
		failAbortWithQueuedText: (text: string | null, disposition: string | null = null) => {
			abortFailureText = text;
			abortFailureDisposition = disposition;
		},
		failDequeueWith: (code: string) => {
			dequeueFailureReplyCode = code;
		},
		pushEvent,
	};
}

async function waitForFrame(
	frames: Array<Record<string, unknown>>,
	test: (frame: Record<string, unknown>) => boolean,
	timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = frames.find(test);
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error(`frame not received: ${JSON.stringify(frames.at(-1))}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("review regressions: bridge routing", () => {
	it("does not open SDK for worktree-list, keeps native busy, and blocks switch when owner is unknown", async () => {
		const fixture = await startRouterFixture();
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const hub = new BridgeHub({ root: fixture.root });
		let sdkOpenCalls = 0;
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
			openSession: async () => {
				sdkOpenCalls += 1;
				throw new Error("SDK open must not run in bridge mode");
			},
		}) as PiRuntime;
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge: hub });
		const last = () => frames.at(-1) as Record<string, unknown>;

		await client.handleMessage({ type: "worktree-list", queryId: "q1", sessionId: fixture.sessionId });
		assert.equal(sdkOpenCalls, 0);
		assert.equal(last().kind, "error");
		assert.equal(last().requestType, "worktree-list");

		await client.handleMessage({ type: "message", sessionId: fixture.sessionId, text: "hi", operationId: "op-1" });
		assert.equal(last().kind, "error");
		assert.equal(last().code, "busy");
		assert.equal(last().requestType, "message");
		assert.equal(last().operationId, "op-1");
		assert.equal(last().instanceId, hub.descriptor(fixture.sessionId)?.instanceId);
		assert.equal(last().epoch, hub.descriptor(fixture.sessionId)?.epoch);

		fixture.replyHistoryTooLarge();
		await client.handleMessage({ type: "history", sessionId: fixture.sessionId });
		assert.equal(last().kind, "error");
		assert.equal(last().code, "frame-too-large");
		assert.equal(last().requestType, "history");

		fixture.refuseSnapshots();
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(last().code, "mode-switch-blocked");
		assert.deepEqual(last().reasons, ["owner-unknown"]);
		assert.equal(modeStore.read(), "bridge");
		client.close();
	});

	it("pull snapshots carry instance identity and event watermark", async () => {
		const fixture = await startRouterFixture();
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const hub = new BridgeHub({ root: fixture.root });
		const frames: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
			state: async () => {
				throw new Error("bridge state must not fall back to the SDK runtime");
			},
		}) as PiRuntime;
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge: hub });
		const descriptor = hub.descriptor(fixture.sessionId);
		assert.ok(descriptor);
		// 拉式快照（前台对账 state、补拉 history）必须可判定新旧与代际：
		// 客户端用它排定与已消费终态事件的先后，否则迟到的 busy 会复活 Working。
		await client.handleMessage({ type: "state", sessionId: fixture.sessionId });
		const state = frames.filter((frame) => frame.kind === "state").at(-1);
		assert.ok(state, "bridge state reply must exist");
		assert.equal(state.instanceId, descriptor.instanceId);
		assert.equal(state.epoch, descriptor.epoch);
		assert.equal(typeof state.bridgeSeq, "number");
		await client.handleMessage({ type: "history", sessionId: fixture.sessionId });
		const history = frames.filter((frame) => frame.kind === "history").at(-1);
		assert.ok(history, "bridge history reply must exist");
		assert.equal(history.instanceId, descriptor.instanceId);
		assert.equal(history.epoch, descriptor.epoch);
		assert.equal(typeof history.bridgeSeq, "number");
		client.close();
	});

	it("budgets oversized bridge events and still delivers the settle frame", async () => {
		const fixture = await startRouterFixture();
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const hub = new BridgeHub({ root: fixture.root });
		const frames: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
		}) as PiRuntime;
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge: hub });
		await client.handleMessage({ type: "subscribe", sessionId: fixture.sessionId });
		await waitForFrame(frames, (frame) => frame.kind === "bridge-snapshot");
		// 2 MiB 图片事件：单帧预算把它换成占位，而不是把出站缓冲推到断线。
		fixture.pushEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "image", mimeType: "image/png", data: "A".repeat(2 * 1024 * 1024) }],
			},
		});
		fixture.pushEvent({ type: "agent_settled" });
		const settled = await waitForFrame(
			frames,
			(frame) => (frame.event as { type?: string } | undefined)?.type === "agent_settled",
		);
		const big = frames.find(
			(frame) => (frame.event as { type?: string } | undefined)?.type !== "agent_settled" && frame.kind === "event",
		);
		assert.ok(big, "oversized event must still reach the client as a frame");
		const serialized = JSON.stringify(big.event);
		assert.ok(serialized.length < 1024 * 1024, `event must be budgeted, got ${serialized.length} chars`);
		const block = JSON.parse(serialized).message?.content?.[0];
		assert.equal(block?.dataOmitted, true, "image payload must be replaced by a placeholder");
		assert.equal(block?.dataBytes, 2 * 1024 * 1024);
		assert.equal(block?.mimeType, "image/png");
		// 终态帧紧跟其后且 seq 连续：大事件不得吞掉 agent_settled。
		assert.equal(typeof settled.seq, "number");
		const bigSeq = big.seq as number;
		assert.equal((settled.seq as number) - bigSeq, 1);
		client.close();
	});

	it("forwards the dequeue-unconfirmed code instead of collapsing it to internal", async () => {
		const fixture = await startRouterFixture();
		fixture.failDequeueWith("dequeue-unconfirmed");
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const hub = new BridgeHub({ root: fixture.root });
		const descriptor = hub.descriptor(fixture.sessionId);
		assert.ok(descriptor);
		const frames: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
		}) as PiRuntime;
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge: hub });
		await client.handleMessage({
			type: "dequeue",
			sessionId: fixture.sessionId,
			queueRequestId: "dequeue-unconfirmed-1",
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
		});
		const error = frames.find((frame) => frame.kind === "error") as Record<string, unknown>;
		assert.equal(error.kind, "error");
		assert.equal(error.requestType, "dequeue");
		// "动作已执行但没捕获到文字"不能被压成 internal：手机要靠这个码说
		// "排队消息去向未确认"，而不是通用"操作失败"或不存在的"没动队列"。
		assert.equal(error.code, "dequeue-unconfirmed");
		assert.equal(error.queueRequestId, "dequeue-unconfirmed-1");
		client.close();
	});

	it("abort failure keeps queued text and operation identity for the client", async () => {
		const fixture = await startRouterFixture();
		fixture.failAbortWithQueuedText("queued draft", "unknown");
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const hub = new BridgeHub({ root: fixture.root });
		const descriptor = hub.descriptor(fixture.sessionId);
		assert.ok(descriptor);
		const frames: Array<Record<string, unknown>> = [];
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
		}) as PiRuntime;
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge: hub });
		await client.handleMessage({
			type: "abort",
			sessionId: fixture.sessionId,
			operationId: "abort-op",
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
			restoreQueued: true,
		});
		const error = frames.at(-1) as Record<string, unknown>;
		assert.equal(error.kind, "error");
		assert.equal(error.code, "bridge-offline");
		assert.equal(error.queuedText, "queued draft");
		assert.deepEqual(error.queued, ["queued draft"]);
		assert.equal(error.queuedDisposition, "unknown", "失败回执也要透传三态，客户端不能退回布尔猜测");
		assert.equal(error.operationId, "abort-op");
		assert.equal(error.instanceId, descriptor.instanceId);
		assert.equal(error.epoch, descriptor.epoch);

		// 旧代际拒绝也必须回显请求的 operationId，客户端才能按请求级失败收尾。
		await client.handleMessage({
			type: "abort",
			sessionId: fixture.sessionId,
			operationId: "stale-op",
			instanceId: descriptor.instanceId,
			epoch: "stale-epoch",
			restoreQueued: true,
		});
		const stale = frames.at(-1) as Record<string, unknown>;
		assert.equal(stale.kind, "error");
		assert.equal(stale.code, "bridge-stale-runtime");
		assert.equal(stale.operationId, "stale-op");
		assert.equal(stale.instanceId, descriptor.instanceId);
		assert.equal(stale.epoch, descriptor.epoch);
		client.close();
	});

	it("starts an offline bridge session and returns an attach hint", async () => {
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-regression-mode-"), "mode.json"));
		modeStore.write("bridge");
		const calls: Array<Record<string, unknown>> = [];
		const launcher = {
			launch: async (input: Record<string, unknown>) => {
				calls.push(input);
				return {
					sessionId: input.sessionId,
					instanceId: "i-start",
					epoch: "e-start",
					pid: process.pid,
					duplicate: false,
					attachHint: `pi-mobile attach ${String(input.sessionId)}`,
				};
			},
		} as unknown as BridgeLauncher;
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [{ id: "offline-session", path: "/tmp/session.jsonl", cwd: "/tmp", running: false }],
		}) as PiRuntime;
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), {
			hostModeStore: modeStore,
			bridge: new BridgeHub({ root: tempDir("pi-mgw-regression-bridge-") }),
			bridgeLauncher: launcher,
		});
		await client.handleMessage({
			type: "bridge-start",
			sessionId: "offline-session",
			operationId: "start-op",
		});
		assert.equal(frames.at(-1)?.kind, "bridge-started");
		assert.equal(frames.at(-1)?.attachHint, "pi-mobile attach offline-session");
		assert.deepEqual(calls, [
			{
				operationId: "start-op",
				sessionId: "offline-session",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp",
			},
		]);
		client.close();
	});
});

interface ExtensionFixture {
	root: string;
	handlers: Map<string, (...args: unknown[]) => unknown>;
	sendCalls: () => number;
	lastText: () => unknown;
	abortCalls: () => number;
	descriptor: () => NonNullable<ReturnType<BridgeHub["descriptors"]>[number]>;
	context: ExtensionContext;
	currentEditor: () => unknown;
	setEditor: (editor: unknown) => void;
	setIdle: (value: boolean) => void;
	setPending: (value: boolean, draft?: string) => void;
	setAbortThrows: (value: boolean) => void;
	desktopRestoredText: () => string;
	/** 实例化桥接自己的编辑器并装上给定的原生取回动作（模拟"动作已执行"的路径）。 */
	installOwnEditor: (action: () => void) => void;
}

async function startExtension(initialEditor?: unknown): Promise<ExtensionFixture> {
	const root = tempDir("pi-mgw-extension-");
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let sends = 0;
	let text: unknown = "";
	let aborts = 0;
	let idle = true;
	// 模拟 Pi 队列与原生 abortHandler（restoreQueuedMessagesToEditor({abort:true})）：
	// 原生中止会把队列文字拼回电脑当前编辑器，不丢弃。
	let pending = false;
	let queuedDraft = "";
	let abortThrows = false;
	let desktopRestored = "";
	let currentEditor = initialEditor;
	const pi = {
		registerCommand: () => {},
		on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
		sendUserMessage: (content: unknown) => {
			sends += 1;
			text = content;
		},
	} as unknown as ExtensionAPI;
	mobileBridge(pi);
	const context = {
		mode: "tui",
		cwd: root,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		abort: async () => {
			aborts += 1;
			// 模拟中止动作抛错：原生 abortHandler 不会执行，队列不会被拼回电脑。
			if (abortThrows) throw new Error("synthetic-abort-failure");
			if (pending) {
				desktopRestored = queuedDraft;
				queuedDraft = "";
				pending = false;
			}
			await new Promise((resolve) => setTimeout(resolve, 60));
		},
		ui: {
			setEditorComponent: (factory: unknown) => {
				currentEditor = factory;
			},
			getEditorComponent: () => currentEditor,
		},
		sessionManager: {
			getSessionId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			getSessionFile: () => null,
			getLeafId: () => null,
			getEntries: () => [],
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({ reason: "startup" }, context);
	const hub = new BridgeHub({ root });
	const descriptor = hub.descriptors()[0];
	assert.ok(descriptor);
	return {
		root,
		handlers,
		sendCalls: () => sends,
		lastText: () => text,
		abortCalls: () => aborts,
		descriptor: () => descriptor,
		context,
		currentEditor: () => currentEditor,
		setEditor: (editor: unknown) => {
			currentEditor = editor;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean, draft = "queued synthetic text") => {
			pending = value;
			queuedDraft = value ? draft : "";
		},
		setAbortThrows: (value: boolean) => {
			abortThrows = value;
		},
		desktopRestoredText: () => desktopRestored,
		installOwnEditor: (action: () => void) => {
			const factory = currentEditor as
				| ((tui: unknown, theme: unknown, keybindings: unknown) => { actionHandlers: Map<string, () => void> })
				| undefined;
			assert.equal(typeof factory, "function", "桥接必须已安装自己的编辑器工厂");
			const own = (
				factory as (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
				) => {
					actionHandlers: Map<string, () => void>;
				}
			)({}, {}, {});
			own.actionHandlers.set("app.message.dequeue", action);
		},
	};
}

async function stopExtension(fixture: ExtensionFixture): Promise<void> {
	await fixture.handlers.get("session_shutdown")?.({ reason: "exit" });
}

async function waitFor(check: () => boolean, label: string, timeout = 3000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timeout: ${label}`);
}

describe("review regressions: extension IPC", () => {
	it("never forwards an unknown desktop prefix when the editor exposes a suffix representation", async () => {
		const fixture = await startExtension({ name: "suffix-editor" });
		const hub = new BridgeHub({ root: fixture.root });
		let reads = 0;
		Object.assign(fixture.context.ui, { getEditorText: () => (reads++ === 0 ? "tail" : "PRIVATE ORIGINAL\n\ntail") });
		try {
			await hub.send(fixture.descriptor(), {
				operationId: "known-phone-message",
				text: "queued",
				deliverAs: "followUp",
			});
			fixture.setPending(true, "queued");
			const result = await hub.abort(fixture.descriptor(), { operationId: "stop-private", restoreQueued: true });
			assert.equal(result.queuedText, null);
			assert.equal(JSON.stringify(result).includes("PRIVATE ORIGINAL"), false);
			assert.equal(fixture.desktopRestoredText(), "queued");
		} finally {
			await stopExtension(fixture);
		}
	});
	it("does not overwrite or clear another custom editor and reports unavailable", async () => {
		const otherEditor = { name: "other" };
		const fixture = await startExtension(otherEditor);
		const hub = new BridgeHub({ root: fixture.root });
		try {
			assert.equal(fixture.currentEditor(), otherEditor, "启动时已有 custom editor 不能被覆盖");
			assert.equal((await hub.snapshot(fixture.descriptor())).editor, "unavailable");
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-conflict" }),
				(error: unknown) => (error as { code?: string }).code === "editor-unavailable",
			);
			// reload/new/switch 会重跑 session_start；也不能抢回或清掉别人的 editor。
			await fixture.handlers.get("session_start")?.({ reason: "reload" }, fixture.context);
			assert.equal(fixture.currentEditor(), otherEditor);
			const reloaded = new BridgeHub({ root: fixture.root }).descriptors()[0];
			assert.ok(reloaded);
			assert.equal((await hub.snapshot(reloaded)).editor, "unavailable");
		} finally {
			await stopExtension(fixture);
			assert.equal(fixture.currentEditor(), otherEditor, "停止桥接不能清掉后装/其它 editor");
		}
	});

	it("detects a custom editor installed after bridge start and never deques through it", async () => {
		const fixture = await startExtension();
		const hub = new BridgeHub({ root: fixture.root });
		const otherEditor = { name: "later" };
		try {
			fixture.setEditor(otherEditor);
			assert.equal((await hub.snapshot(fixture.descriptor())).editor, "unavailable");
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-later" }),
				(error: unknown) => (error as { code?: string }).code === "editor-unavailable",
			);
			// 停止不再以编辑器归属为条件：没有排队稿时必须完成中止。
			const aborted = await hub.abort(fixture.descriptor(), { operationId: "abort-later", restoreQueued: true });
			assert.equal(aborted.queuedText, null, "取不到队列就不能声称已取回");
			assert.notEqual(aborted.queuedRestoredToDesktop, true, "没有排队稿时不标注电脑端恢复");
			assert.equal(aborted.queuedDisposition, undefined, "没有排队稿时不编造去向");
			assert.equal(fixture.abortCalls(), 1, "无队列也要完成中止");
		} finally {
			await stopExtension(fixture);
			assert.equal(fixture.currentEditor(), otherEditor);
		}
	});

	it("aborts with queued messages by native semantics when another custom editor owns the box", async () => {
		const fixture = await startExtension();
		const hub = new BridgeHub({ root: fixture.root });
		const otherEditor = { name: "later-queued" };
		try {
			fixture.setEditor(otherEditor);
			fixture.setPending(true, "queued while busy");
			const aborted = await hub.abort(fixture.descriptor(), { operationId: "abort-queued", restoreQueued: true });
			assert.equal(aborted.queuedText, null, "不借用别人的 editor 取队列");
			assert.equal(aborted.queuedRestoredToDesktop, true, "队列文字归属电脑当前编辑器要明示");
			assert.equal(aborted.queuedDisposition, "left-on-desktop", "没执行取回动作时必须明说交回电脑");
			assert.equal(fixture.abortCalls(), 1);
			assert.equal(fixture.desktopRestoredText(), "queued while busy", "中止不能丢排队稿");
		} finally {
			await stopExtension(fixture);
			assert.equal(fixture.currentEditor(), otherEditor);
		}
	});

	it("reports the queue outcome honestly when the native dequeue action fails", async () => {
		// 真实 Pi 的坏动作难以复现；这里固定纯判定，保证三条分支互斥且不虚报。
		// 动作抛错且没捕获文字：队列可能已被清空，不能声明"已留在电脑"。
		assert.deepEqual(queueOutcomeOnAbort({ status: "unknown" }, true), {
			restoredToDesktop: false,
			disposition: "unknown",
		});
		// 没执行（其他 custom editor 接管/没有该动作）：我们没动队列，交回电脑。
		assert.deepEqual(queueOutcomeOnAbort({ status: "not-executed" }, true), {
			restoredToDesktop: true,
			disposition: "left-on-desktop",
		});
		// 动作已执行却没拿到文字，而公开计数说队列为空：`hasPendingMessages()` 不含
		// TUI 压缩队列，这个 false 不能证明没有恢复风险，仍必须报"去向未确认"。
		assert.deepEqual(queueOutcomeOnAbort({ status: "unknown" }, false), {
			restoredToDesktop: false,
			disposition: "unknown",
		});
		// 没有任何待消费队列且动作没执行：不标注去向，也不影响基础停止。
		assert.deepEqual(queueOutcomeOnAbort({ status: "not-executed" }, false), { restoredToDesktop: false });
		assert.deepEqual(queueOutcomeOnAbort(null, false), { restoredToDesktop: false });
		assert.deepEqual(queueOutcomeOnAbort(null, true), { restoredToDesktop: true, disposition: "left-on-desktop" });
		// 已捕获（含只捕获到空格）：文字必须交回调用方，不能因抛错丢掉。
		assert.deepEqual(queueOutcomeOnAbort({ status: "captured", text: "queued" }, true), {
			queuedText: "queued",
			restoredToDesktop: false,
			disposition: "captured",
		});
		assert.deepEqual(queueOutcomeOnAbort({ status: "captured", text: "" }, true), {
			queuedText: "",
			restoredToDesktop: false,
			disposition: "captured",
		});
	});

	it("replays a ran-but-unconfirmed dequeue instead of draining the queue again", async () => {
		const fixture = await startExtension();
		const hub = new BridgeHub({ root: fixture.root });
		let actionCalls = 0;
		try {
			fixture.installOwnEditor(() => {
				// 动作执行了但没写进捕获文本：队列可能已被清空，结果不明。
				actionCalls += 1;
				throw new Error("synthetic-dequeue-failure");
			});
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-unknown" }),
				(error: unknown) => (error as { code?: string }).code === "dequeue-unconfirmed",
			);
			assert.equal(actionCalls, 1, "动作执行一次后结果不明");
			// 失败之后用户又往队列里放了新消息：同 operationId 重试必须回放"去向未确认"，
			// 不能把这条新消息也取走（取队列是破坏性操作）。
			fixture.setPending(true, "later queued message");
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-unknown" }),
				(error: unknown) => (error as { code?: string }).code === "dequeue-unconfirmed",
			);
			assert.equal(actionCalls, 1, "同 operationId 重试不得再次执行取回动作");
			// 不同 operationId 才是新动作。
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-new-op" }),
				(error: unknown) => (error as { code?: string }).code === "dequeue-unconfirmed",
			);
			assert.equal(actionCalls, 2, "新 operationId 才允许再执行");
		} finally {
			await stopExtension(fixture);
		}
	});

	it("reports dequeue ran-but-unconfirmed instead of unavailable", () => {
		// 真实 Pi 的"先清队列再抛错"动作难以复现；这里固定码映射，保证
		// "没动队列"与"去向未确认"不会被压成同一个错误码。
		assert.equal(dequeueFailureCode("not-executed"), "editor-unavailable");
		assert.equal(dequeueFailureCode("unknown"), "dequeue-unconfirmed");
	});

	it("downgrades a leftover-on-desktop claim when abort itself fails", async () => {
		const fixture = await startExtension();
		try {
			// 桥接不持有 editor（其他编辑器接管）+ 有队列 ⇒ 取回未执行，正常路径会
			// 报 left-on-desktop；但中止动作抛错时原生 abortHandler 没跑，队列不会
			// 被拼回电脑，失败回执只能报"去向未确认"。
			fixture.setEditor({ name: "foreign-editor" });
			fixture.setPending(true, "queued synthetic text");
			fixture.setAbortThrows(true);
			const hub = new BridgeHub({ root: fixture.root });
			await assert.rejects(
				() => hub.abort(fixture.descriptor(), { operationId: "abort-fails", restoreQueued: true }),
				(error: unknown) => {
					const rejected = error as { code?: string; queuedDisposition?: string; queuedText?: string };
					assert.equal(rejected.code, "submission-failed");
					assert.equal(rejected.queuedDisposition, "unknown");
					assert.equal(rejected.queuedText, undefined, "没捕获到文字时不伪造 queuedText");
					return true;
				},
			);
			assert.equal(fixture.abortCalls(), 1);
			assert.equal(fixture.desktopRestoredText(), "", "中止失败时队列没被拼回电脑");
		} finally {
			await stopExtension(fixture);
		}
	});

	it("keeps reporting editor-unavailable for dequeue while abort still stops", async () => {
		const fixture = await startExtension();
		const hub = new BridgeHub({ root: fixture.root });
		try {
			fixture.setEditor({ name: "later-mixed" });
			await assert.rejects(
				() => hub.dequeue(fixture.descriptor(), { operationId: "dequeue-mixed" }),
				(error: unknown) => (error as { code?: string }).code === "editor-unavailable",
			);
			const aborted = await hub.abort(fixture.descriptor(), { operationId: "abort-mixed", restoreQueued: true });
			assert.equal(aborted.status, "settled");
			assert.equal(fixture.abortCalls(), 1);
		} finally {
			await stopExtension(fixture);
		}
	});

	it("accepts a 900KiB image, preserves split UTF-8, dedupes writes and reports stale/unknown", async () => {
		const fixture = await startExtension();
		const hub = new BridgeHub({ root: fixture.root });
		const descriptor = fixture.descriptor();
		try {
			await hub.send(descriptor, { operationId: "small", text: "synthetic control" });
			assert.equal(fixture.sendCalls(), 1);

			await hub.send(descriptor, {
				operationId: "image",
				text: "",
				images: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(900 * 1024).toString("base64") }],
			});
			assert.equal(fixture.sendCalls(), 2);

			// 同一 operationId/同一载荷只执行一次，重试回放 duplicate=true。
			await hub.send(descriptor, { operationId: "small", text: "synthetic control" });
			assert.equal(fixture.sendCalls(), 2);

			// 中文在 TCP 分块边界被切开时，必须按完整行解码。
			const socket = createConnection(descriptor.socketPath);
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => {});
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			socket.resume();
			const wire = Buffer.from(
				`${JSON.stringify({
					id: "unicode",
					op: "send",
					instanceId: descriptor.instanceId,
					epoch: descriptor.epoch,
					sessionId: descriptor.sessionId,
					operationId: "unicode",
					text: "你好",
				})}\n`,
			);
			const cut = wire.indexOf(Buffer.from("你")) + 1;
			socket.write(wire.subarray(0, cut));
			await new Promise((resolve) => setTimeout(resolve, 30));
			socket.write(wire.subarray(cut));
			await waitFor(() => fixture.lastText() === "你好", "split UTF-8 send");
			socket.destroy();

			assert.equal((await hub.operationStatus(descriptor, "small")).status, "submitted");
			assert.equal((await hub.operationStatus(descriptor, "missing")).status, "unknown");
			await assert.rejects(
				() => hub.send({ ...descriptor, epoch: "stale-epoch" }, { operationId: "stale", text: "x" }),
				(error: unknown) => (error as { code?: string }).code === "stale-runtime",
			);
			await assert.rejects(
				() => hub.send(descriptor, { operationId: "huge", text: "x".repeat(24 * 1024 * 1024) }),
				(error: unknown) => (error as { code?: string }).code === "frame-too-large",
			);
			// 超限只拒绝这一条，不把实例误判为离线。
			assert.equal((await hub.snapshot(descriptor)).busy, false);

			// abort 阻塞在 settle 时，同 operationId 的第二个请求只能回放“处理中”。
			// 让 isIdle 保持 false，才能真正进入 waitForSettle 的等待窗口。
			fixture.setIdle(false);
			const first = hub.abort(descriptor, { operationId: "abort-1" });
			await waitFor(() => fixture.abortCalls() === 1, "abort entered");
			const second = await hub.abort(descriptor, { operationId: "abort-1" });
			assert.equal(fixture.abortCalls(), 1);
			assert.equal(second.status, "submitted");
			assert.equal(second.duplicate, true);
			fixture.setIdle(true);
			fixture.handlers.get("agent_settled")?.({ type: "agent_settled" });
			assert.equal((await first).status, "settled");
			assert.equal(fixture.abortCalls(), 1);
		} finally {
			await stopExtension(fixture);
		}
	});
});

describe("foreign editor queue prefix privacy", () => {
	it("bounds expanded text and candidate work before matching", () => {
		const huge = "x".repeat(1_048_577);
		assert.equal(restoredQueuePrefix("", huge, [huge]), null);
		assert.equal(restoredQueuePrefix(huge, `queued\n\n${huge}`, ["queued"]), null);
		let reads = 0;
		function* many() {
			while (true) {
				reads += 1;
				yield "not queued";
			}
		}
		assert.equal(restoredQueuePrefix("", "queued", many()), null);
		assert.equal(reads, 257, "不能遍历无界候选集");
	});
	it("does not transmit a desktop draft prefix when expanded text returns only a suffix", () => {
		assert.equal(restoredQueuePrefix("tail", "PRIVATE ORIGINAL\n\ntail", ["queued"]), null);
	});
	it("copies only the exact native queue prefix and never the desktop draft", () => {
		assert.equal(
			restoredQueuePrefix("desktop draft", "steer\n\nfollow-up\n\ndesktop draft", ["steer", "follow-up"]),
			"steer\n\nfollow-up",
		);
		assert.equal(restoredQueuePrefix("", "queued text", ["queued text"]), "queued text");
		assert.equal(restoredQueuePrefix("   ", "queued text", ["queued text"]), "queued text");
		assert.equal(restoredQueuePrefix("same", "same\n\nsame", ["same"]), "same");
	});
	it("refuses unchanged or rewritten editor text instead of leaking the original draft", () => {
		assert.equal(restoredQueuePrefix("desktop draft", "desktop draft"), null);
		assert.equal(restoredQueuePrefix("desktop draft", "rewritten desktop draft"), null);
		assert.equal(restoredQueuePrefix("desktop draft", "queued\n\nexpanded draft"), null);
		assert.equal(restoredQueuePrefix("desktop draft", "\n\ndesktop draft"), null);
	});
});
