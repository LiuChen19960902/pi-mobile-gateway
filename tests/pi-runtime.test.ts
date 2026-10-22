import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { HistoryCursorError } from "../src/history-turns.ts";
import { DirectoryError } from "../src/host-fs.ts";
// pi runtime 测试主要使用 fake 会话；真实工厂回归单独在临时配置子进程中执行。
// 所有会话与配置均隔离，不调用真实模型，不读取用户 ~/.pi，不发网络请求。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type AgentSessionEvent,
	type ModelRuntime,
	resolveModelScopeWithDiagnostics,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	AttachmentInvalidError,
	AttachmentNotFoundError,
	AttachmentTooLargeError,
	EntryNotFoundError,
	ModelChangeError,
	type ModelRegistryLike,
	PiRuntime,
	type PiSessionLike,
	SessionNotFoundError,
	selectInitialScopedModel,
	validateCwd,
} from "../src/pi-runtime.ts";
import { ATTACHMENT_MAX_RAW_BYTES } from "../src/wire.ts";

const dirs: string[] = [];
const runtimes: PiRuntime[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** 出站事件改为微任务 FIFO 后，测试里 emit 后需等一次 flush 再断言。 */
async function flushEvents(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

after(async () => {
	for (const runtime of runtimes) runtime.disposeAll();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("真实会话工厂的配置新鲜度", () => {
	it("新会话按外部更新后的 enabledModels 和默认模型选择", () => {
		const root = tempDir("pi-mgw-real-factory-");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		const models = ["model-a", "model-b"].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 256,
		}));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"audit-test": {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test-placeholder",
						models,
					},
				},
			}),
		);
		const runtimeModule = new URL("../src/pi-runtime.ts", import.meta.url).href;
		const script = `
			import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			import { PiRuntime } from ${JSON.stringify(runtimeModule)};
			globalThis.fetch = async () => { throw new Error('本测试禁止网络请求'); };
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			const update = id => writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
				enabledModels: ['audit-test/' + id], defaultProvider: 'audit-test', defaultModel: id
			}));
			update('model-a');
			const runtime = new PiRuntime({ agentDir, sessionDir: join(agentDir, 'sessions') });
			try {
				const first = await runtime.createSession(process.cwd());
				update('model-b');
				const second = await runtime.createSession(process.cwd());
				console.log(JSON.stringify([first.session.model?.id, second.session.model?.id]));
			} finally { runtime.disposeAll(); }
		`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.deepEqual(JSON.parse(output), ["model-a", "model-b"]);
	});

	it("不同 Provider 同名模型在真实 SDK 范围与新会话初始化中保持一致", () => {
		const root = tempDir("pi-mgw-real-case-scope-");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		const provider = {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "test-placeholder",
			models: [{ id: "chat", api: "openai-completions", reasoning: false, input: ["text"] }],
		};
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "relay-a": provider, "relay-b": provider } }),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["relay-b/chat"] }));
		const runtimeModule = new URL("../src/pi-runtime.ts", import.meta.url).href;
		const script = `
			import assert from 'node:assert/strict';
			import { join } from 'node:path';
			import { PiRuntime } from ${JSON.stringify(runtimeModule)};
			globalThis.fetch = async () => { throw new Error('本测试禁止网络请求'); };
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			const runtime = new PiRuntime({ agentDir, sessionDir: join(agentDir, 'sessions') });
			try {
				const scope = await runtime.modelScope();
				assert.deepEqual(scope.selected.map(m => m.provider), ['relay-b']);
				assert.deepEqual((await runtime.listModels()).map(g => g.provider), ['relay-b']);
				const first = await runtime.createSession(process.cwd());
				assert.equal(first.session.model?.provider, 'relay-b');
				const saved = await runtime.saveModelScope(scope.patterns, [{provider:'relay-a',modelId:'chat'}], false, false);
				assert.deepEqual(saved.selected.map(m => m.provider), ['relay-a']);
				assert.equal(first.session.model?.provider, 'relay-b');
				const second = await runtime.createSession(process.cwd());
				console.log(JSON.stringify([first.session.model?.provider, second.session.model?.provider]));
			} finally { runtime.disposeAll(); }
		`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.deepEqual(JSON.parse(output), ["relay-b", "relay-a"]);
	});
});

/** A scripted fake AgentSession implementing PiSessionLike. */
class FakeSession implements PiSessionLike {
	sessionId: string;
	sessionFile: string | undefined;
	isStreaming = false;
	isCompacting = false;
	model: { id: string; provider: string } | undefined = { id: "m1", provider: "p1" };
	thinkingLevel = "medium";
	disposed = false;
	aborted = false;
	promptCalls: Array<{ text: string; mode?: string }> = [];
	modelSetCalls: Array<{ model: unknown; persist?: boolean }> = [];
	scopeSetCalls: unknown[][] = [];
	setScopedModels(models: unknown[]): void {
		this.scopeSetCalls.push(models);
	}
	thinkingLevelCalls: string[] = [];
	/** When set, unsupported levels are clamped (mirrors pi `setThinkingLevel`). */
	allowedThinkingLevels: string[] | undefined;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	/** Scripted setModel behavior; defaults to accept and adopt the model. */
	onSetModel: (session: FakeSession, model: unknown) => Promise<void> = async (session, model) => {
		const record = model as { id?: string; provider?: string } | undefined;
		session.model = { id: String(record?.id), provider: String(record?.provider) };
	};
	/** Scripted prompt behavior; defaults to accept + finish immediately. */
	onPrompt: (
		session: FakeSession,
		text: string,
		options: { streamingBehavior?: string; preflightResult?: PromptOptions["preflightResult"] },
	) => Promise<void> = async (_session, _text, options) => {
		options.preflightResult?.("started");
	};

	constructor(sessionManager: SessionManager) {
		this.sessionId = sessionManager.getSessionId();
		this.sessionFile = sessionManager.getSessionFile();
		// 保留真实 SessionManager：身份匹配测试需要能模拟 pi 的 appendMessage。
		this.manager = sessionManager;
	}

	/** 真实 SessionManager（与 pi 同一实例），仅身份测试用。 */
	private readonly manager: SessionManager;
	/** emitMessageEndThenAppend 模拟 pi 追加的条目 id，供断言对齐。 */
	appendedEntryIds: string[] = [];

	/** 与 pi AgentSession 同序：先 emit message_end，再同步 appendMessage。
	 * 网关应在微任务 flush 时按原 message 引用匹配到刚持久化条目的 id。 */
	emitMessageEndThenAppend(message: { role: string; content: unknown }): void {
		this.emit({ type: "message_end", message } as AgentSessionEvent);
		this.appendedEntryIds.push(this.manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]));
	}

	/** 只 emit 不 append（模拟 pi 尚未/不再持久化）：身份必须缺席。 */
	emitMessageEndOnly(message: { role: string; content: unknown }): void {
		this.emit({ type: "message_end", message } as AgentSessionEvent);
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	prompt(
		text: string,
		options?: { streamingBehavior?: "steer" | "followUp"; preflightResult?: PromptOptions["preflightResult"] },
	): Promise<void> {
		this.promptCalls.push({ text, mode: options?.streamingBehavior });
		return this.onPrompt(this, text, options ?? {});
	}

	abort(): Promise<void> {
		this.aborted = true;
		this.isStreaming = false;
		return Promise.resolve();
	}

	setModel(model: unknown, options?: { persist?: boolean }): Promise<void> {
		this.modelSetCalls.push({ model, persist: options?.persist });
		return this.onSetModel(this, model);
	}

	setThinkingLevel(level: string): void {
		this.thinkingLevelCalls.push(level);
		this.thinkingLevel = this.allowedThinkingLevels?.includes(level)
			? level
			: (this.allowedThinkingLevels?.[0] ?? level);
	}

	steeringMessages: string[] = ["queued-steer"];
	followUpMessages: string[] = [];
	getSteeringMessages(): readonly string[] {
		return this.steeringMessages;
	}
	getFollowUpMessages(): readonly string[] {
		return this.followUpMessages;
	}
	clearQueue(): { steering: string[]; followUp: string[] } {
		const removed = { steering: this.steeringMessages, followUp: this.followUpMessages };
		this.steeringMessages = [];
		this.followUpMessages = [];
		this.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
		return removed;
	}

	setSessionName(name: string): void {
		this.sessionNameCalls.push(name);
	}
	sessionNameCalls: string[] = [];

	compactCalls: Array<string | undefined> = [];
	compact(_customInstructions?: string): Promise<unknown> {
		this.compactCalls.push(_customInstructions);
		return Promise.resolve({});
	}

	/** Scripted navigateTree behavior; defaults to switching with no editor text. */
	onNavigateTree: (session: FakeSession, targetId: string) => Promise<{ editorText?: string; cancelled?: boolean }> =
		async (_session, _targetId) => ({});
	navigateTreeCalls: Array<{ targetId: string; options?: { summarize?: boolean } }> = [];
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string },
	): Promise<{ editorText?: string; cancelled?: boolean }> {
		this.navigateTreeCalls.push({ targetId, options });
		return this.onNavigateTree(this, targetId);
	}

	/** Scripted current leaf id (pi `getLeafId`). */
	leafId: string | null = null;
	getLeafId(): string | null {
		return this.leafId;
	}

	getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } {
		return { percent: 42, contextWindow: 100_000, tokens: 42_000 };
	}

	/** Test hook: delayed/scripted extension binding (initialization race tests). */
	bindings: Record<string, unknown> | undefined;
	onBind: ((bindings: Record<string, unknown>) => Promise<void> | void) | undefined;
	bindExtensions(bindings: Record<string, unknown>): Promise<void> {
		this.bindings = bindings;
		return Promise.resolve(this.onBind?.(bindings));
	}

	dispose(): void {
		this.disposed = true;
	}
}

/** Build a runtime whose sessions are all scripted fakes. */
function fakeRuntime(
	options: Partial<ConstructorParameters<typeof PiRuntime>[0]> = {},
	configureSession?: (session: FakeSession) => void,
): {
	runtime: PiRuntime;
	sessions: Map<string, FakeSession>;
} {
	const sessions = new Map<string, FakeSession>();
	const runtime = new PiRuntime({
		...options,
		sessionDir: options.sessionDir ?? tempDir("pi-mgw-sessions-"),
		// 默认不过滤：真实用户目录的 settings 绝不进入测试判定。
		enabledModelsLoader: options.enabledModelsLoader ?? (() => undefined),
		sessionFactory: async ({ sessionManager }) => {
			const session = new FakeSession(sessionManager);
			configureSession?.(session);
			sessions.set(session.sessionId, session);
			return session;
		},
	});
	runtimes.push(runtime);
	return { runtime, sessions };
}

/** Look up a fake session, failing the test if it was never created. */
function expectSession(sessions: Map<string, FakeSession>, sessionId: string): FakeSession {
	const session = sessions.get(sessionId);
	if (!session) throw new Error(`fake session not created: ${sessionId}`);
	return session;
}

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function writeFixtureSession(sessionDir: string): { path: string; cwd: string } {
	const cwd = "/tmp/fake-project";
	// SessionManager.listAll(dir) scans .jsonl files directly inside dir, so
	// the fixture goes straight into the (project-level) sessions dir.
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "model_change", id: "e0", parentId: null, provider: "fp", modelId: "fm" }),
		JSON.stringify({ type: "thinking_level_change", id: "e1", parentId: "e0", thinkingLevel: "low" }),
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			message: { role: "user", content: "hello" },
		}),
		JSON.stringify({
			type: "message",
			id: "e3",
			parentId: "e2",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "e4",
			parentId: "e3",
			message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "data" }] },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return { path, cwd };
}

/**
 * 线性活跃链 fixture：`metadataCount` 条不渲染为 wire message 的元数据条目
 * （model_change / thinking_level_change，entryToWireMessage 一律返回 null），
 * 放在最新尾部（tail）、两条用户消息之间（middle），或整条链只有元数据（none）。
 */
function writeMetadataChainSession(sessionDir: string, metadataCount: number, where: "tail" | "middle" | "none"): void {
	const cwd = "/tmp/fake-project";
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
	];
	let parentId: string | null = null;
	const push = (entry: Record<string, unknown>) => {
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id as string;
	};
	const user = (id: string, text: string) => push({ type: "message", id, message: { role: "user", content: text } });
	if (where !== "none") user("old-msg", "earliest user message");
	for (let index = 0; index < metadataCount; index++) {
		if (index % 2 === 0) push({ type: "model_change", id: `md${index}`, provider: "fp", modelId: "fm" });
		else push({ type: "thinking_level_change", id: `md${index}`, thinkingLevel: "low" });
	}
	if (where === "middle") user("new-msg", "newest user message");
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selectInitialScopedModel", () => {
	const scope = [
		{ model: { provider: "relayD", id: "k3" } },
		{ model: { provider: "relayB", id: "example-model" } },
		{ model: { provider: "relayB", id: "example-model-flash" } },
	];
	const resolveScope = async () => scope;

	it("prefers the settings default when it is inside the enabledModels scope", async () => {
		const result = await selectInitialScopedModel(false, ["relayD/*", "relayB/*"], resolveScope, {
			provider: "relayB",
			id: "example-model-flash",
		});
		assert.equal(result.entry?.model.provider, "relayB");
		assert.equal(result.entry?.model.id, "example-model-flash");
		assert.equal(result.scopedModels.length, 3);
	});

	it("falls back to the first scoped model when the default is outside the scope", async () => {
		const result = await selectInitialScopedModel(false, ["relayB/*"], resolveScope, {
			provider: "relayC",
			id: "model-b-flash",
		});
		assert.equal(result.entry?.model.id, "k3");
	});

	it("agentDir injection structurally isolates settings writes from the real user config", async () => {
		// 对标 pi 的测试隔离方式（fixture 重定向 agent 目录）：注入临时 agentDir
		// 后，即使不注入 appender/remover（走真实 SettingsManager.setEnabledModels
		// 写盘），写的也是临时目录——从根上消灭"测试漏注入 writer 污染真实
		// settings.json"这类事故。
		const agentDir = tempDir("pi-mgw-agentdir-");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["p1/m1"] }));
		// loader 显式读临时 agentDir（等价真实读取）；appender/remover 不注入——
		// admit 走真实 SettingsManager.setEnabledModels 写盘，靠 agentDir 隔离，
		// 旧实现这里会写真实 ~/.pi/agent/settings.json。
		const { runtime } = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			agentDir,
			enabledModelsLoader: () => {
				try {
					return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).enabledModels ?? undefined;
				} catch {
					return undefined;
				}
			},
		});
		assert.equal(await runtime.admitEnabledModel("p9"), true);
		// SettingsManager 的写是 enqueueWrite 异步队列，flush（pi 公开 API）后断言。
		await runtime.flushSettingsWrites();
		const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		assert.deepEqual(written.enabledModels, ["p1/m1", "p9/*"]);
		// 上面的断言要求写回注入目录；不读真实用户配置，首次安装也能运行此用例。
	});

	it("keeps the pattern's thinkingLevel suffix on the selected entry", async () => {
		// pi resolveModelScope 把 "provider/id:level" 的 :level 解析进 entry；
		// createRealSession 再把它透传给 createAgentSession（对齐 CLI）。
		const scoped = await selectInitialScopedModel(
			false,
			["relayB/example-model-flash:high"],
			async () => [{ model: { provider: "relayB", id: "example-model-flash" }, thinkingLevel: "high" }],
			{ provider: "relayB", id: "example-model-flash" },
		);
		assert.equal(scoped.entry?.thinkingLevel, "high");
	});

	it("restores scope on resume without replacing the recorded model", async () => {
		assert.deepEqual(
			await selectInitialScopedModel(false, undefined, resolveScope, { provider: "relayB", id: "example-model-flash" }),
			{ entry: undefined, scopedModels: [] },
		);
		assert.deepEqual(await selectInitialScopedModel(false, [], resolveScope, undefined), {
			entry: undefined,
			scopedModels: [],
		});
		// 已有会话由 pi 的会话记录恢复模型，不干预。
		assert.deepEqual(
			await selectInitialScopedModel(true, ["relayB/*"], resolveScope, { provider: "relayB", id: "example-model" }),
			{ entry: undefined, scopedModels: await resolveScope() },
		);
	});
});

describe("history index work", () => {
	it("concurrent index readers share one scan", async (t) => {
		let scans = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.mock.method(SessionManager, "listAll", async () => {
			scans++;
			await gate;
			return [];
		});
		const { runtime } = fakeRuntime({ sessionDir: tempDir("pi-mgw-index-") });
		const reads = [runtime.listSessions(), runtime.listSessions(), runtime.listSessions()];
		assert.equal(scans, 1);
		release();
		await Promise.all(reads);
		assert.equal(scans, 1);
	});

	it("opening a previously listed history path skips an expired full index scan", async (t) => {
		const sessionDir = tempDir("pi-mgw-index-");
		const path = join(sessionDir, "session.jsonl");
		writeFileSync(
			path,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "history-known",
				timestamp: "2026-10-08T00:00:00Z",
				cwd: sessionDir,
			}) + "\n",
		);
		const infos = await SessionManager.listAll(sessionDir);
		assert.equal(infos.length, 1);
		let scans = 0;
		let visible = infos;
		t.mock.method(SessionManager, "listAll", async () => {
			scans++;
			return visible;
		});
		const runtime = new PiRuntime({
			sessionDir,
			indexTtlMs: 0,
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => [],
		});
		runtimes.push(runtime);
		await runtime.listSessions();
		await runtime.history("history-known", undefined, 60, false, 10);
		await runtime.history("history-known", undefined, 60, false, 10);
		assert.equal(scans, 1, "history path reuse must not re-scan unrelated sessions");
		rmSync(path);
		visible = [];
		await assert.rejects(runtime.history("history-known", undefined, 60, false, 10), SessionNotFoundError);
		assert.equal(scans, 2, "deleted cached paths trigger a fresh lookup");
	});
});

describe("history cached path identity", () => {
	it("does not reuse a file whose session header was replaced with another id", async () => {
		const sessionDir = tempDir("pi-mgw-path-identity-");
		const { path } = writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.listSessions();
		await runtime.history(SESSION_ID, undefined, 60, false, 10);
		const replacement = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		writeFileSync(path, readFileSync(path, "utf8").replace(SESSION_ID, replacement) + "\n");
		await assert.rejects(runtime.history(SESSION_ID, undefined, 60, false, 10), SessionNotFoundError);
		const current = await runtime.history(replacement, undefined, 60, false, 10);
		assert.equal(current.state.sessionId, replacement);
	});
});

describe("history lookup recovery", () => {
	it("rescans after a cached session header read throws", async (t) => {
		const sessionDir = tempDir("pi-mgw-header-recovery-");
		const { path } = writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir, indexTtlMs: 0 });
		await runtime.listSessions();
		await runtime.history(SESSION_ID, undefined, 60, false, 10);
		const cached = (runtime as unknown as { openSessionManager(path: string): SessionManager }).openSessionManager(
			path,
		);
		t.mock.method(cached, "getSessionId", () => {
			throw new Error("transient cached header read failure");
		});
		const page = await runtime.history(SESSION_ID, undefined, 60, false, 10);
		assert.equal(page.state.sessionId, SESSION_ID);
		assert.match(JSON.stringify(page.messages), /hello/);
	});

	it("drops a missing path projection before a same-stat replacement is opened", async () => {
		const sessionDir = tempDir("pi-mgw-recreated-path-");
		const { path } = writeFixtureSession(sessionDir);
		const fixedTime = new Date("2026-01-01T00:00:00.000Z");
		utimesSync(path, fixedTime, fixedTime);
		const original = readFileSync(path, "utf8");
		const previous = statSync(path);
		const { runtime } = fakeRuntime({ sessionDir, indexTtlMs: 0 });
		await runtime.listSessions();
		await runtime.history(SESSION_ID, undefined, 60, false, 10);
		rmSync(path);
		await assert.rejects(runtime.history(SESSION_ID, undefined, 60, false, 10), SessionNotFoundError);
		const replacement = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		writeFileSync(path, original.replace(SESSION_ID, replacement).replace("hello", "newer"));
		utimesSync(path, fixedTime, fixedTime);
		assert.equal(statSync(path).size, previous.size);
		assert.equal(statSync(path).mtimeMs, previous.mtimeMs);
		const page = await runtime.history(replacement, undefined, 60, false, 10);
		assert.match(JSON.stringify(page.messages), /newer/);
		assert.doesNotMatch(JSON.stringify(page.messages), /hello/);
	});

	it("rechecks a freshly scanned path and retries only once after deletion", async (t) => {
		const sessionDir = tempDir("pi-mgw-scan-delete-");
		const { path } = writeFixtureSession(sessionDir);
		const listAll = SessionManager.listAll.bind(SessionManager);
		let scans = 0;
		t.mock.method(SessionManager, "listAll", async () => {
			const infos = await listAll(sessionDir);
			if (++scans === 1) rmSync(path);
			return infos;
		});
		const { runtime } = fakeRuntime({ sessionDir });
		await assert.rejects(runtime.history(SESSION_ID, undefined, 60, false, 10), SessionNotFoundError);
		assert.equal(scans, 2);
	});
});

describe("validateCwd", () => {
	it("accepts existing directories and rejects everything else", () => {
		const dir = tempDir("pi-mgw-cwd-");
		assert.equal(validateCwd(dir), dir);
		const file = join(dir, "f.txt");
		writeFileSync(file, "x");
		assert.throws(
			() => validateCwd("relative/path"),
			(e: unknown) => e instanceof DirectoryError && e.code === "bad-request",
		);
		assert.throws(
			() => validateCwd(join(dir, "missing")),
			(e: unknown) => e instanceof DirectoryError && e.code === "directory-not-found",
		);
		assert.throws(
			() => validateCwd(file),
			(e: unknown) => e instanceof DirectoryError && e.code === "directory-not-directory",
		);
	});
});

describe("PiRuntime: session index", () => {
	it("lists sessions from the sessions directory with running flags", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		const items = await runtime.listSessions();
		assert.equal(items.length, 1);
		assert.equal(items[0].id, SESSION_ID);
		assert.equal(items[0].cwd, "/tmp/fake-project");
		assert.equal(items[0].messageCount, 3);
		assert.equal(items[0].running, false);
	});

	it("openSession/state wait for extension binding before exposing the handle", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		let releaseBind!: () => void;
		let bindCalls = 0;
		const { runtime, sessions } = fakeRuntime({ sessionDir }, (session) => {
			session.onBind = () => {
				bindCalls += 1;
				return new Promise<void>((resolve) => {
					releaseBind = resolve;
				});
			};
		});

		const first = runtime.openSession(SESSION_ID);
		while (!sessions.has(SESSION_ID)) await new Promise((resolve) => setTimeout(resolve, 1));
		let secondResolved = false;
		const second = runtime.openSession(SESSION_ID).then((handle) => {
			secondResolved = true;
			return handle;
		});
		let stateResolved = false;
		const state = runtime.state(SESSION_ID).then((value) => {
			stateResolved = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(secondResolved, false, "并发 openSession 必须等扩展绑定完成");
		assert.equal(stateResolved, false, "state 必须等扩展绑定完成");

		releaseBind();
		const [left, right, stateValue] = await Promise.all([first, second, state]);
		assert.equal(left.session, right.session);
		assert.equal(bindCalls, 1);
		assert.equal(stateValue.sessionId, SESSION_ID);
	});

	it("serializes concurrent restarts instead of failing with session-not-found", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const [left, right] = await Promise.all([runtime.restartSession(SESSION_ID), runtime.restartSession(SESSION_ID)]);
		assert.equal(left.sessionId, SESSION_ID);
		assert.equal(right.sessionId, SESSION_ID);
		await runtime.state(SESSION_ID);
	});

	it("首条即纯图（占位空格正文）的会话不会显示为空预览", async () => {
		// 纯图消息由网关注入 " "（见 PROTOCOL §4.2），pi 的 extractTextContent
		// 不 trim，若原样透传会让会话列表出现空白预览。
		const sessionDir = tempDir("pi-mgw-sessions-");
		const id = "01a0aa11-2233-4455-6677-8899aabbccdd";
		writeFileSync(
			join(sessionDir, `2026-01-02T00-00-00-000Z_${id}.jsonl`),
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id,
					timestamp: "2026-01-02T00:00:00.000Z",
					cwd: "/tmp/fake-project",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					message: {
						role: "user",
						content: [
							{ type: "text", text: " " },
							{ type: "image", data: "aGk=", mimeType: "image/png" },
						],
					},
				}),
			].join("\n")}\n`,
		);
		const { runtime } = fakeRuntime({ sessionDir });
		const items = await runtime.listSessions();
		assert.equal(items.length, 1);
		assert.equal(items[0].firstMessage, "(no messages)");
	});

	it("marks sessions with a streaming handle as running", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		expectSession(sessions, SESSION_ID).isStreaming = true;
		const items = await runtime.listSessions();
		assert.equal(items[0].running, true);
	});
});

describe("PiRuntime: subscribe and event forwarding", () => {
	it("forwards projected events to subscribers with per-session seq", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const frames: Array<Record<string, unknown>> = [];
		const detach = handle.attach((frame) => frames.push(frame));
		const session = expectSession(sessions, SESSION_ID);

		session.emit({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
		session.emit({ type: "turn_start" } as AgentSessionEvent);
		session.emit({ type: "message_end", message: { role: "assistant" } } as AgentSessionEvent);
		await flushEvents();

		assert.equal(frames.length, 2);
		assert.equal(frames[0].kind, "event");
		assert.equal(frames[0].sessionId, SESSION_ID);
		assert.equal(frames[0].seq, 1);
		assert.equal(frames[1].seq, 2);
		assert.equal(typeof frames[0].time, "number");

		detach();
		session.emit({ type: "message_end" } as AgentSessionEvent);
		await flushEvents();
		assert.equal(frames.length, 2);
	});

	it("throws SessionNotFoundError for unknown ids", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { runtime } = fakeRuntime({ sessionDir });
		await assert.rejects(() => runtime.openSession("nope"), SessionNotFoundError);
	});
});

describe("PiRuntime: prompt admission", () => {
	for (const disposition of ["started", "queued", "handled"] as const) {
		it(`Pi 1.0 ${disposition} acknowledges before run completion`, async () => {
			const sessionDir = tempDir("pi-mgw-preflight-1-0-");
			writeFixtureSession(sessionDir);
			const { runtime, sessions } = fakeRuntime({ sessionDir });
			const handle = await runtime.openSession(SESSION_ID);
			const session = expectSession(sessions, SESSION_ID);
			let finishRun!: () => void;
			session.onPrompt = async (_s, _t, options) => {
				options.preflightResult?.(disposition);
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			};
			let admitted = false;
			const pending = runtime.prompt(handle, "hello", "prompt").then((acceptance) => {
				assert.equal(acceptance.disposition, disposition);
				admitted = true;
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(admitted, true);
			finishRun();
			await pending;
		});
	}

	it("resolves when preflight accepts, while the run keeps streaming", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		let finishRun!: () => void;
		session.onPrompt = async (_s, _t, options) => {
			options.preflightResult?.("started");
			session.isStreaming = true;
			await new Promise<void>((resolve) => {
				finishRun = resolve;
			});
			session.isStreaming = false;
		};
		let admitted = false;
		const promise = runtime.prompt(handle, "hello", "prompt").then(() => {
			admitted = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(admitted, true, "prompt must resolve on admission, not completion");
		assert.equal(session.isStreaming, true);
		finishRun();
		await promise;
		assert.equal(session.isStreaming, false);
	});

	it("纯图消息注入空格占位，避免上游拒绝空 text block", async () => {
		// pi 的 prompt(text, {images}) 无条件生成 text block，空 text 会被 OpenAI
		// 兼容上游拒绝（400 messages 参数非法）；带文字时原样透传，不多余改动。
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		const seen: Array<{ text: string; images: number }> = [];
		session.onPrompt = async (_s, text, options) => {
			seen.push({ text, images: (options as { images?: unknown[] }).images?.length ?? 0 });
		};
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
		await runtime.prompt(handle, "", "prompt", [image]);
		await runtime.prompt(handle, "   ", "prompt", [image]);
		await runtime.prompt(handle, "看这张图", "prompt", [image]);
		await runtime.prompt(handle, "", "prompt", []);
		assert.deepEqual(seen, [
			{ text: " ", images: 1 },
			{ text: " ", images: 1 },
			{ text: "看这张图", images: 1 },
			{ text: "", images: 0 },
		]);
	});

	it("rejects when the prompt throws before acceptance", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.onPrompt = async () => {
			throw new Error("no model selected");
		};
		await assert.rejects(() => runtime.prompt(handle, "hello", "prompt"), /no model selected/);
	});

	it("serializes admission so a second prompt sees the first's queue mode", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.onPrompt = async (_s, _t, options) => {
			await new Promise((resolve) => setImmediate(resolve));
			options.preflightResult?.("started");
			session.isStreaming = true;
		};
		await runtime.prompt(handle, "first", "prompt");
		const second = runtime.prompt(handle, "second", "followUp");
		await second;
		assert.deepEqual(
			session.promptCalls.map((call) => call.mode),
			[undefined, "followUp"],
		);
	});
});

describe("PiRuntime: dequeue without interrupting", () => {
	it("restores the current queues only, in lane order, with a synchronous result callback", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.isStreaming = true;
		session.steeringMessages = ["steer"];
		session.followUpMessages = ["follow-up", "follow-up"];
		let callbackRan = false;
		const result = await runtime.dequeue(SESSION_ID, (queued, state) => {
			callbackRan = true;
			assert.deepEqual(queued, ["steer", "follow-up", "follow-up"]);
			assert.equal(state.isStreaming, true);
			assert.deepEqual(session.getFollowUpMessages(), []);
		});
		assert.equal(callbackRan, true);
		assert.deepEqual(result.state.queuedMessages, { steering: [], followUp: [] });
		assert.equal(session.aborted, false);
		assert.equal(session.isStreaming, true);
		assert.equal(session.promptCalls.length, 0);
		assert.deepEqual((await runtime.dequeue(SESSION_ID)).queued, []);
	});

	it("waits for in-flight prompt admission; missing handles stay unloaded", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		assert.deepEqual((await runtime.dequeue(SESSION_ID)).queued, []);
		assert.equal(sessions.size, 0);
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.steeringMessages = [];
		let admit!: () => void;
		session.onPrompt = async (_s, text, options) => {
			await new Promise<void>((resolve) => {
				admit = resolve;
			});
			session.followUpMessages.push(text);
			options.preflightResult?.("queued");
		};
		const prompt = runtime.prompt(handle, "awaiting admission", "followUp");
		await new Promise((resolve) => setImmediate(resolve));
		let callbackRan = false;
		const recall = runtime.dequeue(SESSION_ID, () => {
			callbackRan = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(callbackRan, false);
		admit();
		await prompt;
		assert.deepEqual((await recall).queued, ["awaiting admission"]);
		assert.equal(session.aborted, false);
	});
});

describe("PiRuntime: history and state", () => {
	it("pages the active branch with entry-id cursors", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		const page1 = await runtime.history(SESSION_ID, undefined, 2);
		// Newest two displayed entries: toolResult (e4) and assistant (e3).
		assert.deepEqual(page1.entryIds, ["e3", "e4"]);
		assert.equal(page1.hasMore, true);
		assert.equal(page1.oldestEntryId, "e3");
		assert.deepEqual(page1.state.model, { provider: "fp", modelId: "fm" });
		assert.equal(page1.state.thinkingLevel, "low");
		assert.equal(page1.state.isStreaming, false);
		// toolCall blocks are normalized to the live display shape.
		const assistant = page1.messages[0] as { content: Array<Record<string, unknown>> };
		assert.equal(assistant.content[1].toolCallId, "c1");
		assert.equal(assistant.content[1].toolName, "read");

		const page2 = await runtime.history(SESSION_ID, page1.oldestEntryId, 10);
		assert.deepEqual(page2.entryIds, ["e2"]);
		assert.equal(page2.hasMore, false);
	});

	it("首轮模拟磁盘不可见时冷启动和 resetLeaf 补拉恢复用户消息，恢复落盘后不重复", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.createSession("/tmp/fake-project");
		const sessionId = handle.session.sessionId;
		const session = expectSession(sessions, sessionId);
		const liveHandle = (
			runtime as unknown as {
				handles: Map<string, { sessionManager: SessionManager }>;
			}
		).handles.get(sessionId);
		assert.ok(liveHandle);
		const entryId = liveHandle.sessionManager.appendMessage({
			role: "user",
			content: "首轮回复中的用户消息",
		} as Parameters<SessionManager["appendMessage"]>[0]);
		session.isStreaming = true;
		const sessionFile = session.sessionFile;
		assert.ok(sessionFile);
		// Pi 1.0会在首条user时落盘；主动模拟磁盘不可见窗口，仍核验live只读兜底。
		assert.equal(existsSync(sessionFile), true, "Pi 1.0首条user已落盘");
		const persistedUser = readFileSync(sessionFile);
		rmSync(sessionFile);
		assert.equal(existsSync(sessionFile), false);

		for (const resetLeaf of [false, true]) {
			const page = await runtime.history(sessionId, undefined, 10, resetLeaf);
			assert.deepEqual(page.entryIds, [entryId]);
			assert.equal(page.messages[0].role, "user");
			assert.equal(page.messages[0].content, "首轮回复中的用户消息");
			assert.equal(page.state.isStreaming, true);
			assert.equal(page.latestEntryId, entryId, "并入 live 尾时最新以活跃链尾为准");
			assert.equal(page.hasMore, false);
		}
		assert.equal(existsSync(sessionFile), false, "只读恢复不改变 Pi 的落盘时机");
		assert.equal(session.navigateTreeCalls.length, 0, "空文件不触发导航、中止或重发");

		writeFileSync(sessionFile, persistedUser);
		session.emitMessageEndThenAppend({ role: "assistant", content: [{ type: "text", text: "完成" }] });
		session.isStreaming = false;
		await flushEvents();
		assert.equal(existsSync(sessionFile), true);
		const completed = await runtime.history(sessionId, undefined, 10);
		assert.deepEqual(completed.entryIds, [entryId, session.appendedEntryIds.at(-1)]);
		assert.deepEqual(
			completed.messages.map((message) => message.role),
			["user", "assistant"],
		);
		assert.equal(completed.state.isStreaming, false);
	});

	// 旧会话（已有 assistant）流式中的未落盘窗口：pi `_handleAgentEvent` 先
	// emit 事件后 appendMessage 落盘，手机强退重开的 history 若只读文件会把
	// 刚发出的 user 判成不存在（实测现场：AI 仍在 Working，user 气泡消失，
	// 回合结束后才随 assistant 一起出现）。
	it("旧会话流式中 live user 未落盘时 history 恢复，落盘后不重复", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { path } = writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.isStreaming = true;
		const liveHandle = (
			runtime as unknown as {
				handles: Map<string, { sessionManager: SessionManager }>;
			}
		).handles.get(SESSION_ID);
		assert.ok(liveHandle);
		// 真实 SessionManager.appendMessage 会同步落盘：先追加到内存+文件，
		// 再把该行从文件移除，制造"live 有、文件无"的 in-flight 现场（等价于
		// pi emit→append 之间文件尚未写入的窗口）。文件 size 变化使投影缓存
		// 失效重读，fileEntries 不含该 user。
		const entryId = liveHandle.sessionManager.appendMessage({
			role: "user",
			content: "流式中的新消息",
		} as Parameters<SessionManager["appendMessage"]>[0]);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		assert.ok(lines.at(-1)?.includes(`"id":"${entryId}"`), "末行应为刚追加的 user");
		writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

		for (const resetLeaf of [false, true]) {
			const page = await runtime.history(SESSION_ID, undefined, 20, resetLeaf);
			assert.deepEqual(page.entryIds, ["e2", "e3", "e4", entryId]);
			assert.equal(page.messages.at(-1)?.role, "user");
			assert.equal(page.state.isStreaming, true);
			assert.equal(page.latestEntryId, entryId, "并入 live 尾时最新以活跃链为准");
			assert.equal(
				page.latestEntryId,
				liveHandle.sessionManager.getLeafId(),
				"latestEntryId 与 live 叶子（getLeafId）同源，非文件水位",
			);
		}

		// 落盘后（真实场景 pi 会把 user+assistant 全部写入文件）：把 user 行写回，
		// 再让 live 正常追加 assistant，文件与 live 重新一致，history 不重复。
		const userLine = lines.at(-1);
		assert.ok(userLine);
		appendFileSync(path, `${userLine}\n`, "utf8");
		session.emitMessageEndThenAppend({ role: "assistant", content: [{ type: "text", text: "完成" }] });
		session.isStreaming = false;
		await flushEvents();
		const completed = await runtime.history(SESSION_ID, undefined, 20);
		assert.deepEqual(completed.entryIds, ["e2", "e3", "e4", entryId, session.appendedEntryIds.at(-1)]);
		assert.equal(
			completed.messages.filter((message) => message.role === "user").length,
			2,
			"fixture user + 新 user 各一条，不重复",
		);
		assert.equal(completed.state.isStreaming, false);
	});

	it("旧会话非流式时 live 领先不并入（保守：无 in-flight 证据）", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { path } = writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const liveHandle = (
			runtime as unknown as {
				handles: Map<string, { sessionManager: SessionManager }>;
			}
		).handles.get(SESSION_ID);
		assert.ok(liveHandle);
		liveHandle.sessionManager.appendMessage({
			role: "user",
			content: "非流式领先",
		} as Parameters<SessionManager["appendMessage"]>[0]);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
		const page = await runtime.history(SESSION_ID, undefined, 20);
		assert.deepEqual(page.entryIds, ["e2", "e3", "e4"], "无流式证据不并入 live 尾");
	});

	it("旧会话流式中文件被外部重写（非前缀）不复活已删条目", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { path } = writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		expectSession(sessions, SESSION_ID).isStreaming = true;
		// 外部进程改写文件：删除中间的 e2 行。live 内存仍含 e2（陈旧），
		// 但文件视图不再是 live 的前缀 → 不并入，e2 不得复活。
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		const withoutE2 = lines.filter((line) => !line.includes('"id":"e2"'));
		assert.equal(withoutE2.length, lines.length - 1);
		writeFileSync(path, `${withoutE2.join("\n")}\n`, "utf8");
		const page = await runtime.history(SESSION_ID, undefined, 20);
		assert.equal(page.entryIds.includes("e2"), false, "外部删除的条目不复活");
		assert.deepEqual(page.entryIds, ["e3", "e4"], "仅返回重写后的文件视图");
	});

	// 窗口①（文件尚无 assistant）同样有前缀防护：文件被外部重写成非 live
	// 前缀时，live 内存里的陈旧条目不得被并入复活。
	it("窗口①文件被外部重写（非前缀）不复活 live 陈旧条目", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		// 全 user fixture（无 assistant → 窗口①）：u1→u2→u3 单链。
		const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: SESSION_ID,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/fake-project",
			}),
			JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "一" } }),
			JSON.stringify({ type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "二" } }),
			JSON.stringify({ type: "message", id: "u3", parentId: "u2", message: { role: "user", content: "三" } }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		// 外部进程删除中间的 u2 行：文件不再是 live 前缀（live 内存仍含 u2）。
		const withoutU2 = lines.filter((line) => !line.includes('"id":"u2"'));
		assert.equal(withoutU2.length, lines.length - 1);
		writeFileSync(path, `${withoutU2.join("\n")}\n`, "utf8");
		const page = await runtime.history(SESSION_ID, undefined, 20);
		assert.equal(page.entryIds.includes("u2"), false, "窗口①外部删除的条目不复活（共用前缀防护）");
		// 删除中间条目后父链在 u2 处断开：从叶子 u3 回溯不可达 u1，
		// 与窗口②用例的 e3/e4 断言同理。若无前缀防护，live 里的 u2 会被并入复活。
		assert.deepEqual(page.entryIds, ["u3"], "仅返回重写后的文件视图");
	});

	it("rejects a cursor that is not on the branch", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await assert.rejects(() => runtime.history(SESSION_ID, "nope", 10), HistoryCursorError);
	});

	// 元数据页回归：limit 是原始 entries 预算，整页预算全被不渲染的元数据占满时
	// 不能返回“空页 + hasMore:false”（那会把更早的消息永久挡住）。
	it("skips a metadata-only page so the older message stays reachable", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeMetadataChainSession(sessionDir, 25, "tail");
		const { runtime } = fakeRuntime({ sessionDir });
		const page = await runtime.history(SESSION_ID, undefined, 20);
		assert.deepEqual(page.entryIds, ["old-msg"]);
		assert.equal(page.messages.length, 1);
		assert.equal((page.messages[0] as { content?: unknown }).content, "earliest user message");
		assert.equal(page.oldestEntryId, "old-msg");
		assert.equal(page.hasMore, false);
	});

	it("keeps normal limit-based cursors when a page does have messages", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeMetadataChainSession(sessionDir, 45, "middle");
		const { runtime } = fakeRuntime({ sessionDir });
		// 首页有可展示消息：不跳过，游标/hasMore 口径与原实现一致。
		const page1 = await runtime.history(SESSION_ID, undefined, 20);
		assert.deepEqual(page1.entryIds, ["new-msg"]);
		assert.equal(page1.oldestEntryId, "new-msg");
		assert.equal(page1.hasMore, true);
		// 第二页 20 条预算仍全是元数据 → 继续向前才翻到最早的用户消息。
		const page2 = await runtime.history(SESSION_ID, page1.oldestEntryId, 20);
		assert.deepEqual(page2.entryIds, ["old-msg"]);
		assert.equal(page2.oldestEntryId, "old-msg");
		assert.equal(page2.hasMore, false);
	});

	it("stops at the chain head when the branch has no displayable message", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeMetadataChainSession(sessionDir, 50, "none");
		const { runtime } = fakeRuntime({ sessionDir });
		const page = await runtime.history(SESSION_ID, undefined, 20);
		assert.deepEqual(page.messages, []);
		assert.deepEqual(page.entryIds, []);
		assert.equal(page.oldestEntryId, null);
		assert.equal(page.hasMore, false);
	});

	it("derives live state from a loaded handle", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const state = await runtime.state(SESSION_ID);
		assert.deepEqual(state.model, { provider: "p1", modelId: "m1" });
		assert.deepEqual(state.queuedMessages, { steering: ["queued-steer"], followUp: [] });
		assert.deepEqual(state.contextUsage, { percent: 42, contextWindow: 100_000, tokens: 42_000 });
		expectSession(sessions, SESSION_ID).isStreaming = true;
		assert.equal((await runtime.state(SESSION_ID)).isStreaming, true);
	});
});

/** Scripted catalog: exercises provider grouping, level derivation, and the
 * "unusable entry is dropped" path — never the real `~/.pi`. */
const CATALOG_MODELS = [
	{
		provider: "p1",
		id: "m1",
		name: "Model One",
		reasoning: true,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 8_000,
	},
	{
		provider: "p1",
		id: "m1-max",
		name: "Model One Max",
		reasoning: true,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 8_000,
		thinkingLevelMap: { xhigh: "x", max: "m", low: null },
	},
	{
		provider: "p2",
		id: "m2",
		name: "Model Two",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 16_000,
	},
	{ provider: "broken" },
	{ provider: "p3", id: "m3", name: "Model Three", reasoning: true, contextWindow: 1, maxTokens: 1 },
	{ provider: "p3", id: "m4", name: "Model Four", reasoning: true, input: ["audio"], contextWindow: 1, maxTokens: 1 },
];

describe("PiRuntime: history resetLeaf", () => {
	it("keeps the manual leaf when navigateTree is rejected mid-stream", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const page = await runtime.history(SESSION_ID, undefined, 10);
		// 手动叶子 = 页首（最旧）条目：钉住后 history 只切它的祖先链。
		const targetId = page.entryIds[0] ?? "";
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		internals.manualLeafIds.set(SESSION_ID, targetId);
		// 流式中且 pi accept 层拒绝 navigateTree（LaneBusy 语义）：钉子必须恢复。
		const session = expectSession(sessions, SESSION_ID);
		session.onNavigateTree = async () => ({ cancelled: true });
		session.isStreaming = true;
		const result = await runtime.history(SESSION_ID, undefined, 10, true);
		assert.deepEqual(result.entryIds.slice(-1), [targetId]);
		// 重复 reset（恢复后）行为一致，不抛。
		const again = await runtime.history(SESSION_ID, undefined, 10, true);
		assert.deepEqual(again.entryIds.slice(-1), [targetId]);
	});

	it("releases the manual leaf and anchors history to the file tail on success", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const page = await runtime.history(SESSION_ID, undefined, 10);
		const manualTarget = page.entryIds[0] ?? "";
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		internals.manualLeafIds.set(SESSION_ID, manualTarget);
		// 空闲 + navigate 成功（默认脚本）：resetLeaf 释放钉子并 navigate 到文件尾。
		const result = await runtime.history(SESSION_ID, undefined, 10, true);
		const fileTail = page.entryIds[page.entryIds.length - 1] ?? "";
		assert.deepEqual(result.entryIds.slice(-1), [fileTail]);
		// 钉子已释放（成功 navigate 后 manualLeafIds 不残留）。
		assert.equal(internals.manualLeafIds.has(SESSION_ID), false);
		// 运行时叶子确实被 navigate 到文件尾。
		const session = expectSession(sessions, SESSION_ID);
		assert.equal(session.navigateTreeCalls.at(-1)?.targetId, fileTail);
	});

	it("drops a stale manual leaf and serves history from the file tail", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const page = await runtime.history(SESSION_ID, undefined, 10);
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		// 外部改写致钉子 id 失效：无游标 history 应自愈回文件尾，不抛。
		internals.manualLeafIds.set(SESSION_ID, "ghost-leaf-id");
		const result = await runtime.history(SESSION_ID, undefined, 10);
		const fileTail = page.entryIds[page.entryIds.length - 1] ?? "";
		assert.deepEqual(result.entryIds.slice(-1), [fileTail]);
		assert.equal(internals.manualLeafIds.has(SESSION_ID), false);
	});
});

describe("PiRuntime: prompt consumes manual leaf", () => {
	it("releases the manual leaf once a prompt is accepted, so history re-anchors to the file tail", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const page = await runtime.history(SESSION_ID, undefined, 10);
		const manualTarget = page.entryIds[0] ?? "";
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		// 用户切到旧分支浏览后发消息：钉子存在时 history 锚在旧链。
		internals.manualLeafIds.set(SESSION_ID, manualTarget);
		const pinned = await runtime.history(SESSION_ID, undefined, 10);
		assert.deepEqual(pinned.entryIds.slice(-1), [manualTarget]);
		// 从树位置提交消息（preflight 受理）：手动叶子被消费。
		const handle = await runtime.openSession(SESSION_ID);
		await runtime.prompt(handle, "从旧分支继续", "prompt");
		assert.equal(internals.manualLeafIds.has(SESSION_ID), false);
		// 后续 history 锚回文件尾，而不是分叉前的旧窗口。
		const after = await runtime.history(SESSION_ID, undefined, 10);
		const fileTail = page.entryIds[page.entryIds.length - 1] ?? "";
		assert.deepEqual(after.entryIds.slice(-1), [fileTail]);
	});

	it("keeps the manual leaf when the prompt is rejected before acceptance", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const page = await runtime.history(SESSION_ID, undefined, 10);
		const manualTarget = page.entryIds[0] ?? "";
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		internals.manualLeafIds.set(SESSION_ID, manualTarget);
		const session = expectSession(sessions, SESSION_ID);
		session.onPrompt = async () => {
			throw new Error("no model selected");
		};
		const handle = await runtime.openSession(SESSION_ID);
		await assert.rejects(() => runtime.prompt(handle, "被拒", "prompt"), /no model selected/);
		// 被拒的提交没有消费钉子：仍在旧分支浏览位。
		assert.equal(internals.manualLeafIds.get(SESSION_ID), manualTarget);
	});
});

describe("PiRuntime: tree stale manual leaf", () => {
	it("falls back to the file tail when the manual leaf is stale", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const internals = runtime as unknown as { manualLeafIds: Map<string, string> };
		internals.manualLeafIds.set(SESSION_ID, "ghost-leaf-id");
		const tree = await runtime.tree(SESSION_ID);
		// 文件尾 e4，且钉子被清（与 history 共用自愈）。
		assert.equal(tree.leafId, "e4");
		assert.equal(internals.manualLeafIds.has(SESSION_ID), false);
	});
});

function fakeRegistry(): ModelRegistryLike {
	return {
		// Pi getAvailable 的模型都有 ID；损坏目录投影另在无范围的用例中注入。
		getAvailable: () => Promise.resolve(CATALOG_MODELS.filter((model) => model.id !== undefined)),
		getModel: (provider, modelId) =>
			CATALOG_MODELS.find((model) => model.provider === provider && model.id === modelId),
	};
}

describe("PiRuntime: 配置面门控（外部改文件后生效）", () => {
	// external-edit gating：网关是长驻进程，而 models.json / settings.json 是用户的
	// 编辑面。用 (mtime,size) 门控而不是 fs.watch（后者在各平台静默失败，见
	// pi-runtime 的 configFileGates 注释）。

	it("外部修改 models.json 后下一次 listModels 触发 pi 重读，未改动则不重复", async () => {
		const agentDir = tempDir("pi-mgw-agent-");
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		let refreshes = 0;
		const registry: ModelRegistryLike = {
			...fakeRegistry(),
			refresh: () => {
				refreshes += 1;
				return Promise.resolve();
			},
		};
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: registry,
			log: () => {},
		});
		runtimes.push(runtime);

		await runtime.listModels();
		assert.equal(refreshes, 1, "首次读取：无指纹 → 视为已变化，重读一次");
		await runtime.listModels();
		assert.equal(refreshes, 1, "文件未变：不重复重读（门控生效）");

		writeFileSync(modelsPath, JSON.stringify({ providers: { p1: { baseUrl: "http://x" } } }));
		await runtime.listModels();
		assert.equal(refreshes, 2, "外部改文件（编辑器/桌面 pi/其他客户端）：下一次读取即重读");
	});

	it("models.json 重读失败也记录指纹，不会每帧重复刷新", async () => {
		const agentDir = tempDir("pi-mgw-agent-");
		// 坏文件：refresh 后 getError() 非空，refreshModelRuntime 返回 false；
		// 但指纹必须已记录，否则每一帧都重复重读（k3 评审指出的细节）。
		writeFileSync(join(agentDir, "models.json"), "{ 坏 json");
		let refreshes = 0;
		const registry: ModelRegistryLike = {
			...fakeRegistry(),
			refresh: () => {
				refreshes += 1;
				return Promise.resolve();
			},
			getError: () => "bad models.json",
		};
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: registry,
			log: () => {},
		});
		runtimes.push(runtime);

		await runtime.listModels();
		await runtime.listModels();
		assert.equal(refreshes, 1, "刷新失败同样记录指纹");
	});

	it("外部手改 enabledModels 后，admitEnabledModel 不覆盖手改条目", async () => {
		// P1：写路径基于陈旧内存 `[...current, pattern]` 全量回写会覆盖用户手改。
		// 写前门控 reload 拿最新盘态后再合并，是本用例锁定的修复。
		const agentDir = tempDir("pi-mgw-agent-");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["p1/m1"] }));
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-sessions-"),
			log: () => {},
		});
		runtimes.push(runtime);

		assert.equal(await runtime.admitEnabledModel("p9"), true);
		await runtime.flushSettingsWrites();
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf-8")).enabledModels, ["p1/m1", "p9/*"]);

		// 用户在网关运行期间手改 settings.json：新增两条。
		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["p1/m1", "p9/*", "p2/m2"] }));
		assert.equal(await runtime.admitEnabledModel("p10"), true);
		await runtime.flushSettingsWrites();
		assert.deepEqual(
			JSON.parse(readFileSync(settingsPath, "utf-8")).enabledModels,
			["p1/m1", "p9/*", "p2/m2", "p10/*"],
			"用户手加的 p2/m2 必须保留（写前 reload 合并）",
		);

		// 读路径同样走门控：删除时基于最新盘态移除，不会把 p2/m2 一起抹掉。
		assert.equal(await runtime.removeEnabledModelPatternsForProvider("p10"), true);
		await runtime.flushSettingsWrites();
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf-8")).enabledModels, ["p1/m1", "p9/*", "p2/m2"]);
	});
	it("并发 admitEnabledModel 不互相覆盖（settings 读写串行化）", async () => {
		// 数据面帧处理是 fire-and-forget（server.ts 的 void handleMessage），
		// 两个 provider-put 可背靠背到达。此用例是回归冒烟（断言两条 pattern 都在），
		// 但它不能单独判定串行化是否必需：旁路 settingsWriteTail 后实测 3 轮仍全绿
		// ——pi 的 reload() 会先 await writeQueue，实际窗口比静态推断窄。
		// settingsWriteTail 作为不依赖 pi 内部时序的确定性保证保留。
		const agentDir = tempDir("pi-mgw-agent-");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["p1/m1"] }));
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-sessions-"),
			log: () => {},
		});
		runtimes.push(runtime);

		const results = await Promise.all([runtime.admitEnabledModel("p9"), runtime.admitEnabledModel("p10")]);
		await runtime.flushSettingsWrites();
		assert.deepEqual(results, [true, true]);
		assert.deepEqual(
			JSON.parse(readFileSync(settingsPath, "utf-8")).enabledModels,
			["p1/m1", "p9/*", "p10/*"],
			"两条 pattern 都必须保留",
		);
	});
});

describe("PiRuntime: model catalog and switching", () => {
	it("groups available models by provider and derives supported thinking levels", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { runtime } = fakeRuntime({
			sessionDir,
			modelRegistry: { ...fakeRegistry(), getAvailable: async () => CATALOG_MODELS },
		});
		const groups = await runtime.listModels();
		assert.deepEqual(
			groups.map((group) => group.provider),
			["p1", "p2", "p3"],
		);
		assert.deepEqual(
			groups[0].models.map((model) => model.id),
			["m1", "m1-max"],
		);
		// pi-ai parity: xhigh/max need an explicit map entry.
		assert.deepEqual(groups[0].models[0].thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
		// Explicit map: null removes low, xhigh/max appear.
		assert.deepEqual(groups[0].models[1].thinkingLevels, ["off", "minimal", "medium", "high", "xhigh", "max"]);
		// Non-reasoning models are off-only.
		assert.deepEqual(groups[1].models[0].thinkingLevels, ["off"]);
		assert.deepEqual(groups[1].models[0].input, ["text", "image"]);
		// Missing or unknown modalities fall back to the documented closed set.
		assert.deepEqual(
			groups[2].models.map((model) => model.input),
			[["text"], ["text"]],
		);
	});

	it("explicit global scope save expands globs, preserves thinking/unmatched entries and other settings", async () => {
		const agentDir = tempDir("pi-mgw-explicit-scope-");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ enabledModels: ["p1/*:high", "old/missing"], theme: "light", model: "m1" }),
		);
		const sessionDir = tempDir("pi-mgw-scope-history-");
		writeFixtureSession(sessionDir);
		const sessions = new Map<string, FakeSession>();
		const valid = CATALOG_MODELS.filter((model) => model.id !== undefined);
		const runtime = new PiRuntime({
			agentDir,
			sessionDir,
			modelRegistry: {
				getAvailable: async () => valid,
				getModel: (p, m) => valid.find((item) => item.provider === p && item.id === m),
			},
			sessionFactory: async ({ sessionManager }) => {
				const session = new FakeSession(sessionManager);
				sessions.set(session.sessionId, session);
				return session;
			},
		});
		runtimes.push(runtime);
		await runtime.openSession(SESSION_ID);
		const before = await runtime.state(SESSION_ID);
		const current = await runtime.modelScope();
		assert.deepEqual(current.unmatchedPatterns, ["old/missing"]);
		assert.deepEqual(
			current.selected.map((item) => [item.modelId, item.thinkingLevel]),
			[
				["m1", "high"],
				["m1-max", "high"],
			],
		);
		const saved = await runtime.saveModelScope(current.patterns, [current.selected[1]], true, false);
		assert.deepEqual(saved.patterns, ["p1/m1-max:high", "old/missing"]);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			enabledModels: saved.patterns,
			theme: "light",
			model: "m1",
		});
		const session = expectSession(sessions, SESSION_ID);
		assert.equal(session.modelSetCalls.length, 0);
		assert.equal(session.scopeSetCalls.length, 1);
		const after = await runtime.state(SESSION_ID);
		assert.deepEqual(after.model, before.model);
		assert.equal(after.thinkingLevel, before.thinkingLevel);
		const reset = await runtime.saveModelScope(saved.patterns, [], false, true);
		assert.deepEqual(reset.patterns, []);
		assert.equal(reset.selected.length, valid.length);
		assert.equal((await runtime.listModels()).length, 3);
	});

	it("大小写冲突范围保存和重读与 Pi 官方解析一致", async () => {
		const agentDir = tempDir("pi-mgw-case-scope-");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enabledModels: ["p1/m1"], theme: "light" }));
		const models = [
			{ ...CATALOG_MODELS[0], provider: "p1", id: "m1" },
			{ ...CATALOG_MODELS[0], provider: "deepseek", id: "deepseek-flash" },
			{ ...CATALOG_MODELS[0], provider: "Deepseek", id: "deepseek-flash" },
		];
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-case-sessions-"),
			modelRegistry: {
				getAvailable: async () => models,
				getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			},
		});
		runtimes.push(runtime);
		const snapshot = await runtime.modelScope();
		const picks = [snapshot.selected[0], { provider: "Deepseek", modelId: "deepseek-flash", thinkingLevel: "high" }];
		const saved = await runtime.saveModelScope(snapshot.patterns, picks, true, false);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			enabledModels: ["p1/m1", "Deepseek/deepseek-flash:high"],
			theme: "light",
		});
		const native = await resolveModelScopeWithDiagnostics(saved.patterns, {
			getAvailable: async () => models,
		} as unknown as ModelRuntime);
		const expected = native.scopedModels.map(({ model, thinkingLevel }) => ({
			provider: model.provider,
			modelId: model.id,
			thinkingLevel,
		}));
		assert.deepEqual(saved.selected, expected);
		assert.deepEqual(saved.unmatchedPatterns, []);
		assert.deepEqual((await runtime.modelScope()).selected, expected);
		assert.deepEqual(
			(await runtime.listModels()).flatMap((g) => g.models.map((m) => `${g.provider}/${m.id}`)).sort(),
			expected.map((m) => `${m.provider}/${m.modelId}`).sort(),
		);
	});

	it("模型全名、裸 ID 歧义、冒号和通配符全部沿用 Pi 官方范围结果", async () => {
		const models = [
			{ ...CATALOG_MODELS[0], provider: "p1", id: "m1" },
			{ ...CATALOG_MODELS[0], provider: "relay-a", id: "chat" },
			{ ...CATALOG_MODELS[0], provider: "relay-b", id: "chat" },
			{ ...CATALOG_MODELS[0], provider: "relay-a", id: "chat:high" },
			{ ...CATALOG_MODELS[0], provider: "relay-b", id: "chat:high" },
		];
		let patterns: string[] = [];
		const registry = {
			getAvailable: async () => models,
			getModel: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		};
		const { runtime } = fakeRuntime({ modelRegistry: registry, enabledModelsLoader: () => patterns });
		for (const next of [
			["relay-b/chat", "relay-a/chat"],
			["chat"],
			["chat:high"],
			["relay-b/chat:high:max", "relay-a/chat:high", "p1/*", "missing/model"],
			["relay-*/chat:high"],
		]) {
			patterns = next;
			const native = await resolveModelScopeWithDiagnostics(patterns, registry as unknown as ModelRuntime);
			const expected = native.scopedModels.map(({ model, thinkingLevel }) => ({
				provider: model.provider,
				modelId: model.id,
				thinkingLevel,
			}));
			const snapshot = await runtime.modelScope();
			assert.deepEqual(snapshot.selected, expected, patterns.join(","));
			assert.deepEqual(
				snapshot.unmatchedPatterns,
				native.diagnostics.filter((d) => d.code === "no-match").map((d) => d.pattern),
			);
			assert.deepEqual(
				(await runtime.listModels()).flatMap((g) => g.models.map((m) => `${g.provider}/${m.id}`)).sort(),
				expected.map((m) => `${m.provider}/${m.modelId}`).sort(),
			);
			if (patterns.length === 1 && patterns[0] === "chat") {
				assert.equal(native.scopedModels.length, 2);
				assert.equal(native.diagnostics[0].code, "ambiguous");
			}
		}
	});

	it("scope writes reject stale snapshots, unavailable/duplicate/empty picks, and confirm actual persistence", async () => {
		let current = ["p1/*", "old/missing"];
		let writes = 0;
		const valid = CATALOG_MODELS.filter((model) => model.id !== undefined);
		const { runtime } = fakeRuntime({
			modelRegistry: {
				getAvailable: async () => valid,
				getModel: (p, m) => valid.find((item) => item.provider === p && item.id === m),
			},
			enabledModelsLoader: () => current,
			enabledModelsSetter: (patterns) => {
				writes += 1;
				current = patterns;
			},
		});
		const snapshot = await runtime.modelScope();
		await assert.rejects(runtime.saveModelScope([], snapshot.selected, true, false), { code: "scope-conflict" });
		await assert.rejects(runtime.saveModelScope(current, [], true, false), { code: "bad-request" });
		await assert.rejects(runtime.saveModelScope(current, [{ provider: "p1", modelId: "missing" }], true, false), {
			code: "bad-request",
		});
		await assert.rejects(runtime.saveModelScope(current, [snapshot.selected[0], snapshot.selected[0]], true, false), {
			code: "bad-request",
		});
		assert.equal(writes, 0);
		const outcomes = await Promise.allSettled([
			runtime.saveModelScope(snapshot.patterns, [snapshot.selected[0]], false, false),
			runtime.saveModelScope(snapshot.patterns, [snapshot.selected[1]], false, false),
		]);
		assert.equal(outcomes[0].status, "fulfilled");
		assert.equal(outcomes[1].status, "rejected");
		assert.deepEqual(current, ["p1/m1"]);
		const { runtime: failed } = fakeRuntime({
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p1/m1"],
			enabledModelsSetter: () => {},
		});
		await assert.rejects(failed.saveModelScope(["p1/m1"], [{ provider: "p2", modelId: "m2" }], false, false), {
			code: "scope-save-failed",
		});
	});

	it("invalid Pi settings fail editing without replacing broken settings with an empty scope", async () => {
		const agentDir = tempDir("pi-mgw-invalid-scope-");
		const settings = join(agentDir, "settings.json");
		writeFileSync(settings, "{broken");
		const runtime = new PiRuntime({
			agentDir,
			sessionDir: tempDir("pi-mgw-invalid-sessions-"),
			modelRegistry: fakeRegistry(),
			log: () => {},
		});
		runtimes.push(runtime);
		await assert.rejects(runtime.modelScope(), { code: "scope-read-failed" });
		await assert.rejects(runtime.saveModelScope([], [{ provider: "p1", modelId: "m1" }], false, false), {
			code: "scope-read-failed",
		});
		assert.equal(readFileSync(settings, "utf8"), "{broken");
		writeFileSync(settings, JSON.stringify({ enabledModels: "p1/*" }));
		await assert.rejects(runtime.modelScope(), { code: "scope-read-failed" });
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { enabledModels: "p1/*" });
	});

	it("filters the catalog by enabledModels with TUI scope semantics", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const { runtime } = fakeRuntime({
			sessionDir,
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p1/m1", "p3/m4"],
		});
		const groups = await runtime.listModels();
		assert.deepEqual(
			groups.map((group) => group.provider),
			["p1", "p3"],
		);
		assert.deepEqual(
			groups[0].models.map((model) => model.id),
			["m1"],
		);
		assert.deepEqual(
			groups[1].models.map((model) => model.id),
			["m4"],
		);
	});

	it("reads settings scope afresh without treating the model directory as an enabled list", async () => {
		const agentDir = tempDir("pi-mgw-scope-");
		const settings = join(agentDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ enabledModels: ["p1/m1"] }));
		const models = CATALOG_MODELS.filter((model) => model.id !== undefined);
		const runtime = new PiRuntime({
			agentDir,
			modelRegistry: {
				getAvailable: async () => models,
				getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			},
			sessionDir: tempDir("pi-mgw-scope-sessions-"),
		});
		runtimes.push(runtime);
		const first = await runtime.listModels();
		assert.deepEqual(
			first.flatMap((g) => g.models.map((m) => `${g.provider}/${m.id}`)),
			["p1/m1"],
		);
		writeFileSync(settings, JSON.stringify({ enabledModels: ["p3/m4", "p1/m1-max:high"] }));
		const next = await runtime.listModels();
		assert.deepEqual(
			next.flatMap((g) => g.models.map((m) => `${g.provider}/${m.id}`)),
			["p1/m1-max", "p3/m4"],
		);
		assert.equal(
			next.some((g) => g.provider === "p2"),
			false,
		);
	});

	it("provider test status cannot hide Pi-enabled models", async () => {
		const { runtime } = fakeRuntime({
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p1/m1"],
			providerActive: () => false,
		});
		const groups = await runtime.listModels();
		assert.deepEqual(
			groups.map((group) => group.provider),
			["p1"],
		);
		assert.deepEqual(
			groups[0].models.map((model) => model.id),
			["m1"],
		);
	});

	it("enabledModels supports globs and silently drops no-match patterns", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		// Glob 匹配按 provider/id 逐项测试，要求 id 存在（真实目录不会有无 id 模型）。
		const wellFormed = CATALOG_MODELS.filter((model) => model.id !== undefined);
		const { runtime } = fakeRuntime({
			sessionDir,
			modelRegistry: {
				getAvailable: () => Promise.resolve(wellFormed),
				getModel: (provider, modelId) =>
					wellFormed.find((model) => model.provider === provider && model.id === modelId),
			},
			enabledModelsLoader: () => ["p1/*", "nope/none"],
		});
		const groups = await runtime.listModels();
		assert.deepEqual(
			groups.map((group) => group.provider),
			["p1"],
		);
		assert.deepEqual(
			groups[0].models.map((model) => model.id),
			["m1", "m1-max"],
		);
	});

	it("all unmatched scope patterns use the native empty-scope catalog fallback", async () => {
		const wellFormed = CATALOG_MODELS.filter((model) => model.id !== undefined);
		const { runtime } = fakeRuntime({
			modelRegistry: {
				getAvailable: async () => wellFormed,
				getModel: (provider, id) => wellFormed.find((model) => model.provider === provider && model.id === id),
			},
			enabledModelsLoader: () => ["missing/removed-model", "absent/*"],
		});
		// SDK ModelSelector defaults to all when CLI's resolved scopedModels is empty.
		assert.deepEqual(
			(await runtime.listModels()).map((group) => group.provider),
			["p1", "p2", "p3"],
		);
	});

	it("empty or failing enabledModels leaves the catalog unfiltered", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const empty = fakeRuntime({
			sessionDir,
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => [],
		});
		assert.deepEqual(
			(await empty.runtime.listModels()).map((group) => group.provider),
			["p1", "p2", "p3"],
		);
		const failing = fakeRuntime({
			sessionDir,
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => {
				throw new Error("boom");
			},
		});
		assert.deepEqual(
			(await failing.runtime.listModels()).map((group) => group.provider),
			["p1", "p2", "p3"],
		);
	});

	// admitEnabledModel 决定手机新建的 provider 能不能出现在模型菜单里：pi 只对含通配符的
	// pattern 做 provider/id 匹配，裸 provider id 必然 "No models match pattern"。
	it("admitEnabledModel writes a provider glob, never a bare id", async () => {
		const written: string[] = [];
		const { runtime } = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p1/m1"],
			enabledModelsAppender: (pattern) => {
				written.push(pattern);
			},
		});
		assert.equal(await runtime.admitEnabledModel("p9"), true);
		assert.deepEqual(written, ["p9/*"]);
	});

	it("admitEnabledModel skips the write when unfiltered or already admitted", async () => {
		const written: string[] = [];
		const appender = (pattern: string) => {
			written.push(pattern);
		};
		const unfiltered = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			// enabledModels 未配置时菜单不过滤；写入会把全量变成白名单、隐藏其他模型。
			enabledModelsLoader: () => undefined,
			enabledModelsAppender: appender,
		});
		assert.equal(await unfiltered.runtime.admitEnabledModel("p9"), true);
		const already = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p9/*"],
			enabledModelsAppender: appender,
		});
		assert.equal(await already.runtime.admitEnabledModel("p9"), true);
		assert.deepEqual(written, []);
	});

	it("removeEnabledModelPatterns drops only the removed models' patterns", async () => {
		// 手机端在 provider 编辑里删掉几个模型行：只清这些模型的具体 pattern，
		// 同 provider 其他模型条目与通配符都不动。
		const removed: string[] = [];
		// 有状态的 loader/remover：模拟真实"删完盘上就没了"，幂等才有意义
		//（无状态 override 每次返回原列表，会重复命中）。
		let current = ["relayA/old-a", "relayA/keep", "relayA/*"];
		const { runtime } = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => current,
			enabledModelsRemover: (pattern) => {
				removed.push(pattern);
				current = current.filter((entry) => entry !== pattern);
			},
		});
		assert.equal(await runtime.removeEnabledModelPatterns("relayA", ["old-a"]), true);
		assert.deepEqual(removed, ["relayA/old-a"]);
		// 幂等：再删一次没有匹配项就不写。
		assert.equal(await runtime.removeEnabledModelPatterns("relayA", ["old-a"]), true);
		assert.deepEqual(removed, ["relayA/old-a"]);
	});

	it("removeEnabledModelPatterns strips a :thinkingLevel suffix before matching", async () => {
		// `provider/model:high` 是 pi 合法的 pattern 形态（model-resolver 用
		// lastIndexOf(":") 剥后缀）。精确匹配必须同样剥掉，否则这类条目清不掉。
		let current = ["relayA/example-model-flash:high", "relayA/keep", "other/example-model-flash"];
		const removed: string[] = [];
		const { runtime } = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => current,
			enabledModelsRemover: (pattern) => {
				removed.push(pattern);
				current = current.filter((entry) => entry !== pattern);
			},
		});
		assert.equal(await runtime.removeEnabledModelPatterns("relayA", ["example-model-flash"]), true);
		// 只清本 provider 的条目，同名的其他 provider 不动。
		assert.deepEqual(removed, ["relayA/example-model-flash:high"]);
	});

	it("removeEnabledModelPatternsForProvider clears glob and per-model patterns", async () => {
		// 删 provider 时 `providerId/*` 与 `providerId/<模型id>` 都成了死 pattern。
		// 旧实现只删通配符形态，具体模型条目会永久残留（实测残留过
		// `relayA/example-model-flash` 这种）。
		const removed: string[] = [];
		const { runtime } = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["relayA/*", "relayA/example-model-flash", "other/x"],
			enabledModelsRemover: (pattern) => {
				removed.push(pattern);
			},
		});
		assert.equal(await runtime.removeEnabledModelPatternsForProvider("relayA"), true);
		assert.deepEqual(removed, ["relayA/*", "relayA/example-model-flash"]);
		// 不含该 provider 的 pattern / 列表未配置时幂等不写。
		const appenderless = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => ["p1/m1"],
			enabledModelsRemover: (pattern) => {
				removed.push(pattern);
			},
		});
		assert.equal(await appenderless.runtime.removeEnabledModelPatternsForProvider("p9"), true);
		const unfiltered = fakeRuntime({
			sessionDir: tempDir("pi-mgw-sessions-"),
			modelRegistry: fakeRegistry(),
			enabledModelsLoader: () => undefined,
			enabledModelsRemover: (pattern) => {
				removed.push(pattern);
			},
		});
		assert.equal(await unfiltered.runtime.removeEnabledModelPatternsForProvider("p9"), true);
		assert.deepEqual(removed, ["relayA/*", "relayA/example-model-flash"]);
	});

	it("switches model session-only and returns the effective state", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir, modelRegistry: fakeRegistry() });
		const state = await runtime.setModel(SESSION_ID, "p2", "m2", "high");
		assert.deepEqual(state.model, { provider: "p2", modelId: "m2" });
		assert.equal(state.thinkingLevel, "high");
		const session = expectSession(sessions, SESSION_ID);
		assert.equal(session.modelSetCalls.length, 1);
		// Session-only: global defaults must never be rewritten from a phone.
		assert.equal(session.modelSetCalls[0].persist, false);
		assert.deepEqual(session.thinkingLevelCalls, ["high"]);
	});

	it("rejects unknown models and surfaces pi validation failures", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir, modelRegistry: fakeRegistry() });
		await assert.rejects(() => runtime.setModel(SESSION_ID, "p1", "nope"), ModelChangeError);
		const session = expectSession(sessions, SESSION_ID);
		session.onSetModel = () => Promise.reject(new Error("No API key for p1"));
		await assert.rejects(() => runtime.setModel(SESSION_ID, "p1", "m1"), /No API key/);
	});

	it("reports the level pi actually applied, not the requested one", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir, modelRegistry: fakeRegistry() });
		await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		// Mirrors the real catalog: `relayB/example-model` only supports `max`.
		session.allowedThinkingLevels = ["max"];
		const state = await runtime.setModel(SESSION_ID, "p1", "m1", "low");
		assert.deepEqual(session.thinkingLevelCalls, ["low"]);
		assert.equal(state.thinkingLevel, "max");
	});
});

describe("PiRuntime: new sessions and lifecycle", () => {
	it("creates a session for a validated cwd and invalidates the index", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		const cwd = tempDir("pi-mgw-project-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.createSession(cwd);
		const session = expectSession(sessions, handle.session.sessionId);
		assert.ok(session);
		// The new session must be openable by id and promptable.
		const reopened = await runtime.openSession(handle.session.sessionId);
		assert.equal(reopened.session.sessionId, handle.session.sessionId);
		await runtime.prompt(reopened, "go", "prompt");
		assert.deepEqual(session.promptCalls, [{ text: "go", mode: undefined }]);
	});

	it("aborts loaded sessions", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		await runtime.abort(SESSION_ID);
		assert.equal(expectSession(sessions, SESSION_ID).aborted, true);
	});

	it("takes queued text before abort and does not consume it twice", async () => {
		const sessionDir = tempDir("pi-mgw-abort-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.steeringMessages = ["s"];
		session.followUpMessages = ["f1", "f2"];
		session.isStreaming = true;
		const originalAbort = session.abort.bind(session);
		session.abort = async () => {
			assert.deepEqual(session.getSteeringMessages(), []);
			assert.deepEqual(session.getFollowUpMessages(), []);
			await originalAbort();
		};
		const result = await runtime.abort(SESSION_ID, true);
		assert.deepEqual(result.queued, ["s", "f1", "f2"]);
		assert.equal(result.state.isStreaming, false);
		assert.deepEqual(result.state.queuedMessages, { steering: [], followUp: [] });
		assert.deepEqual((await runtime.abort(SESSION_ID, true)).queued, []);
		assert.equal(session.promptCalls.length, 0);
	});

	it("abort waits for an in-flight prompt admission before taking its follow-up", async () => {
		const sessionDir = tempDir("pi-mgw-abort-admission-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const session = expectSession(sessions, SESSION_ID);
		session.steeringMessages = [];
		let admit!: () => void;
		const entered = new Promise<void>((resolve) => {
			session.onPrompt = async (_session, text, options) => {
				admit = () => {
					session.followUpMessages.push(text);
					options.preflightResult?.("queued");
				};
				resolve();
				await new Promise<void>(() => {});
			};
		});
		const prompt = runtime.prompt(handle, "pending", "followUp");
		await entered;
		let ended = false;
		const stopping = runtime.abort(SESSION_ID, true).then((result) => {
			ended = true;
			return result;
		});
		await Promise.resolve();
		assert.equal(ended, false);
		admit();
		await prompt;
		assert.deepEqual((await stopping).queued, ["pending"]);
	});

	it("disposes idle subscriber-less handles on sweep and keeps running ones", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		let clock = 1_000_000;
		const { runtime, sessions } = fakeRuntime({ sessionDir, now: () => clock, idleDisposeMs: 60_000 });
		await runtime.openSession(SESSION_ID);
		runtime.sweep();
		assert.ok(!expectSession(sessions, SESSION_ID).disposed, "handle must survive the grace period");
		clock += 61_000;
		runtime.sweep();
		assert.ok(expectSession(sessions, SESSION_ID).disposed, "idle handle must be disposed after grace");
		// A disposed handle reloads from the file as a fresh session.
		const reloaded = await runtime.openSession(SESSION_ID);
		assert.equal(reloaded.session.sessionId, SESSION_ID);
		assert.ok(runtime.peekSession(SESSION_ID) !== undefined);
		assert.equal(expectSession(sessions, SESSION_ID).disposed, false, "reload replaces the disposed fake");
	});

	it("keeps a streaming handle alive across the grace period", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		let clock = 1_000_000;
		const { runtime, sessions } = fakeRuntime({ sessionDir, now: () => clock, idleDisposeMs: 60_000 });
		await runtime.openSession(SESSION_ID);
		expectSession(sessions, SESSION_ID).isStreaming = true;
		clock += 10_000_000;
		runtime.sweep();
		assert.ok(!expectSession(sessions, SESSION_ID).disposed, "streaming handle must not be disposed");
	});

	it("disposeAll disposes every handle", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		runtime.disposeAll();
		assert.ok(expectSession(sessions, SESSION_ID).disposed);
	});
});

// ---------------------------------------------------------------------------
// Review round: concurrency, capacity and size budgets
// ---------------------------------------------------------------------------

describe("PiRuntime: concurrent build dedup", () => {
	it("deduplicates concurrent openSession into a single build", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		let buildCount = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = new PiRuntime({
			sessionDir,
			sessionFactory: async ({ sessionManager }) => {
				buildCount += 1;
				await gate;
				return new FakeSession(sessionManager);
			},
		});
		runtimes.push(runtime);
		const p1 = runtime.openSession(SESSION_ID);
		const p2 = runtime.openSession(SESSION_ID);
		release();
		const [a, b] = await Promise.all([p1, p2]);
		assert.equal(buildCount, 1, "concurrent openers must share one factory call");
		assert.equal(a.session, b.session, "both openers must receive the same live handle");
	});

	it("deduplicates concurrent createSession for the same cwd", async () => {
		const { runtime } = fakeRuntime();
		const cwd = tempDir("pi-mgw-proj-");
		const p1 = runtime.createSession(cwd);
		const p2 = runtime.createSession(cwd);
		const [a, b] = await Promise.all([p1, p2]);
		assert.equal(a.session.sessionId, b.session.sessionId, "double-tap must not create two sessions");
	});
	// The buildSession idempotency guard (duplicate id during factory await)
	// is defense-in-depth for direct internal callers: the open-side
	// in-flight lock makes the concurrent double-build publicly unreachable.
	// It is exercised via the concurrent dedup tests above.
});

describe("PiRuntime: handle cap", () => {
	it("evicts the oldest idle handles above the cap and keeps live ones", async () => {
		const { runtime, sessions } = fakeRuntime({ maxLoadedSessions: 2 });
		const cwd = tempDir("pi-mgw-proj-");
		const first = await runtime.createSession(cwd);
		const second = await runtime.createSession(cwd);
		// Keep the second handle alive by attaching a subscriber.
		const detach = second.attach(() => {});
		const thirdSession = await runtime.createSession(cwd);
		assert.ok(runtime.peekSession(first.session.sessionId) === undefined, "oldest idle handle evicted");
		assert.ok(runtime.peekSession(second.session.sessionId) !== undefined, "subscribed handle survives");
		assert.ok(runtime.peekSession(thirdSession.session.sessionId) !== undefined);
		assert.ok(expectSession(sessions, first.session.sessionId).disposed, "evicted fake is disposed");
		detach();
	});
});

describe("PiRuntime: event size budget", () => {
	it("shrinks oversized event payloads before delivery", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const frames: Array<Record<string, unknown>> = [];
		handle.attach((frame) => frames.push(frame));
		const session = expectSession(sessions, SESSION_ID);
		session.emit({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				// 1.5 MB of base64 pushes the serialized frame past the
				// 1 MiB event budget, forcing the placeholder substitution.
				content: [{ type: "image", data: "A".repeat(1_500_000), mediaType: "image/png" }],
			},
		} as unknown as AgentSessionEvent);
		await flushEvents();
		assert.equal(frames.length, 1);
		const event = frames[0].event as Record<string, unknown>;
		const message = event.message as Record<string, unknown>;
		const imageBlock = (message.content as Record<string, unknown>[])[0];
		assert.equal("data" in imageBlock, false);
		assert.equal(imageBlock.dataOmitted, true);
	});

	it("downgrades pathological payloads to event_omitted and keeps seq monotonic", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const frames: Array<Record<string, unknown>> = [];
		handle.attach((frame) => frames.push(frame));
		const session = expectSession(sessions, SESSION_ID);
		const blocks = Array.from({ length: 100 }, () => ({ type: "text", text: "x".repeat(200_000) }));
		session.emit({
			type: "message_end",
			message: { role: "assistant", content: blocks },
		} as unknown as AgentSessionEvent);
		await flushEvents();
		assert.equal(frames.length, 1);
		const event = frames[0].event as Record<string, unknown>;
		assert.equal(event.type, "event_omitted");
		assert.equal(event.originalType, "message_end");
		assert.equal(frames[0].seq, 1);
		// The stream continues normally afterwards.
		session.emit({ type: "agent_end" } as AgentSessionEvent);
		await flushEvents();
		assert.equal((frames[1].event as Record<string, unknown>).type, "agent_end");
		assert.equal(frames[1].seq, 2);
	});

	it("a throwing sink never breaks delivery to other subscribers", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const received: Array<Record<string, unknown>> = [];
		handle.attach(() => {
			throw new Error("dead connection");
		});
		const detach = handle.attach((frame) => received.push(frame));
		expectSession(sessions, SESSION_ID).emit({ type: "agent_end" } as AgentSessionEvent);
		await flushEvents();
		assert.equal(received.length, 1);
		detach();
	});
});

describe("PiRuntime: message_end 实时身份（帧顶层 entryId）", () => {
	/** 打开固定 fixture 会话并挂一个收帧 sink。 */
	async function openWithSink(sessionDir: string) {
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		const handle = await runtime.openSession(SESSION_ID);
		const frames: Array<Record<string, unknown>> = [];
		handle.attach((frame) => frames.push(frame));
		return { runtime, session: expectSession(sessions, SESSION_ID), frames };
	}

	/** 取 live handle 的真实 SessionManager（与 fake session 同一实例）。 */
	function sessionManagerFor(runtime: PiRuntime): SessionManager {
		const handles = (runtime as unknown as { handles: Map<string, { sessionManager: SessionManager }> }).handles;
		const live = handles.get(SESSION_ID);
		if (!live) throw new Error(`live handle missing: ${SESSION_ID}`);
		return live.sessionManager;
	}

	it("emit→append 与 pi 同序：帧顶层带刚持久化条目的 entryId，并与 history entryIds 同源", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		const message = { role: "user", content: "身份探针" };
		session.emitMessageEndThenAppend(message);
		await flushEvents();

		const frame = frames.at(-1) as Record<string, unknown>;
		assert.equal((frame.event as Record<string, unknown>).type, "message_end");
		assert.equal(frame.entryId, session.appendedEntryIds.at(-1));
		const page = await runtime.history(SESSION_ID, undefined, 10, false);
		assert.ok(page.entryIds.includes(frame.entryId as string));
	});

	it("只 emit 不 append：帧照发但顶层无 entryId 键", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { session, frames } = await openWithSink(sessionDir);
		session.emitMessageEndOnly({ role: "assistant", content: [{ type: "text", text: "未持久化" }] });
		await flushEvents();

		const frame = frames.at(-1) as Record<string, unknown>;
		assert.equal(frame.kind, "event");
		assert.equal("entryId" in frame, false);
	});

	it("getEntries 读取异常：只省略 entryId，帧照发且 seq 连续", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		// 临时把 live handle 的 getEntries 换成抛错，flush 后还原。
		const handles = (runtime as unknown as { handles: Map<string, { sessionManager: SessionManager }> }).handles;
		const live = handles.get(SESSION_ID) as { sessionManager: SessionManager } | undefined;
		const original = live?.sessionManager.getEntries.bind(live.sessionManager);
		assert.ok(live && original);
		live.sessionManager.getEntries = () => {
			throw new Error("audit: getEntries failure");
		};
		try {
			session.emitMessageEndThenAppend({ role: "user", content: "读不到也不丢帧" });
			session.emit({ type: "agent_end" } as AgentSessionEvent);
			await flushEvents();
		} finally {
			live.sessionManager.getEntries = original;
		}
		assert.equal(frames.length, 2);
		assert.equal("entryId" in (frames[0] as Record<string, unknown>), false);
		assert.equal(frames[0].seq, 1);
		assert.equal(frames[1].seq, 2);
		assert.equal((frames[1].event as Record<string, unknown>).type, "agent_end");
	});

	it("入队后修改原事件对象不影响已排定帧（真实快照），sourceMessage 引用仍可匹配", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		const message = { role: "user", content: "入队时文本" };
		session.emit({ type: "message_end", message } as AgentSessionEvent);
		// 模拟 pi 在 emit 后改对象（append 前后皆可能）：改文本不改引用。
		message.content = "pi 改后的文本";
		session.appendedEntryIds.push(
			// 引用未变，flush 时仍应匹配到这条 append 的条目。
			sessionManagerFor(runtime).appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]),
		);
		await flushEvents();

		const frame = frames.at(-1) as Record<string, unknown>;
		const event = frame.event as Record<string, unknown>;
		assert.equal((event.message as Record<string, unknown>).content, "入队时文本");
		assert.equal(frame.entryId, session.appendedEntryIds.at(-1));
	});

	it("FIFO 保序与 seq 连续：同 tick 批量 emit + append 穿插仍按原序下发", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		const manager = sessionManagerFor(runtime);
		session.emit({ type: "agent_start" } as AgentSessionEvent);
		const first = { role: "user", content: "第一条" };
		session.emit({ type: "message_end", message: first } as AgentSessionEvent);
		session.appendedEntryIds.push(manager.appendMessage(first as Parameters<SessionManager["appendMessage"]>[0]));
		session.emit({ type: "agent_end" } as AgentSessionEvent);
		const second = { role: "assistant", content: [{ type: "text", text: "第二条" }] };
		session.emit({ type: "message_end", message: second } as AgentSessionEvent);
		session.appendedEntryIds.push(manager.appendMessage(second as Parameters<SessionManager["appendMessage"]>[0]));
		await flushEvents();

		assert.deepEqual(
			frames.map((f) => (f.event as Record<string, unknown>).type),
			["agent_start", "message_end", "agent_end", "message_end"],
		);
		assert.deepEqual(
			frames.map((f) => f.seq),
			[1, 2, 3, 4],
		);
		assert.equal(frames[1].entryId, session.appendedEntryIds[0]);
		assert.equal(frames[3].entryId, session.appendedEntryIds[1]);
		assert.equal("entryId" in (frames[2] as Record<string, unknown>), false);
	});

	it("dispose 清空队列：emit 后立刻 dispose，残留 flush 不发帧", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		session.emit({ type: "message_end", message: { role: "user", content: "来不及发" } } as AgentSessionEvent);
		runtime.disposeAll();
		await flushEvents();
		assert.equal(frames.length, 0);
	});

	it("超限大图降损占位后仍带帧顶层 entryId（身份独立于帧内容）", async () => {
		const sessionDir = tempDir("pi-mgw-sessions-");
		writeFixtureSession(sessionDir);
		const { runtime, session, frames } = await openWithSink(sessionDir);
		const message = {
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "image", data: "A".repeat(1_500_000), mediaType: "image/png" }],
		};
		session.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		session.appendedEntryIds.push(
			sessionManagerFor(runtime).appendMessage(message as unknown as Parameters<SessionManager["appendMessage"]>[0]),
		);
		await flushEvents();

		const frame = frames.at(-1) as Record<string, unknown>;
		assert.equal((frame.event as Record<string, unknown>).type, "message_end");
		assert.equal(frame.entryId, session.appendedEntryIds.at(-1));
	});
});

// ---------------------------------------------------------------------------
// attachment（§4.22）：runtime 层读取路径与校验
// ---------------------------------------------------------------------------

/** 最小合法 1x1 PNG（base64）。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** 原始 4 MiB 边界与 +1 超限样本。 */
const RAW_AT_LIMIT = Buffer.alloc(ATTACHMENT_MAX_RAW_BYTES).toString("base64");
const RAW_OVER_LIMIT = Buffer.alloc(ATTACHMENT_MAX_RAW_BYTES + 1).toString("base64");

/** 带 user 图片消息的 fixture：多图/非 user/坏 base64/坏 mime/边界与超限齐全。 */
function writeImageFixtureSession(sessionDir: string): void {
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/fake-project",
		}),
		JSON.stringify({ type: "model_change", id: "e0", parentId: null, provider: "fp", modelId: "fm" }),
		// e1：两张图 + 文本（imageIndex 0/1 均可取）。
		JSON.stringify({
			type: "message",
			id: "e1",
			parentId: "e0",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "看这两张" },
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					{ type: "image", data: Buffer.from("jpeg-bytes-2").toString("base64"), mimeType: "image/jpeg" },
				],
			},
		}),
		// e2：assistant（非 user，attachment 必须 not-found）。
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
		}),
		// e3：坏 base64。
		JSON.stringify({
			type: "message",
			id: "e3",
			parentId: "e2",
			message: { role: "user", content: [{ type: "image", data: "!not-base64!", mimeType: "image/gif" }] },
		}),
		// e4：坏 mime。
		JSON.stringify({
			type: "message",
			id: "e4",
			parentId: "e3",
			message: { role: "user", content: [{ type: "image", data: PNG_BASE64, mimeType: "text/html" }] },
		}),
		// e5：恰好 4 MiB（边界，应成功）。
		JSON.stringify({
			type: "message",
			id: "e5",
			parentId: "e4",
			message: { role: "user", content: [{ type: "image", data: RAW_AT_LIMIT, mimeType: "image/png" }] },
		}),
		// e6：4 MiB + 1 字节（超限，且先被 base64 预检拦住）。
		JSON.stringify({
			type: "message",
			id: "e6",
			parentId: "e5",
			message: { role: "user", content: [{ type: "image", data: RAW_OVER_LIMIT, mimeType: "image/png" }] },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

describe("attachment (runtime)", () => {
	it("bridge descriptor file bypasses the SDK index and stale live manager", async () => {
		const sessionDir = tempDir("pi-mgw-att-index-");
		const externalDir = tempDir("pi-mgw-att-native-");
		writeImageFixtureSession(sessionDir);
		writeImageFixtureSession(externalDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		const externalFile = join(externalDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		const data = Buffer.from("native image").toString("base64");
		writeFileSync(externalFile, readFileSync(externalFile, "utf8").replaceAll(PNG_BASE64, data));
		const got = await runtime.attachment(SESSION_ID, "e1", 0, externalFile);
		assert.equal(got.dataBase64, data);
	});

	it("bridge file reads do not create SDK sessions and reject a different header", async () => {
		const sessionDir = tempDir("pi-mgw-att-empty-");
		const externalDir = tempDir("pi-mgw-att-outside-");
		writeImageFixtureSession(externalDir);
		const { runtime, sessions } = fakeRuntime({ sessionDir });
		await runtime.listSessions(); // cache an empty SDK index before native Pi writes
		const file = join(externalDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		const got = await runtime.attachment(SESSION_ID, "e1", 0, file);
		assert.equal(got.dataBase64, PNG_BASE64);
		assert.equal(sessions.size, 0);
		await assert.rejects(runtime.attachment("different-session", "e1", 0, file), SessionNotFoundError);
		await assert.rejects(
			runtime.attachment(SESSION_ID, "e1", 0, join(externalDir, "missing.jsonl")),
			SessionNotFoundError,
		);
		await assert.rejects(runtime.attachment(SESSION_ID, "e1", 0, externalDir), SessionNotFoundError);
		await assert.rejects(runtime.attachment(SESSION_ID, "e1", 0, "relative.jsonl"), SessionNotFoundError);
		assert.equal(sessions.size, 0);
	});

	it("无 live 句柄：从文件视图直读，多图索引分别取回，bytes 与解码一致", async () => {
		const sessionDir = tempDir("pi-mgw-att-");
		writeImageFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		// 刻意不 openSession：纯文件视图路径。
		const zero = await runtime.attachment(SESSION_ID, "e1", 0);
		assert.equal(zero.mediaType, "image/png");
		assert.equal(zero.bytes, Buffer.from(PNG_BASE64, "base64").length);
		assert.equal(zero.dataBase64, PNG_BASE64);
		const one = await runtime.attachment(SESSION_ID, "e1", 1);
		assert.equal(one.mediaType, "image/jpeg");
		assert.equal(one.bytes, Buffer.from("jpeg-bytes-2").length);
	});

	it("live 未落盘可读：entry 只在 live SessionManager 内存里也能取", async () => {
		const sessionDir = tempDir("pi-mgw-att-");
		writeImageFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID);
		// 模拟 pi 已 append 进内存但尚未 flush 到磁盘：patch live 的 getEntry。
		const handles = (runtime as unknown as { handles: Map<string, { sessionManager: SessionManager }> }).handles;
		const live = handles.get(SESSION_ID) as { sessionManager: SessionManager } | undefined;
		const original = live?.sessionManager.getEntry.bind(live.sessionManager);
		assert.ok(live && original);
		live.sessionManager.getEntry = (id: string) =>
			id === "e-live"
				? ({
						type: "message",
						id: "e-live",
						parentId: "e2",
						timestamp: new Date().toISOString(),
						message: { role: "user", content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
					} as never)
				: original(id);
		try {
			const got = await runtime.attachment(SESSION_ID, "e-live", 0);
			assert.equal(got.bytes, Buffer.from(PNG_BASE64, "base64").length);
			assert.equal(got.mediaType, "image/png");
		} finally {
			live.sessionManager.getEntry = original;
		}
	});

	it("live 已加载但另一 SessionManager 从文件新增图片：history 能见后 attachment 也能取", async () => {
		const sessionDir = tempDir("pi-mgw-att-");
		writeImageFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		await runtime.openSession(SESSION_ID); // live 内存快照停在 e6
		// 桌面 pi 直接追加文件（live 不知道）。
		const appended = {
			type: "message",
			id: "e9",
			parentId: "e5",
			message: { role: "user", content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
		};
		appendFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), `${JSON.stringify(appended)}\n`);
		const page = await runtime.history(SESSION_ID, undefined, 100, false);
		assert.ok(page.entryIds.includes("e9"), "history（文件视图）必须先可见新条目");
		const got = await runtime.attachment(SESSION_ID, "e9", 0);
		assert.equal(got.bytes, Buffer.from(PNG_BASE64, "base64").length);
	});

	it("错误会话条目 / 未知会话 / 非 user / 越界索引均明确失败", async () => {
		const sessionDir = tempDir("pi-mgw-att-");
		writeImageFixtureSession(sessionDir);
		// 第二个会话：条目 id 空间独立，拿它的 entryId 来问第一个会话。
		const otherId = "99999999-8888-7777-6666-555555555555";
		writeFileSync(
			join(sessionDir, `2026-01-02T00-00-00-000Z_${otherId}.jsonl`),
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: otherId,
					timestamp: "2026-01-02T00:00:00.000Z",
					cwd: "/tmp/fake-project",
				}),
				JSON.stringify({
					type: "message",
					id: "d1",
					parentId: null,
					message: { role: "user", content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] },
				}),
			].join("\n")}\n`,
		);
		const { runtime } = fakeRuntime({ sessionDir });

		await assert.rejects(runtime.attachment(SESSION_ID, "d1", 0), AttachmentNotFoundError);
		await assert.rejects(runtime.attachment("nope-nope", "e1", 0), SessionNotFoundError);
		await assert.rejects(runtime.attachment(SESSION_ID, "no-such-entry", 0), AttachmentNotFoundError);
		// 非 user：assistant 条目。
		await assert.rejects(runtime.attachment(SESSION_ID, "e2", 0), AttachmentNotFoundError);
		// 越界：e1 只有 2 张图（0/1），2 越界。
		await assert.rejects(runtime.attachment(SESSION_ID, "e1", 2), AttachmentNotFoundError);
	});

	it("原始 4MiB 边界成功，+1 字节超限；坏 base64 与坏 mime 归 attachment-invalid", async () => {
		const sessionDir = tempDir("pi-mgw-att-");
		writeImageFixtureSession(sessionDir);
		const { runtime } = fakeRuntime({ sessionDir });
		const edge = await runtime.attachment(SESSION_ID, "e5", 0);
		assert.equal(edge.bytes, ATTACHMENT_MAX_RAW_BYTES);
		await assert.rejects(runtime.attachment(SESSION_ID, "e6", 0), AttachmentTooLargeError);
		await assert.rejects(runtime.attachment(SESSION_ID, "e3", 0), AttachmentInvalidError);
		await assert.rejects(runtime.attachment(SESSION_ID, "e4", 0), AttachmentInvalidError);
	});
});

it("prompt snapshot ACK cannot replay older lifecycle events after it", async () => {
	const sessionDir = tempDir("pi-mgw-prompt-order-");
	writeFixtureSession(sessionDir);
	const { runtime, sessions } = fakeRuntime({ sessionDir });
	const handle = await runtime.openSession(SESSION_ID);
	const session = expectSession(sessions, SESSION_ID);
	const frames: Array<Record<string, unknown>> = [];
	handle.attach((frame) => frames.push(frame));
	session.onPrompt = async (s, _text, options) => {
		s.isStreaming = true;
		s.emit({ type: "agent_start" } as AgentSessionEvent);
		options.preflightResult?.("started");
		await Promise.resolve();
		s.isStreaming = false;
		s.emit({ type: "agent_settled" } as AgentSessionEvent);
	};
	await runtime.prompt(handle, "fast", "prompt", [], (acceptance) => {
		frames.push({ kind: "sent", ...acceptance.state });
	});
	await flushEvents();
	let running = false;
	for (const frame of frames) {
		if (frame.kind === "sent") running = frame.isStreaming === true;
		else if ((frame.event as { type?: string }).type === "agent_start") running = true;
		else if ((frame.event as { type?: string }).type === "agent_settled") running = false;
	}
	assert.equal(running, false);
	assert.equal(frames.filter((frame) => frame.kind === "sent").length, 1);
});

describe("PiRuntime: public custom message identity", () => {
	for (const order of ["before", "after"] as const) {
		it(`binds equal custom texts by SDK append order (${order} persistence)`, async () => {
			const sessionDir = tempDir("pi-mgw-custom-id-");
			writeFixtureSession(sessionDir);
			let manager!: SessionManager;
			let session!: FakeSession;
			const runtime = new PiRuntime({
				sessionDir,
				enabledModelsLoader: () => undefined,
				sessionFactory: async ({ sessionManager }) => {
					manager = sessionManager;
					// 历史同文不得被拿来匹配新消息。
					manager.appendCustomMessageEntry("notice", "same", true);
					session = new FakeSession(sessionManager);
					return session;
				},
			});
			runtimes.push(runtime);
			const handle = await runtime.openSession(SESSION_ID);
			const frames: Array<Record<string, unknown>> = [];
			handle.attach((frame) => frames.push(frame));
			const ids: string[] = [];
			for (const display of [true, false, true]) {
				const message = { role: "custom", customType: "compaction", content: "same", display, timestamp: 1 };
				if (order === "before")
					ids.push(manager.appendCustomMessageEntry(message.customType, message.content, display));
				session.emit({ type: "message_start", message } as unknown as AgentSessionEvent);
				if (order === "after") await flushEvents(); // 独立start批次不能占走未来身份。
				session.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				if (order === "after") ids.push(manager.appendCustomMessageEntry(message.customType, message.content, display));
			}
			await flushEvents();
			const ends = frames.filter((frame) => (frame.event as { type: string }).type === "message_end");
			assert.deepEqual(
				ends.map((frame) => frame.entryId),
				ids,
			);
			assert.equal(new Set(ids).size, 3);
		});
	}

	it("does not guess custom IDs if extra unobserved entries make pairing ambiguous", async () => {
		const sessionDir = tempDir("pi-mgw-custom-ambiguous-");
		writeFixtureSession(sessionDir);
		let manager!: SessionManager;
		let session!: FakeSession;
		const runtime = new PiRuntime({
			sessionDir,
			enabledModelsLoader: () => undefined,
			sessionFactory: async ({ sessionManager }) => {
				manager = sessionManager;
				session = new FakeSession(manager);
				return session;
			},
		});
		runtimes.push(runtime);
		const handle = await runtime.openSession(SESSION_ID);
		const frames: Array<Record<string, unknown>> = [];
		handle.attach((frame) => frames.push(frame));
		manager.appendCustomMessageEntry("notice", "same", true);
		manager.appendCustomMessageEntry("notice", "same", true);
		session.emit({
			type: "message_end",
			message: { role: "custom", customType: "notice", content: "same", display: true },
		} as unknown as AgentSessionEvent);
		await flushEvents();
		assert.equal(frames.length, 1);
		assert.equal(frames[0].entryId, undefined);
	});
});

it("real SDK idle custom messages retain unique live entry identities", () => {
	const root = tempDir("pi-mgw-real-custom-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				synthetic: {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "synthetic-test-key",
					models: [
						{
							id: "test",
							name: "test",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 4096,
							maxTokens: 256,
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["synthetic/test"] }));
	const runtimeModule = new URL("../src/pi-runtime.ts", import.meta.url).href;
	const script = `
        import assert from 'node:assert/strict';
        import { PiRuntime } from ${JSON.stringify(runtimeModule)};
        globalThis.fetch = async () => { throw new Error('no model or network calls in this test'); };
        const runtime = new PiRuntime({ agentDir: process.env.PI_CODING_AGENT_DIR,
            sessionDir: process.env.PI_CODING_AGENT_DIR + '/sessions' });
        try {
            const handle = await runtime.createSession(process.cwd());
            const frames = [];
            handle.attach(frame => frames.push(frame));
            for (const display of [true, false, true]) {
                await handle.session.sendCustomMessage({ customType: 'compaction', content: 'same', display }, { triggerTurn: false });
            }
            await new Promise(resolve => setImmediate(resolve));
            const entries = handle.session.sessionManager.getEntries().filter(entry => entry.type === 'custom_message');
            const ends = frames.filter(frame => frame.event.type === 'message_end');
            assert.deepEqual(ends.map(frame => frame.entryId), entries.map(entry => entry.id));
            assert.equal(new Set(ends.map(frame => frame.entryId)).size, 3);
            console.log(JSON.stringify({ messages: ends.length, uniqueIds: 3 }));
        } finally { runtime.disposeAll(); }
    `;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.deepEqual(JSON.parse(output), { messages: 3, uniqueIds: 3 });
});

it("ordinary token batches never scan full session entries for custom identities", async () => {
	const sessionDir = tempDir("pi-mgw-no-token-scan-");
	writeFixtureSession(sessionDir);
	let reads = 0;
	let session!: FakeSession;
	const runtime = new PiRuntime({
		sessionDir,
		enabledModelsLoader: () => undefined,
		sessionFactory: async ({ sessionManager }) => {
			const getEntries = sessionManager.getEntries.bind(sessionManager);
			sessionManager.getEntries = () => {
				reads += 1;
				return getEntries();
			};
			session = new FakeSession(sessionManager);
			return session;
		},
	});
	runtimes.push(runtime);
	const handle = await runtime.openSession(SESSION_ID);
	const frames: Array<Record<string, unknown>> = [];
	handle.attach((frame) => frames.push(frame));
	reads = 0;
	for (let i = 0; i < 5; i++) {
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "token" },
		} as unknown as AgentSessionEvent);
		await flushEvents();
	}
	assert.equal(frames.length, 5);
	assert.equal(reads, 0);
});

it("entry-copy 对尚未落盘的 live 会话报条目不存在，而不是会话不存在", async () => {
	const { runtime } = fakeRuntime();
	const handle = await runtime.createSession(tempDir("pi-entry-live-"));
	await assert.rejects(runtime.entryCopy(handle.session.sessionId, "absent"), EntryNotFoundError);
});

it("首条会话消息落盘前的tree查询不丢有效live标签钉子", async () => {
	const { runtime, sessions } = fakeRuntime();
	const handle = await runtime.createSession(tempDir("pi-label-unflushed-"));
	const id = handle.session.sessionId;
	const session = expectSession(sessions, id);
	const internals = runtime as unknown as {
		manualLeafIds: Map<string, string>;
		handles: Map<string, { sessionManager: SessionManager }>;
	};
	const manager = internals.handles.get(id)!.sessionManager;
	const target = manager.appendModelChange("fixture", "m1");
	const label = await runtime.putLabel(id, target, "待消息");
	assert.ok(session.sessionFile);
	// SDK1.0.4以第一条user或assistant为落盘门槛，元数据和标签不会触发首次落盘。
	assert.equal(existsSync(session.sessionFile), false);
	await runtime.tree(id);
	assert.equal(internals.manualLeafIds.get(id), label.labelEntryId);
	session.emitMessageEndThenAppend({ role: "user", content: "第一条消息" });
	const messageId = session.appendedEntryIds.at(-1)!;
	assert.equal(existsSync(session.sessionFile), true);
	assert.equal((await runtime.tree(id)).leafId, messageId);
});

describe("manual compact invocation admission", () => {
	it("coalesces startup retries and publishes an idle state after completion", async () => {
		const { runtime, sessions } = fakeRuntime();
		const handle = await runtime.createSession(tempDir("pi-compact-project-"));
		const id = handle.session.sessionId;
		const session = expectSession(sessions, id);
		let complete!: () => void;
		session.compact = () => {
			session.compactCalls.push(undefined);
			return new Promise<void>((resolve) => {
				complete = resolve;
			});
		};
		const frames: Record<string, unknown>[] = [];
		handle.attach((frame) => frames.push(frame));
		assert.equal((await runtime.beginCompact(id)).isCompacting, true);
		assert.equal(session.isCompacting, false); // SDK尚在等待abort，不伪造原生状态。
		assert.equal((await runtime.state(id)).isCompacting, true);
		assert.equal((await runtime.beginCompact(id)).isCompacting, true);
		assert.equal(session.compactCalls.length, 1);
		await assert.rejects(runtime.restartSession(id));
		complete();
		await flushEvents();
		assert.equal((await runtime.state(id)).isCompacting, false);
		assert.ok(frames.some((f) => f.kind === "compact-finished" && f.isCompacting === false));
		assert.equal((await runtime.beginCompact(id)).isCompacting, true);
		assert.equal(session.compactCalls.length, 2);
		complete();
		await flushEvents();
	});

	it("releases an invocation that fails before SDK lifecycle events", async () => {
		const { runtime, sessions } = fakeRuntime();
		const handle = await runtime.createSession(tempDir("pi-compact-failure-"));
		const session = expectSession(sessions, handle.session.sessionId);
		const frames: Record<string, unknown>[] = [];
		handle.attach((frame) => frames.push(frame));
		session.compact = async () => {
			throw new Error("synthetic startup failure");
		};
		assert.equal((await runtime.beginCompact(session.sessionId)).isCompacting, true);
		await flushEvents();
		assert.equal((await runtime.state(session.sessionId)).isCompacting, false);
		assert.ok(frames.some((f) => f.kind === "compact-finished" && f.isCompacting === false));
		session.compact = async () => {
			session.compactCalls.push(undefined);
		};
		await runtime.beginCompact(session.sessionId);
		await flushEvents();
		assert.equal(session.compactCalls.length, 1);
	});
});
