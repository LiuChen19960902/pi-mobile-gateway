// 复审 F3–F9 的回归用例：生产 router + 扩展 IPC，合成 socket/上下文，不运行模型。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import mobileBridge from "../bridge-extension/src/index.ts";
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
	failAbortWithQueuedText: (text: string | null) => void;
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
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
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
					request.op === "abort" && abortFailureText !== null
						? { ok: false, code: "submission-failed", queuedText: abortFailureText }
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
		failAbortWithQueuedText: (text: string | null) => {
			abortFailureText = text;
		},
	};
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

	it("abort failure keeps queued text and operation identity for the client", async () => {
		const fixture = await startRouterFixture();
		fixture.failAbortWithQueuedText("queued draft");
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
}

async function startExtension(initialEditor?: unknown): Promise<ExtensionFixture> {
	const root = tempDir("pi-mgw-extension-");
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let sends = 0;
	let text: unknown = "";
	let aborts = 0;
	let idle = true;
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
		hasPendingMessages: () => false,
		abort: async () => {
			aborts += 1;
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
			await assert.rejects(
				() => hub.abort(fixture.descriptor(), { operationId: "abort-later", restoreQueued: true }),
				(error: unknown) => (error as { code?: string }).code === "editor-unavailable",
			);
			assert.equal(fixture.abortCalls(), 0, "取不到队列时不能先 abort");
		} finally {
			await stopExtension(fixture);
			assert.equal(fixture.currentEditor(), otherEditor);
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
