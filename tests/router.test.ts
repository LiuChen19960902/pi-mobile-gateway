import type { PromptOptions } from "@earendil-works/pi-coding-agent";
// End-to-end business-frame tests: a real data plane + router wired to a
// fake-backed PiRuntime, driven over a real loopback WebSocket. No real
// model, no real ~/.pi (the sessions dir is a temp dir with crafted files).

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import WebSocket, { type ClientOptions } from "ws";
import { createRegistry } from "../src/devices.ts";
import { type ModelRegistryLike, PiRuntime, type PiSessionLike } from "../src/pi-runtime.ts";
import { PiProviderStore } from "../src/pi-store.ts";
import { ProviderStatusStore } from "../src/provider-test.ts";
import { connectClient } from "../src/router.ts";
import { startDataPlane } from "../src/server.ts";

const dirs: string[] = [];
const runtimes: PiRuntime[] = [];
const planes: Array<{ close: () => Promise<void> }> = [];

after(async () => {
	for (const plane of planes) await plane.close();
	for (const runtime of runtimes) runtime.disposeAll();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

// ---------------------------------------------------------------------------
// Fake sessions + fixtures
// ---------------------------------------------------------------------------

class FakeSession implements PiSessionLike {
	sessionId: string;
	sessionFile: string | undefined;
	isStreaming = false;
	isCompacting = false;
	model = { id: "m1", provider: "p1" };
	thinkingLevel = "medium";
	disposed = false;
	aborted = false;
	promptCalls: Array<{ text: string; mode?: string; images?: unknown[] }> = [];
	modelSetCalls: Array<{ model: unknown; persist?: boolean }> = [];
	thinkingLevelCalls: string[] = [];
	sessionNameCalls: string[] = [];
	compactCalls: number = 0;
	private listeners = new Set<(event: AgentSessionEvent) => void>();

	readonly sessionManager: SessionManager;
	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
		this.sessionId = sessionManager.getSessionId();
		this.sessionFile = sessionManager.getSessionFile();
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
		options?: {
			streamingBehavior?: "steer" | "followUp";
			images?: unknown[];
			preflightResult?: PromptOptions["preflightResult"];
		},
	): Promise<void> {
		this.promptCalls.push({
			text,
			mode: options?.streamingBehavior,
			// 仅在有图时才带上键：不扰动既有 text/mode 断言。
			...(options?.images !== undefined ? { images: options?.images } : {}),
		});
		// Default script: accept, stream one event, finish.
		options?.preflightResult?.("started");
		this.isStreaming = true;
		this.emit({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
		this.emit({ type: "turn_start" } as AgentSessionEvent);
		this.isStreaming = false;
		this.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
		return Promise.resolve();
	}

	abort(): Promise<void> {
		this.aborted = true;
		this.isStreaming = false;
		return Promise.resolve();
	}

	setModel(model: unknown, options?: { persist?: boolean }): Promise<void> {
		this.modelSetCalls.push({ model, persist: options?.persist });
		const record = model as { id?: string; provider?: string } | undefined;
		this.model = { id: String(record?.id), provider: String(record?.provider) };
		return Promise.resolve();
	}

	setThinkingLevel(level: string): void {
		this.thinkingLevelCalls.push(level);
		this.thinkingLevel = level;
	}

	setSessionName(name: string): void {
		this.sessionNameCalls.push(name);
	}

	compact(): Promise<void> {
		this.compactCalls += 1;
		return Promise.resolve();
	}

	steeringMessages: string[] = [];
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

	leafId: string | null = null;
	getLeafId(): string | null {
		return this.leafId;
	}

	/** commands 帧三源：测试按需挂载（缺省即降级为空清单）。 */
	extensionRunner?: {
		getRegisteredCommands(): Array<{
			invocationName: string;
			description?: string;
			sourceInfo?: { scope?: string; origin?: string };
		}>;
	};
	promptTemplates?: Array<{
		name: string;
		description: string;
		argumentHint?: string;
		sourceInfo?: { scope?: string; origin?: string };
	}>;
	resourceLoader?: {
		getSkills(): {
			skills: Array<{
				name: string;
				description: string;
				disableModelInvocation: boolean;
				sourceInfo?: { scope?: string; origin?: string };
			}>;
		};
	};

	getContextUsage() {
		return { percent: 42, contextWindow: 100_000, tokens: 42_000 };
	}

	dispose(): void {
		this.disposed = true;
	}
}

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function writeFixtureSession(sessionDir: string, cwd = "/tmp/fake-project"): void {
	// SessionManager.listAll(dir) scans .jsonl files directly inside dir, so
	// the fixture goes straight into the (project-level) sessions dir.
	const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({ type: "model_change", id: "e0", parentId: null, provider: "fp", modelId: "fm" }),
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

/** Look up a fake session, failing the test if it was never created. */
function expectSession(sessions: Map<string, FakeSession>, sessionId: string): FakeSession {
	const session = sessions.get(sessionId);
	if (!session) throw new Error(`fake session not created: ${sessionId}`);
	return session;
}

// ---------------------------------------------------------------------------
// attachment（§4.22）集成测试共用样本
// ---------------------------------------------------------------------------

const PNG_BASE64_ROUTER =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	baseUrl: string;
	sessions: Map<string, FakeSession>;
	runtime: PiRuntime;
	connectPaired(): Promise<TestClient>;
	/** Internal router log lines (error details that must not reach clients). */
	logs: string[];
}

interface TestClient {
	ws?: WebSocket;
	status?: number;
	send(data: string | Buffer): void;
	nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
	close(): void;
}

function connect(url: string, options: ClientOptions & { protocols?: string[] }): Promise<TestClient> {
	return new Promise((resolve) => {
		const { protocols, ...clientOptions } = options;
		const ws = new WebSocket(url, protocols ?? [], clientOptions);
		const buffered: Array<Record<string, unknown>> = [];
		const waiters: Array<(frame: Record<string, unknown>) => void> = [];
		ws.on("message", (data) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
			} catch {
				return;
			}
			const waiter = waiters.shift();
			if (waiter) waiter(frame);
			else buffered.push(frame);
		});
		const nextMessage = (timeoutMs = 2_000): Promise<Record<string, unknown>> =>
			new Promise((resolveWaiter, rejectWaiter) => {
				const pending = buffered.shift();
				if (pending) {
					resolveWaiter(pending);
					return;
				}
				const timer = setTimeout(() => rejectWaiter(new Error("timed out waiting for frame")), timeoutMs);
				waiters.push((frame) => {
					clearTimeout(timer);
					resolveWaiter(frame);
				});
			});
		const send = (data: string | Buffer): void => ws.send(data);
		let settled = false;
		const finish = (client: TestClient) => {
			if (settled) return;
			settled = true;
			resolve(client);
		};
		ws.on("open", () => finish({ ws, send, nextMessage, close: () => ws.close() }));
		ws.on("unexpected-response", (_request, response) =>
			finish({ send, nextMessage, close: () => {}, status: response.statusCode }),
		);
		ws.on("error", () => finish({ send, nextMessage, close: () => {} }));
	});
}

/** Scripted model catalog: no real ~/.pi, deterministic ordering + levels. */
const TEST_MODELS = [
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
		provider: "p2",
		id: "m2",
		name: "Model Two",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 16_000,
	},
];

function providerIds(frame: Record<string, unknown>): string[] {
	return ((frame.groups as Array<Record<string, unknown>> | undefined) ?? []).map((group) => String(group.provider));
}

function testModelRegistry(): ModelRegistryLike {
	return {
		getAvailable: () => Promise.resolve(TEST_MODELS),
		getModel: (provider, modelId) => TEST_MODELS.find((model) => model.provider === provider && model.id === modelId),
	};
}

it("model scope wire save is explicit, correlated, concrete and rejects stale snapshots", async () => {
	let patterns = ["p1/*:high", "removed/*"];
	const harness = await startHarness({
		enabledModelsLoader: () => patterns,
		enabledModelsSetter: (next) => {
			patterns = next;
		},
	});
	const client = await harness.connectPaired();
	try {
		client.send(JSON.stringify({ type: "model-scope" }));
		const loaded = await client.nextMessage();
		assert.equal(loaded.kind, "model-scope");
		const scope = loaded.scope as {
			patterns: string[];
			selected: Array<{ provider: string; modelId: string; thinkingLevel?: string }>;
		};
		assert.deepEqual(patterns, ["p1/*:high", "removed/*"], "reading never writes scope");
		client.send(
			JSON.stringify({
				type: "model-scope-put",
				scopeRequestId: "save-1",
				expectedPatterns: scope.patterns,
				models: [scope.selected[0]],
				preserveUnmatched: true,
				reset: false,
			}),
		);
		const saved = await client.nextMessage();
		assert.equal(saved.kind, "model-scope-saved");
		assert.equal(saved.scopeRequestId, "save-1");
		assert.deepEqual(patterns, ["p1/m1:high", "removed/*"]);
		client.send(
			JSON.stringify({
				type: "model-scope-put",
				scopeRequestId: "save-2",
				expectedPatterns: scope.patterns,
				models: [scope.selected[0]],
				preserveUnmatched: false,
				reset: false,
			}),
		);
		const stale = await client.nextMessage();
		assert.equal(stale.code, "scope-conflict");
		assert.equal(stale.scopeRequestId, "save-2");
		assert.equal(stale.requestType, "model-scope-put");
		assert.deepEqual(patterns, ["p1/m1:high", "removed/*"]);
		client.send(
			JSON.stringify({
				type: "model-scope-put",
				scopeRequestId: "save-3",
				expectedPatterns: patterns,
				models: [],
				preserveUnmatched: false,
				reset: true,
			}),
		);
		assert.equal((await client.nextMessage()).kind, "model-scope-saved");
		assert.deepEqual(patterns, []);
	} finally {
		client.close();
	}
});

async function startHarness(
	options: {
		fixtureCwd?: string;
		extraFixture?: (sessionDir: string) => void;
		providerStore?: PiProviderStore;
		providerStatusStore?: ProviderStatusStore;
		providerActive?: (providerId: string) => boolean;
		modelRegistry?: ModelRegistryLike;
		enabledModelsLoader?: () => string[] | undefined;
		enabledModelsAppender?: (pattern: string) => void;
		enabledModelsRemover?: (pattern: string) => void;
		enabledModelsSetter?: (patterns: string[]) => void;
	} = {},
): Promise<Harness> {
	const sessionDir = tempDir("pi-mgw-router-sessions-");
	writeFixtureSession(sessionDir, options.fixtureCwd);
	options.extraFixture?.(sessionDir);
	const sessions = new Map<string, FakeSession>();
	const runtime = new PiRuntime({
		agentDir: tempDir("pi-mgw-router-agent-"),
		sessionDir,
		modelRegistry: options.modelRegistry ?? testModelRegistry(),
		providerActive: options.providerActive,
		enabledModelsLoader: options.enabledModelsLoader ?? (() => undefined),
		enabledModelsAppender: options.enabledModelsAppender,
		enabledModelsRemover: options.enabledModelsRemover,
		enabledModelsSetter: options.enabledModelsSetter,
		sessionFactory: async ({ sessionManager }) => {
			const session = new FakeSession(sessionManager);
			sessions.set(session.sessionId, session);
			return session;
		},
	});
	runtimes.push(runtime);
	const logs: string[] = [];
	const registry = createRegistry(join(tempDir("pi-mgw-router-devices-"), "devices.json"));
	const dataPlane = await startDataPlane({
		registry,
		port: 0,
		host: "127.0.0.1",
		onClient: (send) =>
			connectClient(runtime, send, {
				log: (message) => logs.push(message),
				providerStore:
					options.providerStore ?? new PiProviderStore({ path: join(tempDir("pi-mgw-router-models-"), "models.json") }),
				providerStatusStore:
					options.providerStatusStore ??
					new ProviderStatusStore(join(tempDir("pi-mgw-router-status-"), "provider-status.json")),
			}),
	});
	planes.push(dataPlane);
	const baseUrl = `ws://127.0.0.1:${dataPlane.port}/ws/mobile`;

	// Pair once; afterwards reconnect with the minted token (the pairing
	// code is single-use by design).
	let token: string | undefined;
	const connectPaired = async (): Promise<TestClient> => {
		const options =
			token === undefined
				? (() => {
						const pairing = registry.createPairing("测试手机");
						return {
							protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
							headers: { "x-pi-device-id": "install-router-1" },
						};
					})()
				: {
						protocols: ["pi-mobile-v1"],
						headers: { authorization: `Bearer ${token}`, "x-pi-device-id": "install-router-1" },
					};
		const client = await connect(baseUrl, options);
		assert.ok(client.ws, `connect failed: ${client.status ?? "unknown"}`);
		if (token === undefined) {
			const pairedFrame = await client.nextMessage();
			assert.equal(pairedFrame.kind, "paired");
			const minted = pairedFrame.token;
			assert.equal(typeof minted, "string");
			token = minted as string;
		}
		const hello = await client.nextMessage();
		assert.equal(hello.kind, "hello");
		return client;
	};
	// Mint the token eagerly so every later connectPaired reuses it.
	const bootstrap = await connectPaired();
	bootstrap.close();
	return { baseUrl, sessions, runtime, connectPaired, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("router: sessions / history / state", () => {
	it("lists sessions", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "sessions" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "sessions");
		const items = response.items as Array<Record<string, unknown>>;
		assert.equal(items.length, 1);
		assert.equal(items[0].id, SESSION_ID);
		assert.equal(items[0].running, false);
		client.close();
	});

	it("serves history pages with cursors and derived state", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "history", sessionId: SESSION_ID }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "history");
		assert.deepEqual(response.entryIds, ["e1", "e2"]);
		assert.equal(response.hasMore, false);
		assert.equal(response.oldestEntryId, "e1");
		// 文件视图最新叶子：客户端用它比对活跃链尾，落后即提示"跳到最新"。
		assert.equal(response.latestEntryId, "e2");
		assert.deepEqual(response.model, { provider: "fp", modelId: "fm" });
		assert.equal(response.isStreaming, false);
		const messages = response.messages as Array<Record<string, unknown>>;
		assert.equal(messages[0].role, "user");
		client.close();
	});

	it("reports session-not-found for unknown sessions", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "history", sessionId: "nope" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "session-not-found");
		assert.equal(response.requestType, "history");
		client.close();
	});

	it("rejects bad history params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		for (const frame of [
			{ type: "history" },
			{ type: "history", sessionId: SESSION_ID, limit: 0 },
			{ type: "history", sessionId: SESSION_ID, beforeEntryId: "" },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, "bad-request");
		}
		client.close();
	});

	it("serves live state once a session is loaded", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		client.send(JSON.stringify({ type: "state", sessionId: SESSION_ID }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "state");
		assert.deepEqual(response.model, { provider: "p1", modelId: "m1" });
		assert.deepEqual(response.contextUsage, { percent: 42, contextWindow: 100_000, tokens: 42_000 });
		client.close();
	});
});

describe("router: model catalog and switching", () => {
	it("serves the available catalog grouped by provider", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "models" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "models");
		const groups = response.groups as Array<Record<string, unknown>>;
		assert.deepEqual(
			groups.map((group) => group.provider),
			["p1", "p2"],
		);
		const reasoningModels = groups[0].models as Array<Record<string, unknown>>;
		assert.equal(reasoningModels[0].id, "m1");
		assert.equal(reasoningModels[0].contextWindow, 100_000);
		// pi-ai parity: xhigh/max exist only when the model maps them explicitly.
		assert.deepEqual(reasoningModels[0].thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
		const plainModels = groups[1].models as Array<Record<string, unknown>>;
		assert.deepEqual(plainModels[0].thinkingLevels, ["off"]);
		assert.deepEqual(plainModels[0].input, ["text", "image"]);
		client.close();
	});

	it("switches the session model and applies the thinking level after it", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "set-model",
				sessionId: SESSION_ID,
				provider: "p2",
				modelId: "m2",
				thinkingLevel: "high",
			}),
		);
		const response = await client.nextMessage();
		assert.equal(response.kind, "model-set");
		assert.deepEqual(response.model, { provider: "p2", modelId: "m2" });
		assert.equal(response.thinkingLevel, "high");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		assert.equal(session.modelSetCalls.length, 1);
		assert.equal(session.modelSetCalls[0].persist, false);
		assert.equal((session.modelSetCalls[0].model as { id: string }).id, "m2");
		assert.deepEqual(session.thinkingLevelCalls, ["high"]);
		client.close();
	});

	it("renames the session and reflects it in sessions listing", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "name", sessionId: SESSION_ID, name: "新标题" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "session-named");
		assert.equal(response.sessionId, SESSION_ID);
		assert.equal(response.name, "新标题");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		assert.deepEqual(session.sessionNameCalls, ["新标题"]);
		client.close();
	});

	it("returns the session tree and projects entry previews", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		// runtime.state/tree 都是离线投影，不 buildSession；先 set-model 打开。
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		const opened = await client.nextMessage();
		assert.equal(opened.kind, "model-set");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		client.send(JSON.stringify({ type: "tree", sessionId: SESSION_ID }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "tree");
		assert.equal(response.sessionId, SESSION_ID);
		// leafId 从真实 SessionManager 取（pi realLeafId 语义）：fixture 叶子是 e2。
		assert.equal(response.leafId, "e2");
		assert.ok(Array.isArray(response.nodes));
		client.close();
	});

	it("projects validated Pi tree views end to end and preserves legacy requests", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		const view = { filter: "all", search: "USER", foldedIds: [] };
		client.send(JSON.stringify({ type: "tree", sessionId: SESSION_ID, view }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "tree");
		assert.deepEqual(response.view, view);
		assert.ok(Array.isArray(response.nodes));
		assert.equal(response.nodes.length, 1);
		assert.equal(response.nodes[0].role, "user");
		assert.equal(response.selectedId, response.nodes[0].id);
		assert.ok(response.nodes[0].displayText.startsWith("user: "));
		client.send(JSON.stringify({ type: "tree", sessionId: SESSION_ID, view: { ...view, filter: "bad" } }));
		assert.equal((await client.nextMessage()).code, "bad-request");
		client.send(JSON.stringify({ type: "tree", sessionId: SESSION_ID }));
		const legacy = await client.nextMessage();
		assert.equal(legacy.view, undefined);
		assert.equal(legacy.selectedId, undefined);
		client.close();
	});

	it("rejects tree without sessionId", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "tree" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "bad-request");
		client.close();
	});

	it("switches branch with abort, queued restore and editor text", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		const opened = await client.nextMessage();
		assert.equal(opened.kind, "model-set");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		session.isStreaming = true;
		session.steeringMessages = ["继续写"];
		session.onNavigateTree = async (_s, targetId) => ({
			editorText: targetId === "e1" ? "之前的问题" : undefined,
		});
		// 当前叶子（真实 sessionManager 的 e2）→ alreadyAt 短路
		client.send(JSON.stringify({ type: "switch-branch", sessionId: SESSION_ID, entryId: "e2" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "branch-switched");
		assert.equal(response.alreadyAt, true);
		assert.equal(response.entryId, "e2");
		// 换个目标（非当前叶子）：应 abort + navigate，带排队消息
		client.send(JSON.stringify({ type: "switch-branch", sessionId: SESSION_ID, entryId: "e1" }));
		const response2 = await client.nextMessage();
		assert.equal(response2.kind, "branch-switched");
		assert.equal(response2.alreadyAt, false);
		assert.deepEqual(response2.queued, ["继续写"]);
		assert.equal(session.aborted, true);
		assert.equal(session.navigateTreeCalls.length, 1);
		assert.deepEqual(session.navigateTreeCalls[0].options, { summarize: false });
		client.close();
	});

	it("rejects switch-branch while compacting", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		const opened = await client.nextMessage();
		assert.equal(opened.kind, "model-set");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		session.isCompacting = true;
		client.send(JSON.stringify({ type: "switch-branch", sessionId: SESSION_ID, entryId: "leaf-1" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "bad-request");
		client.close();
	});

	it("rejects bad switch-branch params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		for (const frame of [
			{ type: "switch-branch" },
			{ type: "switch-branch", sessionId: SESSION_ID },
			{ type: "switch-branch", sessionId: SESSION_ID, entryId: "" },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, "bad-request", JSON.stringify(frame));
		}
		client.close();
	});

	// -- tree 动作：entry-copy / label-put（PROTOCOL §4.26–§4.27）--------------

	it("entry-copy 回整条 entry 全文（不是 preview），并如实报无可复制文本", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		// 只读端点：不先 set-model / subscribe 也能取（文件视图回落）。
		client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "e1" }));
		const user = await client.nextMessage();
		assert.equal(user.kind, "entry-copy");
		assert.equal(user.sessionId, SESSION_ID);
		assert.equal(user.entryId, "e1");
		assert.equal(user.text, "hello");
		assert.equal(user.bytes, Buffer.byteLength("hello", "utf8"));
		assert.equal(user.oversized, undefined);
		client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "e2" }));
		const assistant = await client.nextMessage();
		assert.equal(assistant.text, "hi there");
		// 簿记条目（model_change）没有可复制文本：专用错误码 + 完整关联，不造占位。
		client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "e0" }));
		const empty = await client.nextMessage();
		assert.equal(empty.kind, "error");
		assert.equal(empty.code, "entry-copy-empty");
		assert.equal(empty.requestType, "entry-copy");
		assert.equal(empty.sessionId, SESSION_ID);
		assert.equal(empty.entryId, "e0");
		client.close();
	});

	it("entry-copy 超限只报 oversized+bytes，不静默截断当全文", async () => {
		// 600 KiB 正文 > ENTRY_COPY_MAX_BYTES(512 KiB)：直接写 fixture，走真实文件视图。
		const huge = "长".repeat(300 * 1024);
		assert.ok(Buffer.byteLength(huge, "utf8") > 512 * 1024);
		const harness = await startHarness({
			extraFixture: (sessionDir) => {
				const line = JSON.stringify({
					type: "message",
					id: "e_huge",
					parentId: "e2",
					message: { role: "user", content: huge },
				});
				appendFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), `${line}\n`);
			},
		});
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "e_huge" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "entry-copy");
		assert.equal(response.oversized, true);
		assert.equal(response.text, undefined, "超限不得回部分文本");
		assert.equal(response.bytes, Buffer.byteLength(huge, "utf8"));
		client.close();
	});

	it("entry-copy 拒绝未知会话/未知条目/缺参", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "ghost" }));
		const missing = await client.nextMessage();
		assert.equal(missing.code, "entry-not-found");
		assert.equal(missing.entryId, "ghost");
		client.send(
			JSON.stringify({ type: "entry-copy", sessionId: "00000000-0000-4000-8000-000000000000", entryId: "e1" }),
		);
		assert.equal((await client.nextMessage()).code, "session-not-found");
		for (const frame of [
			{ type: "entry-copy" },
			{ type: "entry-copy", sessionId: SESSION_ID },
			{ type: "entry-copy", sessionId: SESSION_ID, entryId: "" },
			{ type: "entry-copy", sessionId: SESSION_ID, entryId: "x".repeat(257) },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.code, "bad-request", JSON.stringify(frame).slice(0, 80));
			assert.equal(response.requestType, "entry-copy");
			// PROTOCOL §4.26：错误帧只在参数齐备时回显目标；缺参帧没有可回显的
			// entryId，客户端据此不会把失败误归到某个动作卡（复审C钉住）。
			if (frame.entryId === undefined) assert.equal(response.entryId, undefined);
		}
		client.close();
	});

	it("label-put 在 live 会话上追加/覆盖/清除标签，并跟着叶子前进", async () => {
		// extraFixture 只用来拿到临时会话目录：后面要核落盘的 LabelEntry 父链。
		let sessionDir = "";
		const harness = await startHarness({
			extraFixture: (dir) => {
				sessionDir = dir;
			},
		});
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		assert.equal((await client.nextMessage()).kind, "model-set");

		// 新增：targetId 是被选中的 e1，新 LabelEntry 成为叶子。
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "交付" }));
		const first = await client.nextMessage();
		assert.equal(first.kind, "label-put");
		assert.equal(first.entryId, "e1");
		assert.equal(first.label, "交付");
		assert.equal(typeof first.labelEntryId, "string");
		assert.equal(first.leafId, first.labelEntryId, "Pi 语义：追加 LabelEntry 会推进叶子");
		const firstLabelId = String(first.labelEntryId);

		// 树投影跟着变：labeled-only 只留 e1，default 的 selectedId 回到最近可见祖先，
		// 而不是把隐藏的标签条目当当前行（显示与跳转目标不错位）。
		client.send(
			JSON.stringify({
				type: "tree",
				sessionId: SESSION_ID,
				view: { filter: "labeled-only", search: "", foldedIds: [] },
			}),
		);
		const labeled = await client.nextMessage();
		assert.deepEqual(
			(labeled.nodes as Array<Record<string, unknown>>).map((node) => [node.id, node.label]),
			[["e1", "交付"]],
		);
		client.send(
			JSON.stringify({ type: "tree", sessionId: SESSION_ID, view: { filter: "default", search: "", foldedIds: [] } }),
		);
		const defaultView = await client.nextMessage();
		assert.equal(defaultView.leafId, firstLabelId);
		assert.equal(defaultView.selectedId, "e2", "叶子落在隐藏标签条目上时选择回落最近可见祖先");
		// 复审A P2 的行为口径钉住（PROTOCOL §4.27 第4条）：all 筛选下 LabelEntry
		// 是可见行且成为 leafId/selectedId——与 Pi 原生同语义，将来不得“修好”成回退旧叶。
		client.send(
			JSON.stringify({ type: "tree", sessionId: SESSION_ID, view: { filter: "all", search: "", foldedIds: [] } }),
		);
		const allView = await client.nextMessage();
		assert.equal(allView.leafId, firstLabelId, "写标签后运行时叶子就是新 LabelEntry");
		assert.equal(allView.selectedId, firstLabelId, "all 筛选下 LabelEntry 可见、不回退父链");
		assert.ok(
			(allView.nodes as Array<Record<string, unknown>>).some((node) => node.id === firstLabelId),
			"all 筛选下新 LabelEntry 应投影成可见行",
		);

		// 覆盖：同一 target 再写一次，最后记录生效，新条目以上一个标签条目为父。
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: " 已交付 " }));
		const second = await client.nextMessage();
		assert.equal(second.label, "已交付", "标签值按 Pi LabelInput 语义 trim");
		assert.notEqual(second.labelEntryId, firstLabelId);
		assert.equal(second.leafId, second.labelEntryId);

		// 落盘核对：Pi 只追加不改写——三条 label 条目都以 e1 为 targetId，后一条的父是
		// 前一条（运行时叶子已前进），旧消息行没被改写。
		const lines = readFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const labelEntries = lines.filter((entry) => entry.type === "label");
		assert.deepEqual(
			labelEntries.map((entry) => [entry.targetId, entry.label ?? null]),
			[
				["e1", "交付"],
				["e1", "已交付"],
			],
		);
		assert.equal(labelEntries[1].parentId, labelEntries[0].id);
		assert.equal(lines.filter((entry) => entry.id === "e1").length, 1, "被标签的旧条目保持单份，不被改写");

		// 清除：label 为 null / 缺席 / 空白串三种写法等价。
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: null }));
		const cleared = await client.nextMessage();
		assert.equal(cleared.kind, "label-put");
		assert.equal(cleared.label, null);
		client.send(
			JSON.stringify({
				type: "tree",
				sessionId: SESSION_ID,
				view: { filter: "labeled-only", search: "", foldedIds: [] },
			}),
		);
		const afterClear = await client.nextMessage();
		assert.deepEqual(afterClear.nodes, []);
		// 清除同样只追加：第三条 label 条目 label 字段为 undefined（Pi 的清除形态）。
		const clearedLines = readFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.type === "label");
		assert.equal(clearedLines.length, 3);
		assert.equal(clearedLines[2].label, undefined);
		assert.equal(clearedLines[2].targetId, "e1");
		client.close();
	});

	it("label-put 无 live 句柄/未知条目/非法标签均拒绝", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		// 未打开会话（无活动句柄）：与 switch-branch 同口径，不隐式 openSession。
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "x" }));
		const offline = await client.nextMessage();
		assert.equal(offline.kind, "error");
		assert.equal(offline.code, "session-not-found");
		assert.equal(offline.requestType, "label-put");

		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		assert.equal((await client.nextMessage()).kind, "model-set");
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "ghost", label: "x" }));
		const missing = await client.nextMessage();
		assert.equal(missing.code, "entry-not-found");
		assert.equal(missing.entryId, "ghost");
		for (const frame of [
			{ type: "label-put", sessionId: SESSION_ID },
			{ type: "label-put", sessionId: SESSION_ID, entryId: "" },
			{ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: 12 },
			{ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "a".repeat(201) },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.code, "bad-request", JSON.stringify(frame).slice(0, 80));
			assert.equal(response.requestType, "label-put");
			// 同 entry-copy：缺参帧不回显 entryId（PROTOCOL §4.27）。
			if (frame.entryId === undefined) assert.equal(response.entryId, undefined);
		}
		client.close();
	});

	// PROTOCOL §4.27 第6条：流式/压缩进行中不额外拒绝（Pi 也允许在树选择器里改标签），
	// 复审C指出该承诺零测试——这里钉住，将来加 busy 拒绝会红。
	it("label-put 持久化异常不伪报 entry-not-found，也不回成功", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		try {
			client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
			await client.nextMessage();
			const session = expectSession(harness.sessions, SESSION_ID);
			const before = session.sessionManager.getLeafId();
			session.sessionManager.appendLabelChange = () => {
				throw new Error("synthetic-disk-full");
			};
			client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "交付" }));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error");
			assert.equal(response.code, "internal");
			assert.equal(response.message, "internal error");
			assert.equal(response.entryId, "e1");
			assert.equal(session.sessionManager.getLeafId(), before);
		} finally {
			client.close();
		}
	});

	it("label-put 后自然追加的回答仍是当前叶子，句柄回收后也保留", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		try {
			client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
			await client.nextMessage();
			const session = expectSession(harness.sessions, SESSION_ID);
			session.isStreaming = true;
			client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "流式中" }));
			const label = await client.nextMessage();
			assert.equal(label.kind, "label-put");
			const answer = session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "标签之后完成的回答" }],
				api: "anthropic-messages",
				provider: "fixture",
				model: "m1",
				timestamp: Date.now(),
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			session.isStreaming = false;
			client.send(
				JSON.stringify({ type: "tree", sessionId: SESSION_ID, view: { filter: "all", search: "", foldedIds: [] } }),
			);
			assert.equal((await client.nextMessage()).leafId, answer);
			// 再追加后不先读tree，直接回收，覆盖回收前同步路径。
			const next = session.sessionManager.appendMessage({ role: "user", content: "后续", timestamp: Date.now() });
			harness.runtime.disposeAll();
			client.send(
				JSON.stringify({ type: "tree", sessionId: SESSION_ID, view: { filter: "all", search: "", foldedIds: [] } }),
			);
			assert.equal((await client.nextMessage()).leafId, next);
			client.send(JSON.stringify({ type: "history", sessionId: SESSION_ID }));
			const history = await client.nextMessage();
			assert.equal(history.latestEntryId, next);
			assert.ok((history.entryIds as string[]).includes(answer));
		} finally {
			client.close();
		}
	});

	it("live全文复制与压缩中标签写保留Pi语义，覆盖标签即时进入筛选", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		try {
			client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
			await client.nextMessage();
			const session = expectSession(harness.sessions, SESSION_ID);
			client.send(JSON.stringify({ type: "entry-copy", sessionId: SESSION_ID, entryId: "e1" }));
			const copied = await client.nextMessage();
			assert.equal(copied.kind, "entry-copy");
			assert.equal(copied.text, "hello");
			session.isCompacting = true;
			for (const label of ["旧标签", "新标签"]) {
				client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label }));
				assert.equal((await client.nextMessage()).label, label);
			}
			session.isCompacting = false;
			client.send(
				JSON.stringify({
					type: "tree",
					sessionId: SESSION_ID,
					view: { filter: "labeled-only", search: "", foldedIds: [] },
				}),
			);
			const tree = await client.nextMessage();
			assert.equal(
				(tree.nodes as Array<{ id: string; label?: string }>).find((node) => node.id === "e1")?.label,
				"新标签",
			);
		} finally {
			client.close();
		}
	});

	it("label-put 流式中不额外拒绝，正常追加", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p2", modelId: "m2" }));
		assert.equal((await client.nextMessage()).kind, "model-set");
		const session = expectSession(harness.sessions, SESSION_ID);
		session.isStreaming = true;
		client.send(JSON.stringify({ type: "label-put", sessionId: SESSION_ID, entryId: "e1", label: "流式中" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "label-put");
		assert.equal(response.label, "流式中");
		assert.equal(typeof response.labelEntryId, "string");
		client.close();
	});

	it("restarts an idle session and rejects a busy one", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "restart-session", sessionId: SESSION_ID }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "session-restarted");
		assert.equal(response.sessionId, SESSION_ID);
		assert.ok(response.model !== undefined);
		// 未知会话（未加载过）也允许 restart：等价于空闲回收后的重开路径。
		client.send(JSON.stringify({ type: "restart-session", sessionId: "00000000-0000-4000-8000-000000000000" }));
		const second = await client.nextMessage();
		assert.equal(second.kind, "error");
		// 运行中拒绝：busy 码让客户端区分忙与故障。
		const session = expectSession(harness.sessions, SESSION_ID);
		session.isStreaming = true;
		client.send(JSON.stringify({ type: "restart-session", sessionId: SESSION_ID }));
		const busy = await client.nextMessage();
		assert.equal(busy.kind, "error");
		assert.equal(busy.code, "session-restart-busy");
		session.isStreaming = false;
		client.close();
	});

	it("rejects bad restart-session params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		for (const frame of [{ type: "restart-session" }, { type: "restart-session", sessionId: "" }]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, "bad-request", JSON.stringify(frame));
		}
		client.close();
	});

	it("rejects bad name params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		for (const frame of [
			{ type: "name" },
			{ type: "name", sessionId: SESSION_ID },
			{ type: "name", sessionId: SESSION_ID, name: "" },
			{ type: "name", sessionId: SESSION_ID, name: "x".repeat(201) },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, "bad-request", JSON.stringify(frame));
		}
		client.close();
	});

	it("starts manual compaction without awaiting its completion", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		client.send(JSON.stringify({ type: "compact", sessionId: SESSION_ID }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "compact-started");
		assert.equal(response.sessionId, SESSION_ID);
		assert.equal(typeof response.isCompacting, "boolean");
		const session = harness.sessions.get(SESSION_ID);
		assert.ok(session);
		assert.equal(session.compactCalls, 1);
		assert.equal(response.isCompacting, true);
		const finalState = await client.nextMessage();
		assert.equal(finalState.kind, "compact-finished");
		assert.equal(finalState.isCompacting, false);
		client.close();
	});

	it("rejects unknown session for name and compact", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "name", sessionId: "missing", name: "x" }));
		let response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "session-not-found");
		client.send(JSON.stringify({ type: "compact", sessionId: "missing" }));
		response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "session-not-found");
		client.close();
	});

	it("rejects bad set-model params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		for (const frame of [
			{ type: "set-model" },
			{ type: "set-model", sessionId: SESSION_ID },
			{ type: "set-model", sessionId: SESSION_ID, provider: "p1" },
			{ type: "set-model", sessionId: SESSION_ID, provider: "p1", modelId: "m1", thinkingLevel: "ultra" },
		]) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, "bad-request", JSON.stringify(frame));
		}
		client.close();
	});

	it("rejects unknown models and unknown sessions", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "set-model", sessionId: SESSION_ID, provider: "p1", modelId: "nope" }));
		const unknownModel = await client.nextMessage();
		assert.equal(unknownModel.kind, "error");
		assert.equal(unknownModel.code, "bad-request");
		assert.match(String(unknownModel.message), /unknown model/);
		client.send(JSON.stringify({ type: "set-model", sessionId: "nope", provider: "p1", modelId: "m1" }));
		const unknownSession = await client.nextMessage();
		assert.equal(unknownSession.kind, "error");
		assert.equal(unknownSession.code, "session-not-found");
		client.close();
	});
});

describe("router: message flow and events", () => {
	it("message on an existing session subscribes, accepts, and streams events", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "message", sessionId: SESSION_ID, text: "hello" }));
		const sent = await client.nextMessage();
		// The fake prompt emits its events synchronously inside prompt(),
		// before the router answers `sent` — so the events arrive first.
		const frames = [sent];
		let guard = 0;
		while (frames.length < 3 && guard++ < 10) {
			frames.push(await client.nextMessage());
		}
		const kinds = frames.map((frame) => frame.kind);
		assert.ok(kinds.includes("sent"), JSON.stringify(kinds));
		assert.ok(kinds.includes("event"), JSON.stringify(kinds));
		const events = frames.filter((frame) => frame.kind === "event");
		assert.equal(events[0].sessionId, SESSION_ID);
		assert.equal(events[0].seq, 1);
		const event = events[0].event as Record<string, unknown>;
		assert.equal(event.type, "message_start");
		// The turn_start event is omitted by the wire projection, and the
		// agent_end projection drops `messages`.
		const agentEnd = events.find((frame) => (frame.event as Record<string, unknown>).type === "agent_end");
		assert.ok(agentEnd, "agent_end must be forwarded");
		assert.deepEqual((agentEnd.event as Record<string, unknown>).messages, undefined);
		assert.equal((agentEnd.event as Record<string, unknown>).willRetry, false);
		const session = expectSession(harness.sessions, SESSION_ID);
		assert.deepEqual(session.promptCalls, [{ text: "hello", mode: undefined }]);
		client.close();
	});

	it("message with model pre-selection applies setModel before prompting", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "message",
				sessionId: SESSION_ID,
				text: "hello",
				model: { provider: "p2", modelId: "m2", thinkingLevel: "high" },
			}),
		);
		// FakeSession 的 prompt 在 router 应答 sent 之前同步吐事件，先收集再找 sent。
		let sent: Record<string, unknown> | null = null;
		for (let i = 0; i < 5 && sent === null; i++) {
			const frame = await client.nextMessage();
			if (frame.kind === "sent") sent = frame;
		}
		assert.ok(sent, "sent frame expected");
		const session = expectSession(harness.sessions, SESSION_ID);
		assert.equal(session.modelSetCalls.length, 1);
		assert.equal((session.modelSetCalls[0].model as { id: string }).id, "m2");
		assert.deepEqual(session.thinkingLevelCalls, ["high"]);
		assert.deepEqual(session.promptCalls, [{ text: "hello", mode: undefined }]);
		client.close();
	});

	it("message with an unknown model pre-selection is rejected without prompting", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "message",
				sessionId: SESSION_ID,
				text: "hello",
				model: { provider: "p2", modelId: "nope" },
			}),
		);
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "bad-request");
		// 预校验发生在会话加载之前（对标 pi CLI：模型校验先于会话创建，
		// error 即 process.exit(1) 不落会话文件）——fixture 会话未被加载。
		assert.equal(harness.sessions.size, 0);
		client.close();
	});

	it("message with image attachments reaches the prompt as pi ImageContent", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		const images = [
			{ type: "image", data: "QUJD", mimeType: "image/jpeg" },
			{ type: "image", data: "WFla", mimeType: "image/png" },
		];
		client.send(JSON.stringify({ type: "message", sessionId: SESSION_ID, text: "看这张图", images }));
		const frames: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 3; i++) frames.push(await client.nextMessage());
		assert.ok(
			frames.find((frame) => frame.kind === "sent"),
			"images message must be accepted",
		);
		const session = expectSession(harness.sessions, SESSION_ID);
		assert.equal(session.promptCalls.length, 1);
		assert.deepEqual(session.promptCalls[0].images, images);
	});

	it("message with empty text and an image is accepted as a pure-image prompt", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "message",
				sessionId: SESSION_ID,
				text: "",
				images: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }],
			}),
		);
		const frames: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 3; i++) frames.push(await client.nextMessage());
		const sent = frames.find((frame) => frame.kind === "sent");
		assert.ok(sent, "纯图消息必须受理");
		const session = expectSession(harness.sessions, SESSION_ID);
		// 纯图消息（无文字）在 runtime 层被注入单个空格：pi 会无条件生成 text block，
		// 空 text 会被 OpenAI 兼容上游拒（400 messages 参数非法），" " 则可通过。
		assert.deepEqual(session.promptCalls, [
			{ text: " ", mode: undefined, images: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] },
		]);
		client.close();
	});

	it("message with mode steer passes the queue behavior through", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "message", sessionId: SESSION_ID, text: "redirect", mode: "steer" }));
		// sent + message_start + agent_end (turn_start is omitted by the wire).
		const frames: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 3; i++) frames.push(await client.nextMessage());
		const sent = frames.find((frame) => frame.kind === "sent");
		assert.ok(sent);
		assert.equal(sent.mode, "steer");
		assert.deepEqual(expectSession(harness.sessions, SESSION_ID).promptCalls, [{ text: "redirect", mode: "steer" }]);
		client.close();
	});

	it("message without sessionId creates a new session for a valid cwd", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		const cwd = tempDir("pi-mgw-router-project-");
		client.send(JSON.stringify({ type: "message", cwd, text: "new session" }));
		const frames: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 3; i++) frames.push(await client.nextMessage());
		const sent = frames.find((frame) => frame.kind === "sent");
		assert.ok(sent, JSON.stringify(frames.map((frame) => frame.kind)));
		assert.equal(typeof sent.sessionId, "string");
		const session = expectSession(harness.sessions, sent.sessionId as string);
		assert.ok(session);
		assert.deepEqual(session.promptCalls, [{ text: "new session", mode: undefined }]);
		client.close();
	});

	it("rejects invalid message frames", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ type: "message" }, "requires"],
			[{ type: "message", sessionId: SESSION_ID, text: "  " }, "requires"],
			[{ type: "message", sessionId: SESSION_ID, text: "x", images: "nope" }, "images must be"],
			[
				{
					type: "message",
					sessionId: SESSION_ID,
					text: "x",
					images: [{ type: "image", data: "", mediaType: "image/png" }],
				},
				"images must be",
			],
			[{ type: "message", sessionId: SESSION_ID, cwd: "/tmp", text: "x" }, "not both"],
			[{ type: "message", text: "x" }, "requires"],
			[{ type: "message", cwd: "relative", text: "x" }, "绝对路径"],
			[{ type: "message", cwd: "/definitely/missing/dir", text: "x" }, "目录不存在"],
			[{ type: "message", sessionId: SESSION_ID, text: "x", mode: "queue" }, "mode"],
		];
		for (const [frame, needle] of cases) {
			client.send(JSON.stringify(frame));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error", JSON.stringify(frame));
			assert.equal(response.code, frame.cwd === "/definitely/missing/dir" ? "directory-not-found" : "bad-request");
			assert.ok(
				String(response.message).includes(needle),
				`message "${String(response.message)}" should mention "${needle}"`,
			);
			assert.equal(response.requestType, "message");
		}
		client.close();
	});

	it("surfaces prompt rejections as prompt-rejected errors", async () => {
		const sessionDir = tempDir("pi-mgw-router-sessions-");
		writeFixtureSession(sessionDir);
		const sessions = new Map<string, FakeSession>();
		const runtime = new PiRuntime({
			sessionDir,
			sessionFactory: async ({ sessionManager }) => {
				const session = new FakeSession(sessionManager);
				session.prompt = () => Promise.reject(new Error("no model selected"));
				sessions.set(session.sessionId, session);
				return session;
			},
		});
		runtimes.push(runtime);
		const registry = createRegistry(join(tempDir("pi-mgw-router-devices-"), "devices.json"));
		const dataPlane = await startDataPlane({
			registry,
			port: 0,
			host: "127.0.0.1",
			onClient: (send) => connectClient(runtime, send),
		});
		planes.push(dataPlane);
		const pairing = registry.createPairing("手机2");
		const client = await connect(`ws://127.0.0.1:${dataPlane.port}/ws/mobile`, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-router-2" },
		});
		assert.ok(client.ws);
		await client.nextMessage(); // paired
		await client.nextMessage(); // hello
		client.send(JSON.stringify({ type: "message", sessionId: SESSION_ID, text: "hi" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "prompt-rejected");
		assert.equal(response.message, "no model selected");
		client.close();
	});
});

describe("router: subscriptions", () => {
	it("subscribe/unsubscribe gate the event stream per connection", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");

		const session = expectSession(harness.sessions, SESSION_ID);
		session.emit({ type: "queue_update", steering: ["s"], followUp: [] } as AgentSessionEvent);
		const eventFrame = await client.nextMessage();
		assert.equal(eventFrame.kind, "event");
		assert.equal((eventFrame.event as Record<string, unknown>).type, "queue_update");

		client.send(JSON.stringify({ type: "unsubscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "unsubscribed");
		session.emit({ type: "queue_update", steering: ["s"], followUp: [] } as AgentSessionEvent);
		// No further events: verify via a ping round-trip that no event frame
		// was queued behind it.
		client.send(JSON.stringify({ type: "ping" }));
		const pong = await client.nextMessage();
		assert.equal(pong.kind, "pong");
		client.close();
	});

	it("unsubscribe detaches at session level and survives restart-session", async () => {
		const harness = await startHarness();
		const clientA = await harness.connectPaired();
		const clientB = await harness.connectPaired();
		for (const client of [clientA, clientB]) {
			client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
			assert.equal((await client.nextMessage()).kind, "subscribed");
		}
		// A 触发重建：新 handle 迁移了 sinks，旧 detach 已失效。
		clientA.send(JSON.stringify({ type: "restart-session", sessionId: SESSION_ID }));
		assert.equal((await clientA.nextMessage()).kind, "session-restarted");
		clientA.send(JSON.stringify({ type: "unsubscribe", sessionId: SESSION_ID }));
		assert.equal((await clientA.nextMessage()).kind, "unsubscribed");
		// restart 建了新 FakeSession（sessionFactory 覆盖同 id）：在新实例上打事件。
		const session = expectSession(harness.sessions, SESSION_ID);
		session.emit({ type: "queue_update", steering: ["s"], followUp: [] } as AgentSessionEvent);
		const eventFrame = await clientB.nextMessage();
		assert.equal(eventFrame.kind, "event");
		// A 不再收事件：ping 往返证明其队列里没有滞留 event。
		clientA.send(JSON.stringify({ type: "ping" }));
		assert.equal((await clientA.nextMessage()).kind, "pong");
		// 非发起方 B 同样能摘（session 级摘除，不依赖发起方刷新）。
		clientB.send(JSON.stringify({ type: "unsubscribe", sessionId: SESSION_ID }));
		assert.equal((await clientB.nextMessage()).kind, "unsubscribed");
		session.emit({ type: "queue_update", steering: ["s2"], followUp: [] } as AgentSessionEvent);
		clientB.send(JSON.stringify({ type: "ping" }));
		assert.equal((await clientB.nextMessage()).kind, "pong");
		clientA.close();
		clientB.close();
	});

	it("commands lists three sources with skill prefix", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		// 先触发按需加载（state 不建 live handle，用 subscribe），再挂三源 getter。
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		const session = expectSession(harness.sessions, SESSION_ID);
		session.extensionRunner = {
			getRegisteredCommands: () => [
				{ invocationName: "review", description: "CR", sourceInfo: { scope: "user", origin: "package" } },
			],
		};
		session.promptTemplates = [
			{
				name: "eval",
				description: "E",
				argumentHint: "[target]",
				sourceInfo: { scope: "project", origin: "top-level" },
			},
		];
		session.resourceLoader = {
			getSkills: () => ({
				skills: [
					{
						name: "grilling",
						description: "G",
						disableModelInvocation: true,
						sourceInfo: { scope: "user", origin: "package" },
					},
				],
			}),
		};
		client.send(JSON.stringify({ type: "commands", sessionId: SESSION_ID }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "commands");
		assert.equal(reply.sessionId, SESSION_ID);
		assert.deepEqual(reply.commands, [
			{ name: "review", description: "CR", source: "extension", scope: "user", origin: "package" },
			{
				name: "eval",
				description: "E",
				source: "prompt",
				scope: "project",
				origin: "top-level",
				argumentHint: "[target]",
			},
			{
				name: "skill:grilling",
				description: "G",
				source: "skill",
				scope: "user",
				origin: "package",
				disableModelInvocation: true,
			},
		]);
		client.close();
	});

	it("input resources use the session cwd, omit extensions, and preserve original commands behavior", async () => {
		const cwd = tempDir("pi-input-router-cwd-");
		const harness = await startHarness({ fixtureCwd: cwd });
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		const session = expectSession(harness.sessions, SESSION_ID);
		session.promptTemplates = [{ name: "eval", description: "Evaluate", argumentHint: "[target]" }];
		session.extensionRunner = { getRegisteredCommands: () => [{ invocationName: "ext" }] };
		client.send(JSON.stringify({ type: "input-resources", queryId: "resources-1", sessionId: SESSION_ID }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "input-resources");
		assert.equal(reply.queryId, "resources-1");
		assert.equal(reply.cwd, cwd);
		assert.equal(reply.mode, "session");
		assert.deepEqual(
			(reply.commands as Array<{ name: string }>).map((item) => item.name),
			["eval"],
		);
		client.send(JSON.stringify({ type: "commands", sessionId: SESSION_ID }));
		assert.deepEqual(
			((await client.nextMessage()).commands as Array<{ name: string }>).map((item) => item.name),
			["ext", "eval"],
		);
		client.close();
	});

	it("@ queries resolve an unloaded session without creating a session and correlate invalid requests", async () => {
		const cwd = tempDir("pi-input-router-files-");
		writeFileSync(join(cwd, "guide.md"), "private contents");
		const harness = await startHarness({ fixtureCwd: cwd });
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({ type: "input-completions", queryId: "files-1", sessionId: SESSION_ID, token: "@gui" }),
		);
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "input-completions");
		assert.equal(reply.queryId, "files-1");
		assert.equal(reply.cwd, cwd);
		assert.equal((reply.items as Array<{ insertText: string }>)[0].insertText, "@guide.md ");
		assert.equal(harness.sessions.size, 0);
		assert.ok(!JSON.stringify(reply).includes("private contents"));
		for (const [queryId, extra, expected] of [
			["mixed", { sessionId: SESSION_ID, cwd }, "bad-request"],
			["missing", { sessionId: "unknown" }, "session-not-found"],
			["relative", { cwd: "relative/path" }, "bad-request"],
		] as const) {
			client.send(JSON.stringify({ type: "input-completions", queryId, token: "@", ...extra }));
			const error = await client.nextMessage();
			assert.equal(error.code, expected);
			assert.equal(error.queryId, queryId);
		}
		client.close();
	});

	it("commands degrades when sources are missing and rejects bad params", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		// FakeSession 默认无三 getter：空清单不断言失败。
		client.send(JSON.stringify({ type: "commands", sessionId: SESSION_ID }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "commands");
		assert.deepEqual(reply.commands, []);
		client.send(JSON.stringify({ type: "commands" }));
		const bad = await client.nextMessage();
		assert.equal(bad.kind, "error");
		assert.equal(bad.code, "bad-request");
		client.send(JSON.stringify({ type: "commands", sessionId: "00000000-0000-4000-8000-000000000000" }));
		const missing = await client.nextMessage();
		assert.equal(missing.kind, "error");
		assert.equal(missing.code, "session-not-found");
		client.close();
	});

	it("closing the connection detaches the subscription", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		client.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const session = expectSession(harness.sessions, SESSION_ID);
		session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
		// The subscriber set is a private detail; the observable contract is
		// that a reconnected client re-subscribing gets fresh events.
		const reopened = await harness.connectPaired();
		reopened.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await reopened.nextMessage()).kind, "subscribed");
		session.emit({ type: "queue_update", steering: ["after-reconnect"], followUp: [] } as AgentSessionEvent);
		const frame = await reopened.nextMessage();
		assert.equal(frame.kind, "event");
		assert.deepEqual((frame.event as Record<string, unknown>).steering, ["after-reconnect"]);
		reopened.close();
	});

	it("dequeue restores both pending queues without aborting; ACK precedes later queue events", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		await client.nextMessage();
		const session = expectSession(harness.sessions, SESSION_ID);
		session.isStreaming = true;
		session.steeringMessages = ["first"];
		session.followUpMessages = ["next", "next"];
		client.send(JSON.stringify({ type: "dequeue", sessionId: SESSION_ID, queueRequestId: "recall-1" }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "dequeued");
		assert.equal(reply.queueRequestId, "recall-1");
		assert.equal(reply.isStreaming, true);
		assert.deepEqual(reply.queued, ["first", "next", "next"]);
		assert.deepEqual(reply.queuedMessages, { steering: [], followUp: [] });
		assert.equal(session.aborted, false);
		assert.equal(session.promptCalls.length, 0);
		assert.equal((await client.nextMessage()).kind, "event");
		client.send(JSON.stringify({ type: "dequeue", sessionId: SESSION_ID, queueRequestId: "recall-2" }));
		assert.deepEqual((await client.nextMessage()).queued, []);
		await client.nextMessage();
		client.close();
	});

	it("dequeue rejects missing/invalid operation ID before clearing anything", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		await client.nextMessage();
		const session = expectSession(harness.sessions, SESSION_ID);
		session.followUpMessages = ["keep"];
		for (const queueRequestId of [undefined, " ", "x".repeat(129), 1]) {
			client.send(JSON.stringify({ type: "dequeue", sessionId: SESSION_ID, queueRequestId }));
			assert.equal((await client.nextMessage()).code, "bad-request");
			assert.deepEqual(session.getFollowUpMessages(), ["keep"]);
		}
		client.send(JSON.stringify({ type: "dequeue", queueRequestId: "missing-session" }));
		const failure = await client.nextMessage();
		assert.equal(failure.code, "bad-request");
		assert.equal(failure.queueRequestId, "missing-session");
		assert.equal(session.aborted, false);
		client.close();
	});

	it("abort reports aborted for loaded sessions", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "subscribed");
		client.send(JSON.stringify({ type: "abort", sessionId: SESSION_ID }));
		assert.equal((await client.nextMessage()).kind, "aborted");
		assert.equal(expectSession(harness.sessions, SESSION_ID).aborted, true);
		client.close();
	});

	it("opt-in abort clears idle residual queue and returns text once before accepting new messages", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		await client.nextMessage();
		const session = expectSession(harness.sessions, SESSION_ID);
		session.steeringMessages = ["first"];
		session.followUpMessages = ["next", "next"];
		client.send(JSON.stringify({ type: "abort", sessionId: SESSION_ID, restoreQueued: true }));
		const update = await client.nextMessage();
		assert.equal(update.kind, "event");
		assert.deepEqual((update.event as Record<string, unknown>).followUp, []);
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "aborted");
		assert.equal(reply.isStreaming, false);
		assert.equal(reply.isCompacting, false);
		assert.deepEqual(reply.queued, ["first", "next", "next"]);
		assert.deepEqual(reply.queuedMessages, { steering: [], followUp: [] });
		assert.deepEqual(session.getFollowUpMessages(), []);
		assert.equal(session.promptCalls.length, 0);
		client.send(JSON.stringify({ type: "abort", sessionId: SESSION_ID, restoreQueued: true }));
		await client.nextMessage(); // empty queue_update
		assert.deepEqual((await client.nextMessage()).queued, []);
		client.close();
	});

	it("legacy abort keeps queued text; invalid opt-in cannot clear it", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID }));
		await client.nextMessage();
		const session = expectSession(harness.sessions, SESSION_ID);
		session.followUpMessages = ["keep"];
		client.send(JSON.stringify({ type: "abort", sessionId: SESSION_ID, restoreQueued: "true" }));
		assert.equal((await client.nextMessage()).kind, "error");
		assert.equal(session.aborted, false);
		client.send(JSON.stringify({ type: "abort", sessionId: SESSION_ID }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "aborted");
		assert.equal(reply.queued, undefined);
		assert.deepEqual(session.getFollowUpMessages(), ["keep"]);
		client.close();
	});

	it("unknown types get unknown-command errors", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "dance" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "unknown-command");
		assert.equal(response.requestType, "dance");
		client.close();
	});
});

// ---------------------------------------------------------------------------
// Review round: error hygiene and outbound size budgets over the wire
// ---------------------------------------------------------------------------

const ABANDONED_SESSION_ID = "66666666-8888-9999-aaaa-bbbbccccdddd";

function writeAbandonedBranchFixture(sessionDir: string): void {
	const path = join(sessionDir, `2026-01-02T00-00-00-000Z_${ABANDONED_SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: ABANDONED_SESSION_ID,
			timestamp: "2026-01-02T00:00:00.000Z",
			cwd: "/tmp/fake-project",
		}),
		// File order: e0 -> e1a(abandoned) and e0 -> e1b. The file-order leaf
		// is e1b, so the active branch is {e1b, e0}; e1a exists in the file
		// but sits on the abandoned branch.
		JSON.stringify({ type: "message", id: "e0", parentId: null, message: { role: "user", content: "root" } }),
		JSON.stringify({
			type: "message",
			id: "e1a",
			parentId: "e0",
			message: { role: "assistant", content: "abandoned" },
		}),
		JSON.stringify({ type: "message", id: "e1b", parentId: "e0", message: { role: "assistant", content: "active" } }),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

const HUGE_SESSION_ID = "77777777-8888-9999-aaaa-bbbbccccdddd";

function writeHugeMessageFixture(sessionDir: string): void {
	const path = join(sessionDir, `2026-01-03T00-00-00-000Z_${HUGE_SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: HUGE_SESSION_ID,
			timestamp: "2026-01-03T00:00:00.000Z",
			cwd: "/tmp/fake-project",
		}),
		JSON.stringify({
			type: "message",
			id: "h1",
			parentId: null,
			message: { role: "assistant", content: [{ type: "text", text: "z".repeat(3 * 1024 * 1024) }] },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

describe("router: review round", () => {
	it("invalid history cursor returns a safe category without exposing the cursor", async () => {
		const harness = await startHarness({ extraFixture: writeAbandonedBranchFixture });
		harness.logs.length = 0;
		const client = await harness.connectPaired();
		// The cursor exists in the file but sits on an abandoned branch:
		// runtime.history returns a stable cursor category without private details.
		client.send(JSON.stringify({ type: "history", sessionId: ABANDONED_SESSION_ID, beforeEntryId: "e1a" }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "history-cursor-invalid");
		assert.equal(response.message, "历史位置已变化，请重新加载");
		assert.equal(response.sessionId, ABANDONED_SESSION_ID);
		assert.equal(response.requestType, "history");
		assert.equal(JSON.stringify(response).includes("e1a"), false);
		assert.ok(harness.logs.includes("history cursor invalid"));
		// The normal page for that session still works.
		client.send(JSON.stringify({ type: "history", sessionId: ABANDONED_SESSION_ID }));
		const page = await client.nextMessage();
		assert.equal(page.kind, "history");
		assert.equal((page.messages as Array<Record<string, unknown>>).map((m) => m.role).join(","), "user,assistant");
		client.close();
	});

	it("history shrinks a single huge message and keeps the page cap honest", async () => {
		const harness = await startHarness({ extraFixture: writeHugeMessageFixture });
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "history", sessionId: HUGE_SESSION_ID }));
		const response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "history");
		const messages = response.messages as Array<Record<string, unknown>>;
		assert.equal(messages.length, 1);
		const content = messages[0].content as Array<{ type: string; text?: string }>;
		assert.ok(content[0].text?.endsWith("[已截断]"));
		const serialized = JSON.stringify(response);
		assert.ok(Buffer.byteLength(serialized, "utf8") <= 2 * 1024 * 1024);
		client.close();
	});
});

// ---------------------------------------------------------------------------
// Workspace picker: directories / directory-create / workspace-create
// ---------------------------------------------------------------------------

describe("router: workspace picker (host fs services)", () => {
	it("lists subdirectories only, with home and crumbs", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "directories" }));
		const response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "directories");
		const home = response.home as string;
		assert.ok(home.startsWith("/"), "home is absolute");
		assert.equal(response.path, home);
		assert.equal(response.truncated, false);
		const crumbs = response.crumbs as Array<Record<string, unknown>>;
		assert.ok(crumbs.length >= 2, "crumbs include root and current");
		assert.equal(crumbs[crumbs.length - 1].path, home);
		const entries = response.entries as Array<Record<string, unknown>>;
		for (const entry of entries) {
			assert.ok((entry.path as string).startsWith(`${home}/`), "entries live under home");
		}
		client.close();
	});

	it("creates a folder, tolerates a repeat, then creates a workspace on top", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();

		client.send(JSON.stringify({ type: "directories" }));
		await client.nextMessage();
		const home = tempDir("pi-mgw-workspace-");

		const folderName = `工作区-${Date.now()}`;
		client.send(JSON.stringify({ type: "directory-create", path: home, name: folderName }));
		const created = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(created.kind, "directory-create");
		const folderPath = created.path as string;
		assert.equal(folderPath, `${home}/${folderName}`);
		assert.equal(created.created, true);

		client.send(JSON.stringify({ type: "directory-create", path: home, name: folderName }));
		const again = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(again.kind, "directory-create");
		assert.equal(again.created, false);
		assert.equal(again.path, folderPath);

		client.send(JSON.stringify({ type: "workspace-create", path: folderPath }));
		const workspaceFrame = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(workspaceFrame.kind, "workspace-create");
		const workspace = workspaceFrame.workspace as Record<string, unknown>;
		assert.equal(workspace.workspaceId, folderPath);
		assert.equal(workspace.path, folderPath);
		assert.equal(workspace.title, folderName);

		client.send(JSON.stringify({ type: "directories", path: folderPath }));
		const listing = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(listing.kind, "directories");
		assert.equal(listing.path, folderPath);
		client.close();
	});

	it("distinguishes invalid paths, missing directories and illegal names", async () => {
		const harness = await startHarness();
		const client = await harness.connectPaired();

		client.send(JSON.stringify({ type: "directories", path: "relative/path" }));
		let response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "error");
		assert.equal(response.code, "bad-request");
		assert.equal(response.requestType, "directories");

		client.send(JSON.stringify({ type: "directories", path: "/nonexistent-dir-xyz" }));
		response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "error");
		assert.equal(response.code, "directory-not-found");

		client.send(JSON.stringify({ type: "directory-create", path: "/", name: "../escape" }));
		response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "error");
		assert.equal(response.code, "directory-name-invalid");
		assert.equal(response.requestType, "directory-create");

		client.send(JSON.stringify({ type: "workspace-create", path: "not-absolute" }));
		response = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(response.kind, "error");
		assert.equal(response.code, "bad-request");
		assert.equal(response.requestType, "workspace-create");
		client.close();
	});
});
describe("router: provider management (models.json)", () => {
	it("saves, lists, and deletes a provider without leaking the api key", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
		const client = await harness.connectPaired();

		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
			}),
		);
		const saved = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(saved.kind, "provider-saved");
		// 注入的 scripted registry 没有 refresh 能力（ModelRegistryLike 的可选投影）：
		// 保存路径跳过刷新并视为成功，不影响 provider-saved 应答。
		assert.equal(saved.refreshed, true);

		client.send(JSON.stringify({ type: "providers" }));
		const listed = await client.nextMessage();
		assert.equal(listed.kind, "providers");
		const providers = listed.providers as Array<Record<string, unknown>>;
		assert.equal(providers.length, 1);
		assert.equal(providers[0].id, "relayA");
		assert.equal(providers[0].baseUrl, "https://relay.example/v1");
		assert.equal(providers[0].apiKeySet, true);
		assert.equal(JSON.stringify(listed).includes("sk-secret"), false);

		client.send(JSON.stringify({ type: "provider-delete", id: "relayA" }));
		assert.equal((await client.nextMessage()).kind, "provider-deleted");

		client.send(JSON.stringify({ type: "provider-delete", id: "relayA" }));
		const missing = await client.nextMessage();
		assert.equal(missing.kind, "error");
		assert.equal(missing.code, "provider-not-found");
		client.close();
	});

	it("provider-delete clears every pattern of that provider (glob and per-model)", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		// 预置一条**具体模型** pattern（历史遗留形态）：旧实现只删 `providerId/*`，
		// 这种条目清不掉，会永久残留（用户实测踩过）。
		const enabledPatterns: string[] = ["other/*", "relayA/example-model-flash"];
		const appended: string[] = [];
		const removed: string[] = [];
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			enabledModelsLoader: () => [...enabledPatterns],
			// 注入的 appender/remover 模拟真实 settings.json 的写回（增删 pattern），
			// 覆盖全量写（生产走 SettingsManager.setEnabledModels）。
			enabledModelsAppender: (pattern) => {
				enabledPatterns.push(pattern);
				appended.push(pattern);
			},
			enabledModelsRemover: (pattern) => {
				const index = enabledPatterns.indexOf(pattern);
				if (index >= 0) enabledPatterns.splice(index, 1);
				removed.push(pattern);
			},
		});
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
			}),
		);
		const saved = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(saved.kind, "provider-saved");
		assert.equal(saved.admitted, undefined);
		// 保存模型定义不能扩大scope；删除依然清理已失效的具体项。
		assert.deepEqual(appended, []);
		assert.deepEqual(enabledPatterns, ["other/*", "relayA/example-model-flash"]);
		client.send(JSON.stringify({ type: "provider-delete", id: "relayA" }));
		assert.equal((await client.nextMessage()).kind, "provider-deleted");
		// 通配符与具体模型条目都被清掉；别的 provider 不动。
		assert.deepEqual(removed, ["relayA/example-model-flash"]);
		assert.deepEqual(enabledPatterns, ["other/*"]);
		client.close();
	});

	it("provider-put clears the patterns of models removed in that edit", async () => {
		// 用户实测场景：手机端在 provider 编辑里删掉模型行，models.json 更新了，
		// settings.enabledModels 里的具体 pattern 却永久残留（`relayA/<模型名>`）。
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					relayA: {
						baseUrl: "https://relay.example/v1",
						apiKey: "sk-secret",
						models: [{ id: "example-model-flash" }, { id: "deepseek-v4-flash" }],
					},
				},
			}),
		);
		const enabledPatterns: string[] = [
			"relayA/*",
			"relayA/example-model-flash",
			// 手写的 `:<thinkingLevel>` 形态（pi 合法）：剥后缀后同样要清掉。
			"relayA/example-model-flash:high",
			"other/*",
		];
		const removed: string[] = [];
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			enabledModelsLoader: () => [...enabledPatterns],
			enabledModelsAppender: (pattern) => {
				enabledPatterns.push(pattern);
			},
			enabledModelsRemover: (pattern) => {
				const index = enabledPatterns.indexOf(pattern);
				if (index >= 0) enabledPatterns.splice(index, 1);
				removed.push(pattern);
			},
		});
		const client = await harness.connectPaired();
		// 编辑时只提交剩下的那个模型 = 手机端删掉了 example-model-flash 这一行。
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				models: [{ id: "deepseek-v4-flash" }],
			}),
		);
		assert.equal((await client.nextMessage()).kind, "provider-saved");
		assert.deepEqual(removed, ["relayA/example-model-flash", "relayA/example-model-flash:high"]);
		assert.deepEqual(enabledPatterns, ["relayA/*", "other/*"]);
		client.close();
	});

	it("provider-put/delete trigger pi's models.json reload after the write", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const refreshCalls: Array<{ allowNetwork?: boolean }> = [];
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			modelRegistry: {
				...testModelRegistry(),
				refresh: (options) => {
					refreshCalls.push(options ?? {});
					return Promise.resolve(undefined);
				},
			},
		});
		const client = await harness.connectPaired();

		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
			}),
		);
		const saved = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(saved.kind, "provider-saved");
		assert.equal(saved.refreshed, true);

		client.send(JSON.stringify({ type: "provider-delete", id: "relayA" }));
		const deleted = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(deleted.kind, "provider-deleted");
		assert.equal(deleted.refreshed, true);
		// 落盘之后各触发一次原地刷新（allowNetwork:false 与 create 缺省对齐，
		// 避免网络目录刷新造成卡顿）。
		assert.deepEqual(refreshCalls, [{ allowNetwork: false }, { allowNetwork: false }]);
		client.close();
	});

	it("reports refreshed=false when the reload throws, keeping the save itself successful", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			modelRegistry: {
				...testModelRegistry(),
				refresh: () => Promise.reject(new Error("boom")),
			},
		});
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
			}),
		);
		const saved = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(saved.kind, "provider-saved");
		assert.equal(saved.refreshed, false);
		// 刷新失败不回滚保存：models.json 已写入、应答仍带 provider。
		assert.equal((saved.provider as Record<string, unknown>).id, "relayA");
		client.close();
	});

	it("reports refreshed=false when pi degrades the catalog without throwing", async () => {
		// pi 对坏 models.json 不抛错（ModelConfig.load 返回带 error 的空配置）：
		// 只靠 catch 会把它误报为成功，读 getError() 才能识别静默降级。
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			modelRegistry: {
				...testModelRegistry(),
				refresh: () => Promise.resolve(undefined),
				getError: () => "Invalid models.json schema: …",
			},
		});
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
			}),
		);
		const saved = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(saved.kind, "provider-saved");
		assert.equal(saved.refreshed, false);
		client.close();
	});

	it("provider-models falls back to the stored apiKey (phone is credential-blind)", async () => {
		// 编辑已有 provider 时表单里没有 apiKey（手机不存 Key）。拉取必须走网关并回退
		// 用 models.json 里已存的那个，否则必然 401——用户实测的"测试连接能过、
		// 拉取模型报 401"，正是因为后者当时是手机直连、用的是空 key。
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					p: {
						baseUrl: "https://relay.example/v1",
						apiKey: "sk-stored",
						models: [{ id: "m1", api: "openai-completions" }],
					},
				},
			}),
		);
		const calls: Array<{ url: string; auth?: string }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({ url: String(url), auth: headers.authorization ?? headers["x-api-key"] });
			return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
			const client = await harness.connectPaired();
			// 只带 id（编辑已有 provider 的常态）：baseUrl / apiKey 都该回退盘上值。
			client.send(JSON.stringify({ type: "provider-models", id: "p" }));
			const result = (await client.nextMessage()) as Record<string, unknown>;
			assert.equal(result.kind, "provider-models-result");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["m1", "m2"]);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://relay.example/v1/models");
			assert.equal(calls[0].auth, "Bearer sk-stored");
			client.close();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("provider-test selects the requested model's baseUrl override instead of the sorted first model", async () => {
		const modelsPath = join(tempDir("pi-mgw-provider-override-"), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					relayA: {
						baseUrl: "https://common.example/v1",
						apiKey: "fake-key",
						models: [
							{ id: "openai", api: "openai-completions" },
							{ id: "claude", api: "anthropic-messages", baseUrl: "https://anthropic.example/custom" },
						],
					},
				},
			}),
		);
		const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
		const client = await harness.connectPaired();
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (url) => {
			calls.push(String(url));
			return new Response('{"data":[{"id":"listed"}]}', { status: 200 });
		}) as typeof fetch;
		try {
			// The draft common URL must not replace the selected model override.
			client.send(
				JSON.stringify({
					type: "provider-test",
					id: "relayA",
					model: "claude",
					api: "anthropic-messages",
					baseUrl: "https://draft.example/v1",
				}),
			);
			const tested = await client.nextMessage();
			assert.equal(tested.kind, "provider-test-result");
			assert.equal(tested.ok, true);
			assert.equal(calls.at(-1), "https://anthropic.example/custom/v1/messages");
			// Explicit model draft overrides stored value; null explicitly inherits the public draft.
			client.send(
				JSON.stringify({
					type: "provider-test",
					id: "relayA",
					model: "claude",
					api: "anthropic-messages",
					baseUrl: "https://draft.example/v1",
					modelBaseUrl: "https://another.example/relay",
				}),
			);
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://another.example/relay/v1/messages");
			client.send(
				JSON.stringify({
					type: "provider-test",
					id: "relayA",
					model: "claude",
					api: "anthropic-messages",
					baseUrl: "https://root.example",
					modelBaseUrl: null,
				}),
			);
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://root.example/v1/messages");
			assert.equal(JSON.stringify(tested).includes("fake-key"), false);
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "claude" }));
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://anthropic.example/custom/v1/messages");
			// Provider-level model listing uses the draft common URL, not a model override.
			client.send(
				JSON.stringify({
					type: "provider-models",
					id: "relayA",
					api: "anthropic-messages",
					baseUrl: "https://draft.example/v1",
				}),
			);
			assert.equal((await client.nextMessage()).ok, true);
			// Path joining stays Pi-compatible; a draft containing /v1 is not silently rewritten.
			assert.equal(calls.at(-1), "https://draft.example/v1/v1/models?limit=100");
			client.send(
				JSON.stringify({
					type: "provider-models",
					id: "relayA",
					model: "claude",
					api: "openai-completions",
					baseUrl: "https://draft.example/v1",
				}),
			);
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://draft.example/v1/models", "清单忽略未知model字段");
			// A different existing model has no override, so the draft common URL is tested.
			client.send(
				JSON.stringify({ type: "provider-test", id: "relayA", model: "openai", baseUrl: "https://draft.example/v1" }),
			);
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://draft.example/v1/chat/completions");
			// New rows must not accidentally inherit another model's baseUrl/API.
			client.send(
				JSON.stringify({
					type: "provider-test",
					id: "relayA",
					model: "new",
					api: "openai-responses",
					baseUrl: "https://draft.example/v1",
				}),
			);
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(calls.at(-1), "https://draft.example/v1/responses");
			// A phone save re-sends the editable fields only. Host model overrides survive.
			client.send(
				JSON.stringify({
					type: "provider-put",
					id: "relayA",
					baseUrl: "https://draft.example/v1",
					models: [
						{ id: "openai", api: "openai-completions" },
						{ id: "claude", api: "anthropic-messages" },
					],
				}),
			);
			assert.equal((await client.nextMessage()).kind, "provider-saved");
			const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
			assert.equal(
				saved.providers.relayA.models.find((model: { id: string }) => model.id === "claude").baseUrl,
				"https://anthropic.example/custom",
			);
			client.send(
				JSON.stringify({
					type: "provider-put",
					id: "relayA",
					baseUrl: "https://draft.example/v1",
					models: [
						{ id: "openai", api: "openai-completions", baseUrl: "https://other-relay.example/custom/v1" },
						{ id: "claude", api: "anthropic-messages", baseUrl: null },
					],
				}),
			);
			const changed = await client.nextMessage();
			assert.equal(changed.kind, "provider-saved");
			const reread = JSON.parse(readFileSync(modelsPath, "utf8")).providers.relayA;
			assert.equal(reread.baseUrl, "https://draft.example/v1");
			assert.equal(reread.models[0].baseUrl, "https://other-relay.example/custom/v1");
			assert.equal(Object.hasOwn(reread.models[1], "baseUrl"), false);
			const echo = changed.provider as { models: Array<{ id: string; baseUrl: string | null }> };
			assert.equal(echo.models.find((model) => model.id === "claude")?.baseUrl, null);
			assert.equal(
				echo.models.find((model) => model.id === "openai")?.baseUrl,
				"https://other-relay.example/custom/v1",
			);
		} finally {
			globalThis.fetch = originalFetch;
			client.close();
		}
	});

	it("draft probe success does not certify saved config or overwrite a concurrent host edit", async () => {
		const modelsPath = join(tempDir("pi-mgw-probe-context-"), "models.json");
		const writeProvider = (baseUrl: string) =>
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						p: { baseUrl, apiKey: "fake-key", models: [{ id: "m", api: "openai-completions" }] },
					},
				}),
			);
		writeProvider("https://old.example/v1");
		const statusStore = new ProviderStatusStore(join(tempDir("pi-mgw-probe-status-"), "status.json"));
		const prior = { ok: false, testedAt: "2026-10-08T00:00:00.000Z", failureKind: "config" as const };
		statusStore.set("p", prior);
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			providerStatusStore: statusStore,
		});
		const client = await harness.connectPaired();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('{"choices":[{"message":{"content":"pong"}}]}', { status: 200 })) as typeof fetch;
		try {
			client.send(JSON.stringify({ type: "provider-test", id: "p", model: "m", baseUrl: "https://draft.example/v1" }));
			assert.equal((await client.nextMessage()).ok, true, "草稿测试结果仍回给发起卡片");
			assert.deepEqual(statusStore.get("p"), prior, "草稿成功不能给旧配置授予status.ok");
			globalThis.fetch = (async () => {
				writeProvider("https://host-changed.example/v1");
				return new Response('{"choices":[{"message":{"content":"pong"}}]}', { status: 200 });
			}) as typeof fetch;
			client.send(JSON.stringify({ type: "provider-test", id: "p", model: "m" }));
			assert.equal((await client.nextMessage()).ok, true);
			assert.deepEqual(statusStore.get("p"), prior, "在途宿主编辑不能被旧地址测试结论覆盖");
			globalThis.fetch = (async () =>
				new Response('{"choices":[{"message":{"content":"pong"}}]}', { status: 200 })) as typeof fetch;
			client.send(JSON.stringify({ type: "provider-test", id: "p", model: "m" }));
			assert.equal((await client.nextMessage()).ok, true);
			assert.equal(statusStore.get("p")?.ok, true, "实际测试当前已存配置才更新其诊断状态");
			const confirmed = statusStore.get("p");
			client.send(
				JSON.stringify({
					type: "provider-put",
					id: "p",
					name: "renamed",
					baseUrl: "https://host-changed.example/v1",
					models: [{ id: "m", api: "openai-completions", maxTokens: 256 }],
				}),
			);
			assert.equal((await client.nextMessage()).kind, "provider-saved");
			assert.deepEqual(statusStore.get("p"), confirmed, "仅改名称/数值元数据保留已测状态");
			statusStore.set("p", prior);
			client.send(JSON.stringify({ type: "provider-test", id: "p", model: "m", baseUrl: "https://fixed.example/v1" }));
			assert.equal((await client.nextMessage()).ok, true);
			assert.deepEqual(statusStore.get("p"), prior, "草稿未保存不能提前认证盘上旧配置");
			client.send(
				JSON.stringify({
					type: "provider-put",
					id: "p",
					baseUrl: "https://fixed.example/v1",
					models: [{ id: "m", api: "openai-completions" }],
				}),
			);
			assert.equal((await client.nextMessage()).kind, "provider-saved");
			assert.equal(statusStore.get("p"), undefined, "修正并保存连接配置后清过期诊断");
			assert.equal(statusStore.isActive("p"), true);
		} finally {
			globalThis.fetch = originalFetch;
			client.close();
		}
	});

	it("provider-test 失败仅更新诊断状态，Pi启用模型始终保留在菜单", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const statusStore = new ProviderStatusStore(join(tempDir("pi-mgw-provider-status-"), "provider-status.json"));
		// 目录里额外放一个 relayA/m1（真实 ModelRuntime 之外的 scripted 目录）。
		const registry: ModelRegistryLike = {
			getAvailable: () => Promise.resolve([...TEST_MODELS, { provider: "relayA", id: "m1", name: "Relay One" }]),
			getModel: (provider, modelId) =>
				provider === "relayA" && modelId === "m1" ? { provider, id: modelId, name: "Relay One" } : undefined,
			refresh: () => Promise.resolve(undefined),
		};
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			providerStatusStore: statusStore,
			providerActive: (id) => statusStore.isActive(id),
			modelRegistry: registry,
		});
		const client = await harness.connectPaired();

		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/",
				apiKey: "sk-secret",
				models: [{ id: "m1", api: "openai-completions" }],
			}),
		);
		assert.equal(((await client.nextMessage()) as Record<string, unknown>).kind, "provider-saved");

		// 未测试（无记录）＝激活：模型出现在目录里。
		client.send(JSON.stringify({ type: "models" }));
		let catalog = (await client.nextMessage()) as Record<string, unknown>;
		assert.ok(providerIds(catalog).includes("relayA"), "未测试的 provider 不应被隐藏");

		// 测试：上游把首页 HTML 当 200 返回（缺少 /v1 的真实故障）。
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("<!doctype html><html><title>gateway</title></html>", { status: 200 })) as typeof fetch;
		try {
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			const result = (await client.nextMessage()) as Record<string, unknown>;
			assert.equal(result.kind, "provider-test-result");
			assert.equal(result.ok, false);
			assert.match(String(result.error), /网页而不是 API 响应/);

			// 测试失败仍保留 Pi 模型；providers 帧只更新诊断状态。
			client.send(JSON.stringify({ type: "models" }));
			catalog = (await client.nextMessage()) as Record<string, unknown>;
			assert.equal(providerIds(catalog).includes("relayA"), true);

			client.send(JSON.stringify({ type: "providers" }));
			const listed = (await client.nextMessage()) as Record<string, unknown>;
			const entry = (listed.providers as Array<Record<string, unknown>>).find((p) => p.id === "relayA");
			assert.equal(entry?.active, false);
			assert.equal((entry?.status as Record<string, unknown>)?.ok, false);

			// 重测成功只恢复诊断状态，模型始终可选。
			globalThis.fetch = (async () =>
				new Response('{"choices":[{"message":{"content":"pong"}}]}', { status: 200 })) as typeof fetch;
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			assert.equal(((await client.nextMessage()) as Record<string, unknown>).ok, true);
			client.send(JSON.stringify({ type: "models" }));
			catalog = (await client.nextMessage()) as Record<string, unknown>;
			assert.ok(providerIds(catalog).includes("relayA"));
		} finally {
			globalThis.fetch = originalFetch;
		}

		// 保存改变连接配置会清掉过期诊断；仅改元数据则保留，保存后不自动重测。
		globalThis.fetch = (async () =>
			new Response("<!doctype html><html><title>still broken</title></html>", { status: 200 })) as typeof fetch;
		client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
		assert.equal(((await client.nextMessage()) as Record<string, unknown>).ok, false);
		assert.equal(statusStore.isActive("relayA"), false);
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				models: [{ id: "m1", api: "openai-completions" }],
			}),
		);
		assert.equal(((await client.nextMessage()) as Record<string, unknown>).kind, "provider-saved");
		// 公共地址由/修正为/v1，旧配置的失败不再认证当前配置。
		assert.equal(statusStore.get("relayA"), undefined, "连接配置改变后清过期诊断");
		assert.equal(statusStore.isActive("relayA"), true);

		// 不传 id 的测试只探活不落状态（表单预览场景）。
		client.send(JSON.stringify({ type: "provider-test", baseUrl: "https://probe.example/v1", model: "m1" }));
		const probe = (await client.nextMessage()) as Record<string, unknown>;
		assert.equal(probe.kind, "provider-test-result");
		assert.equal(probe.id, null);
		assert.equal(statusStore.get("probe.example"), undefined);

		// 删除 provider 一并清掉测试状态，重建后不会被旧结论隐藏。
		client.send(JSON.stringify({ type: "provider-delete", id: "relayA" }));
		assert.equal(((await client.nextMessage()) as Record<string, unknown>).kind, "provider-deleted");
		assert.equal(statusStore.get("relayA"), undefined);
		client.close();
	});

	it("临时类失败（超时）不落盘：上游抖动不改变激活状态", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const statusStore = new ProviderStatusStore(join(tempDir("pi-mgw-provider-status-"), "provider-status.json"));
		const registry: ModelRegistryLike = {
			getAvailable: () => Promise.resolve([...TEST_MODELS, { provider: "relayA", id: "m1", name: "Relay One" }]),
			getModel: (provider, modelId) =>
				provider === "relayA" && modelId === "m1" ? { provider, id: modelId, name: "Relay One" } : undefined,
			refresh: () => Promise.resolve(undefined),
		};
		const harness = await startHarness({
			providerStore: new PiProviderStore({ path: modelsPath }),
			providerStatusStore: statusStore,
			providerActive: (id) => statusStore.isActive(id),
			modelRegistry: registry,
		});
		const client = await harness.connectPaired();
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://relay.example/v1",
				apiKey: "sk-secret",
				models: [{ id: "m1", api: "openai-completions" }],
			}),
		);
		assert.equal(((await client.nextMessage()) as Record<string, unknown>).kind, "provider-saved");

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("The operation was aborted due to timeout");
		}) as typeof fetch;
		try {
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			const result = (await client.nextMessage()) as Record<string, unknown>;
			assert.equal(result.ok, false);
			assert.equal(result.failureKind, "transient");
			// 关键：transient 只清过期失败、保留旧成功（本例先无记录）→ provider 仍为激活，模型仍在菜单。
			assert.equal(statusStore.get("relayA"), undefined);
			assert.equal(statusStore.isActive("relayA"), true);
			const priorOk = { ok: true, testedAt: "2026-10-08T00:00:00.000Z" };
			statusStore.set("relayA", priorOk);
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			assert.equal((await client.nextMessage()).failureKind, "transient");
			assert.deepEqual(statusStore.get("relayA"), priorOk, "transient不得删除旧成功记录");

			client.send(JSON.stringify({ type: "models" }));
			const catalog = (await client.nextMessage()) as Record<string, unknown>;
			assert.ok(providerIds(catalog).includes("relayA"), "临时失败不应把模型移出菜单");

			// config 失败先落盘（灰显），随后一次 transient 失败应**清掉旧记录**：
			// 上游抖动既不能解除旧禁用，也不能把已改对的配置重新标成未连通。
			globalThis.fetch = (async () =>
				new Response("<!doctype html><html>nope</html>", { status: 200 })) as typeof fetch;
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			assert.equal(((await client.nextMessage()) as Record<string, unknown>).ok, false);
			assert.equal(statusStore.isActive("relayA"), false);

			globalThis.fetch = (async () => {
				throw new Error("The operation was aborted due to timeout");
			}) as typeof fetch;
			client.send(JSON.stringify({ type: "provider-test", id: "relayA", model: "m1" }));
			const transientAgain = (await client.nextMessage()) as Record<string, unknown>;
			assert.equal(transientAgain.failureKind, "transient");
			assert.equal(statusStore.get("relayA"), undefined, "transient 应清除旧 config 记录");
			assert.equal(statusStore.isActive("relayA"), true);
		} finally {
			globalThis.fetch = originalFetch;
		}
		client.close();
	});

	it("saves a full model definition with thinkingLevelMap and echoes it back", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
		const client = await harness.connectPaired();

		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relay2",
				baseUrl: "https://relay2.example/v1",
				apiKey: "sk-2",
				api: "anthropic-messages",
				models: [
					{
						id: "m1",
						name: "Model One",
						contextWindow: 200_000,
						maxTokens: 65_536,
						reasoning: true,
						thinkingLevelMap: { off: null, low: "low", medium: "high", high: "high" },
					},
				],
			}),
		);
		const saved = await client.nextMessage();
		assert.equal(saved.kind, "provider-saved");
		const savedProvider = saved.provider as { models: Array<{ thinkingLevelMap: Record<string, string | null> }> };
		assert.equal(savedProvider.models[0].thinkingLevelMap.medium, "high");

		client.send(JSON.stringify({ type: "providers" }));
		const listed = await client.nextMessage();
		const providers = listed.providers as Array<Record<string, unknown>>;
		assert.equal(providers[0].api, "anthropic-messages");
		assert.equal((providers[0].models as Array<{ contextWindow: number }>)[0].contextWindow, 200_000);
		client.close();
	});

	it("put merges host-managed extras and preserves the key when omitted", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					relayA: {
						name: "Old Name",
						baseUrl: "https://old.example/v1",
						apiKey: "sk-keep",
						models: [
							{
								id: "m1",
								name: "Old",
								compat: { supportsStore: false, chatTemplateKwargs: { $var: "thinking.effort" } },
								cost: { input: 1, output: 2 },
							},
						],
					},
				},
			}),
		);
		const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
		const client = await harness.connectPaired();

		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://new.example/v1",
				models: [
					{ id: "m1", name: "New", api: "openai-completions", contextWindow: 100, compat: { supportsStore: true } },
					{ id: "m2", name: "Second" },
				],
			}),
		);
		const saved = await client.nextMessage();
		assert.equal(saved.kind, "provider-saved");
		assert.equal((saved.provider as Record<string, unknown>).apiKeySet, true);
		assert.equal(JSON.stringify(saved).includes("sk-keep"), false);

		const onDisk = JSON.parse(readFileSync(modelsPath, "utf8"));
		const stored = onDisk.providers.relayA;
		assert.equal(stored.apiKey, "sk-keep");
		assert.equal(stored.baseUrl, "https://new.example/v1");
		assert.equal(stored.name, "Old Name"); // 缺省保留原值：没发 name 不动
		assert.equal(stored.models[0].compat.supportsStore, true);
		assert.equal(stored.models[0].compat.chatTemplateKwargs.$var, "thinking.effort");
		assert.equal(stored.models[0].cost.input, 1);
		assert.equal(stored.models[0].contextWindow, 100);
		assert.equal(stored.models[0].api, "openai-completions");
		assert.equal(stored.api, undefined); // 手机不发 provider 级 api：缺省保留原值（原来就没有）
		assert.equal(stored.models[1].id, "m2");
		assert.equal(stored.models[1].compat, undefined);

		// 发 compat:{}（表单全部默认）只清手机可编辑键；宿主嵌套键保留。
		client.send(
			JSON.stringify({
				type: "provider-put",
				id: "relayA",
				baseUrl: "https://new.example/v1",
				models: [{ id: "m1", compat: {} }],
			}),
		);
		await client.nextMessage();
		const afterClear = JSON.parse(readFileSync(modelsPath, "utf8"));
		const clearedCompat = afterClear.providers.relayA.models[0].compat as Record<string, unknown> | undefined;
		assert.equal(clearedCompat?.supportsStore, undefined);
		assert.equal((clearedCompat?.chatTemplateKwargs as Record<string, unknown> | undefined)?.$var, "thinking.effort");
		assert.equal(afterClear.providers.relayA.apiKey, "sk-keep");
		// 重发同 id 模型不带模型级 api：宿主已有值保留。
		assert.equal(afterClear.providers.relayA.models[0].api, "openai-completions");
		client.close();
	});

	it("rejects malformed provider-put frames", async () => {
		const modelsPath = join(tempDir("pi-mgw-providers-"), "models.json");
		const harness = await startHarness({ providerStore: new PiProviderStore({ path: modelsPath }) });
		const client = await harness.connectPaired();

		client.send(JSON.stringify({ type: "provider-put", baseUrl: "https://x.example/v1" }));
		let response = await client.nextMessage();
		assert.equal(response.code, "bad-request");

		client.send(JSON.stringify({ type: "provider-put", id: "p", baseUrl: "ftp://x.example" }));
		response = await client.nextMessage();
		assert.equal(response.code, "bad-request");

		client.send(JSON.stringify({ type: "provider-put", id: "p", models: "nope" }));
		response = await client.nextMessage();
		assert.equal(response.code, "bad-request");
		client.close();
	});
});

// ---------------------------------------------------------------------------
// attachment（§4.22）：路由层帧契约为端到端（真 loopback WS）
// ---------------------------------------------------------------------------

describe("router: attachment (integration)", () => {
	/** 默认 fixture 会话注入带两图的 user 条目（e_img）；其余沿旧 fixture。 */
	function extraImageFixture(sessionDir: string): void {
		const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		const line = JSON.stringify({
			type: "message",
			id: "e_img",
			parentId: "e2",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "看图" },
					{ type: "image", data: PNG_BASE64_ROUTER, mimeType: "image/png" },
				],
			},
		});
		appendFileSync(path, `${line}\n`);
	}

	it("capability 宣告含 attachment；成功取图三元回显且 bytes=解码长度", async () => {
		const harness = await startHarness({ extraFixture: extraImageFixture });
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e_img", imageIndex: 0 }));
		const response = await client.nextMessage();
		assert.equal(response.kind, "attachment");
		assert.equal(response.sessionId, SESSION_ID);
		assert.equal(response.entryId, "e_img");
		assert.equal(response.imageIndex, 0);
		assert.equal(response.mediaType, "image/png");
		assert.equal(response.bytes, Buffer.from(PNG_BASE64_ROUTER, "base64").length);
		assert.equal(response.dataBase64, PNG_BASE64_ROUTER);
		client.close();
	});

	it("history 含 dataOmitted 剥图后再用 attachment 取回原字节", async () => {
		// 大图（700KiB base64，>512KiB 单条消息预算）直接写入 fixture：真实
		// projection 路径把它削成 dataOmitted 占位，再按 entryId+imageIndex 取回。
		const bigImage = Buffer.alloc(700 * 1024).toString("base64");
		const bigImageFixture = (sessionDir: string): void => {
			const line = JSON.stringify({
				type: "message",
				id: "e_big",
				parentId: "e2",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "大图消息" },
						{ type: "image", data: bigImage, mimeType: "image/png" },
					],
				},
			});
			appendFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), `${line}\n`);
		};
		const harness = await startHarness({ extraFixture: bigImageFixture });
		const client = await harness.connectPaired();
		client.send(JSON.stringify({ type: "history", sessionId: SESSION_ID }));
		const page = await client.nextMessage();
		assert.equal(page.kind, "history");
		const messages = page.messages as Array<Record<string, unknown>>;
		const imageMessage = messages.find(
			(message) =>
				Array.isArray(message.content) &&
				(message.content as Array<Record<string, unknown>>).some((block) => block.dataOmitted === true),
		);
		assert.ok(imageMessage, "history 必须把大图削成 dataOmitted 占位");
		// entryIds 与 messages 平行对齐，定位剥图条目的 entryId。
		const entryIds = page.entryIds as string[];
		const entryId = entryIds[messages.indexOf(imageMessage)];
		assert.equal(typeof entryId, "string");
		// 按需取回原图。
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId, imageIndex: 0 }));
		const reply = await client.nextMessage();
		assert.equal(reply.kind, "attachment");
		assert.equal(reply.bytes, 700 * 1024);
		assert.equal(Buffer.compare(Buffer.from(reply.dataBase64 as string, "base64"), Buffer.alloc(700 * 1024)), 0);
		client.close();
	});

	it("错误帧带完整三元关联；输入非法 → bad-request；未知会话 → session-not-found", async () => {
		const harness = await startHarness({ extraFixture: extraImageFixture });
		const client = await harness.connectPaired();

		// 非 user 条目（fixture 的 e2 是 assistant）。
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e2", imageIndex: 0 }));
		let response = await client.nextMessage();
		assert.equal(response.kind, "error");
		assert.equal(response.code, "attachment-not-found");
		assert.equal(response.requestType, "attachment");
		assert.equal(response.sessionId, SESSION_ID);
		assert.equal(response.entryId, "e2");
		assert.equal(response.imageIndex, 0);

		// 越界索引：e_img 只有 1 张图。
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e_img", imageIndex: 5 }));
		response = await client.nextMessage();
		assert.equal(response.code, "attachment-not-found");
		assert.equal(response.imageIndex, 5);

		// 输入非法：负数/非整数/缺 entryId。
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e_img", imageIndex: -1 }));
		response = await client.nextMessage();
		assert.equal(response.code, "bad-request");
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e_img", imageIndex: 1.5 }));
		response = await client.nextMessage();
		assert.equal(response.code, "bad-request");
		client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID }));
		response = await client.nextMessage();
		assert.equal(response.code, "bad-request");

		// 未知会话 → session-not-found（带三元关联）。
		client.send(JSON.stringify({ type: "attachment", sessionId: "ghost", entryId: "e_img", imageIndex: 0 }));
		response = await client.nextMessage();
		assert.equal(response.code, "session-not-found");
		assert.equal(response.requestType, "attachment");
		assert.equal(response.entryId, "e_img");
		client.close();
	});

	it("runtime.attachment 抛普通 Error：internal 错误帧仍带完整三元关联且不泄露异常细节", async () => {
		const harness = await startHarness({ extraFixture: extraImageFixture });
		const client = await harness.connectPaired();
		const original = harness.runtime.attachment.bind(harness.runtime);
		(harness.runtime as unknown as { attachment: unknown }).attachment = () =>
			Promise.reject(new Error("boom: /secret/fs/path leaked?"));
		try {
			client.send(JSON.stringify({ type: "attachment", sessionId: SESSION_ID, entryId: "e_img", imageIndex: 0 }));
			const response = await client.nextMessage();
			assert.equal(response.kind, "error");
			assert.equal(response.code, "internal");
			// 固定通用文案，不回显异常消息（可能含文件系统路径）。
			assert.equal(response.message, "internal error");
			assert.ok(!String(response.message).includes("/secret/fs/path"));
			// 完整三元关联不因未知异常而缺失。
			assert.equal(response.requestType, "attachment");
			assert.equal(response.sessionId, SESSION_ID);
			assert.equal(response.entryId, "e_img");
			assert.equal(response.imageIndex, 0);
			// 内部细节留在网关日志。
			assert.ok(
				harness.logs.some(
					(line) => line.includes("internal error handling attachment frame") && line.includes("/secret/fs/path"),
				),
			);
		} finally {
			(harness.runtime as unknown as { attachment: unknown }).attachment = original;
		}
		client.close();
	});
});
