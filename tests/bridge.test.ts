// 桥接 hub 与路由帧的单元测试：假扩展 socket + 临时注册表，不启动真实 Pi。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BRIDGE_SCHEMA, type BridgeSnapshot } from "../bridge-extension/src/protocol.ts";
import { BridgeHub, BridgeRequestError } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { type ModelRegistryLike, PiRuntime } from "../src/pi-runtime.ts";
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

function snapshotFor(sessionId: string, overrides: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
	return {
		schema: BRIDGE_SCHEMA,
		extensionVersion: "0.1.0",
		instanceId: "instance-1",
		epoch: "epoch-1",
		sessionId,
		pid: process.pid,
		socketPath: "",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		owner: true,
		seq: 3,
		busy: false,
		pending: false,
		leafId: "leaf-1",
		model: { provider: "fixture", modelId: "offline" },
		thinkingLevel: "off",
		editor: "bridge",
		partial: null,
		tools: [],
		...overrides,
	};
}

interface FakeBridge {
	root: string;
	descriptor: Record<string, unknown>;
	sessionId: string;
	received: Array<Record<string, unknown>>;
	snapshot: BridgeSnapshot;
	pushEvent: (event: unknown) => void;
	setSnapshot: (next: Partial<BridgeSnapshot>) => void;
	replyOverride: { code?: string } | null;
}

function startFakeBridge(sessionId: string, overrides: Partial<BridgeSnapshot> = {}): FakeBridge {
	const root = tempDir("pi-mgw-bridge-");
	mkdirSync(join(root, "registry"), { recursive: true });
	mkdirSync(join(root, "sockets"), { recursive: true });
	const socketPath = join(root, "sockets", "instance-1.sock");
	const state = {
		root,
		sessionId,
		received: [] as Array<Record<string, unknown>>,
		snapshot: snapshotFor(sessionId, { ...overrides, socketPath }),
		pushEvent: (_event: unknown) => {},
		setSnapshot: (next: Partial<BridgeSnapshot>) => {
			state.snapshot = { ...state.snapshot, ...next };
		},
		replyOverride: null as { code?: string } | null,
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.write(`${JSON.stringify({ kind: "hello", snapshot: state.snapshot })}\n`);
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as Record<string, unknown>;
				state.received.push(request);
				if (state.replyOverride) {
					socket.write(
						`${JSON.stringify({ kind: "reply", id: request.id, ok: false, code: state.replyOverride.code })}\n`,
					);
					continue;
				}
				const base = { kind: "reply", id: request.id, ok: true };
				if (request.op === "snapshot") {
					socket.write(`${JSON.stringify({ ...base, snapshot: state.snapshot })}\n`);
				} else if (request.op === "history") {
					socket.write(
						`${JSON.stringify({
							...base,
							entries: [{ id: "a1", type: "message", message: { role: "user", content: "hello", timestamp: 1 } }],
							hasMore: false,
							oldestEntryId: "a1",
							leafId: "a1",
							model: state.snapshot.model,
							thinkingLevel: "off",
							busy: false,
							pending: false,
						})}\n`,
					);
				} else if (request.op === "send") {
					socket.write(`${JSON.stringify({ ...base, status: "submitted" })}\n`);
				} else if (request.op === "abort") {
					socket.write(
						`${JSON.stringify({ ...base, status: "settled", busy: false, queuedText: "steer\n\nfollow" })}\n`,
					);
				} else if (request.op === "dequeue") {
					socket.write(`${JSON.stringify({ ...base, queuedText: "steer\n\nfollow", pending: false, busy: true })}\n`);
				} else {
					socket.write(`${JSON.stringify({ ...base, ok: false, code: "unsupported" })}\n`);
				}
			}
		});
		state.pushEvent = (event: unknown) => {
			state.snapshot = { ...state.snapshot, seq: state.snapshot.seq + 1 };
			socket.write(
				`${JSON.stringify({
					kind: "event",
					instanceId: state.snapshot.instanceId,
					epoch: state.snapshot.epoch,
					sessionId,
					seq: state.snapshot.seq,
					event,
				})}\n`,
			);
		};
	});
	servers.push(server);
	server.listen(socketPath);
	const descriptor = {
		...snapshotFor(sessionId, { ...overrides, socketPath }),
		startedAt: new Date().toISOString(),
	};
	writeFileSync(join(root, "registry", `${sessionId}.json`), `${JSON.stringify(descriptor)}\n`);
	return state as FakeBridge;
}

function emptyRuntime(sessionDir: string): PiRuntime {
	const modelRegistry: ModelRegistryLike = {
		getAvailable: () => Promise.resolve([]),
		getModel: () => undefined,
	};
	return new PiRuntime({
		agentDir: tempDir("pi-mgw-bridge-agent-"),
		sessionDir,
		modelRegistry,
		sessionFactory: async () => {
			throw new Error("bridge tests never construct SDK sessions");
		},
	});
}

async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timeout: ${label}`);
}

describe("bridge hub", () => {
	it("discovers live instances, forwards operations and rejects stale schema or dead pids", async () => {
		const live = startFakeBridge("session-live");
		await new Promise((resolve) => setTimeout(resolve, 30));
		const hub = new BridgeHub({ root: live.root });
		const [descriptor] = hub.descriptors();
		assert.ok(descriptor);
		const descriptors = [descriptor];
		assert.equal(descriptor.sessionId, "session-live");
		assert.equal(descriptor.owner, true);

		const snapshot = await hub.snapshot(descriptor);
		assert.equal(snapshot.pid, process.pid);
		assert.equal(snapshot.busy, false);

		live.setSnapshot({ busy: true });
		const reply = await hub.send(descriptor, { operationId: "op-1", text: "hi", deliverAs: "followUp" });
		assert.equal(reply.status, "submitted");
		const sent = live.received.at(-1);
		assert.equal(sent?.op, "send");
		assert.equal(sent?.operationId, "op-1");
		assert.equal(sent?.deliverAs, "followUp");

		live.replyOverride = { code: "busy" };
		await assert.rejects(
			() => hub.send(descriptor, { operationId: "op-2", text: "hi" }),
			(error: unknown) => error instanceof BridgeRequestError && error.code === "busy",
		);

		// 陈旧 schema 与已退出进程的描述符都不进入发现列表。
		const staleRoot = tempDir("pi-mgw-bridge-stale-");
		mkdirSync(join(staleRoot, "registry"), { recursive: true });
		writeFileSync(
			join(staleRoot, "registry", "stale.json"),
			`${JSON.stringify({ ...descriptors[0], schema: BRIDGE_SCHEMA + 1 })}\n`,
		);
		writeFileSync(join(staleRoot, "registry", "dead.json"), `${JSON.stringify({ ...descriptors[0], pid: 0 })}\n`);
		const staleHub = new BridgeHub({ root: staleRoot });
		assert.deepEqual(staleHub.descriptors(), []);
	});
});

describe("router bridge frames", () => {
	it("re-attaches a session after switching sdk -> bridge -> sdk", async () => {
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-bridge-mode-"), "host-mode.json"));
		const bridge = new BridgeHub({ root: tempDir("pi-mgw-bridge-empty-") });
		let attaches = 0;
		let unsubscribes = 0;
		const handle = {
			attach: () => {
				attaches += 1;
				return () => {};
			},
		};
		const runtime = Object.assign(Object.create(PiRuntime.prototype), {
			listSessions: async () => [],
			openSession: async () => handle,
			unsubscribe: () => {
				unsubscribes += 1;
			},
			extensionStatuses: () => ({}),
		}) as PiRuntime;
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge });
		const last = () => frames.at(-1) as Record<string, unknown>;

		await client.handleMessage({ type: "subscribe", sessionId: "s-1" });
		assert.equal(attaches, 1);
		await client.handleMessage({ type: "host-mode-put", mode: "bridge" });
		assert.equal(last().mode, "bridge");
		assert.equal(unsubscribes, 1);
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(last().mode, "sdk");
		await client.handleMessage({ type: "subscribe", sessionId: "s-1" });
		assert.equal(attaches, 2);
		client.close();
	});

	it("marks disk-only bridge history offline for each fresh client", async () => {
		const sessionDir = tempDir("pi-mgw-bridge-offline-sessions-");
		const session = SessionManager.create(tempDir("pi-mgw-bridge-offline-project-"), sessionDir);
		session.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() });
		const runtime = emptyRuntime(sessionDir);
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-bridge-offline-mode-"), "host-mode.json"));
		modeStore.write("bridge");
		const bridge = new BridgeHub({ root: tempDir("pi-mgw-bridge-offline-root-") });
		for (let attempt = 0; attempt < 2; attempt++) {
			const frames: Array<Record<string, unknown>> = [];
			const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge });
			try {
				await client.handleMessage({ type: "sessions" });
				const reply = frames.at(-1);
				assert.ok(reply);
				assert.equal(reply.mode, "bridge");
				const item = (reply.items as Array<Record<string, unknown>>).find(
					(entry) => entry.id === session.getSessionId(),
				);
				assert.ok(item);
				assert.equal(item.online, false, "each fresh session list must expose offline launch actions");
				assert.equal(item.source, undefined);
				assert.equal(item.running, false);
				assert.equal(item.runtime, undefined);
				assert.equal(item.path, session.getSessionFile());
			} finally {
				client.close();
			}
		}
		modeStore.write("sdk");
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modeStore, bridge });
		try {
			await client.handleMessage({ type: "sessions" });
			const reply = frames.at(-1);
			assert.ok(reply);
			assert.equal(reply.mode, undefined);
			const item = (reply.items as Array<Record<string, unknown>>).find((entry) => entry.id === session.getSessionId());
			assert.ok(item);
			assert.equal(item.online, undefined);
			assert.equal(item.source, undefined);
		} finally {
			client.close();
		}
	});

	it("reads native image files outside the SDK index using only the registered descriptor", async () => {
		const sessionDir = tempDir("pi-mgw-bridge-image-index-");
		const nativeDir = tempDir("pi-mgw-bridge-image-native-");
		const session = SessionManager.create(tempDir("pi-mgw-bridge-image-project-"), nativeDir);
		const data = Buffer.from("native bytes").toString("base64");
		const entryId = session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		const fake = startFakeBridge(session.getSessionId(), { sessionFile: session.getSessionFile() ?? null });
		await until(() => existsSync(fake.snapshot.socketPath), "fake socket is listening");
		const runtime = emptyRuntime(sessionDir);
		await runtime.listSessions();
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-bridge-image-mode-"), "host-mode.json"));
		modeStore.write("bridge");
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), {
			hostModeStore: modeStore,
			bridge: new BridgeHub({ root: fake.root }),
		});
		try {
			await client.handleMessage({
				type: "attachment",
				sessionId: session.getSessionId(),
				entryId,
				imageIndex: 0,
				sessionFile: "/untrusted/client/path",
			});
			assert.equal(frames.at(-1)?.kind, "attachment");
			assert.equal(frames.at(-1)?.dataBase64, data);
			assert.equal(frames.at(-1)?.sessionFile, undefined);
		} finally {
			client.close();
			runtime.disposeAll();
		}
	});

	it("keeps a described bridge instance online when its snapshot fails", async () => {
		const sessionDir = tempDir("pi-mgw-bridge-unknown-sessions-");
		const session = SessionManager.create(tempDir("pi-mgw-bridge-unknown-project-"), sessionDir);
		session.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() });
		const fake = startFakeBridge(session.getSessionId());
		fake.replyOverride = { code: "bridge-unavailable" };
		await until(() => existsSync(fake.snapshot.socketPath), "fake socket is listening");
		const bridge = new BridgeHub({ root: fake.root });
		const descriptor = bridge.descriptor(fake.sessionId);
		assert.ok(descriptor);
		await assert.rejects(
			() => bridge.snapshot(descriptor),
			(error: unknown) => error instanceof BridgeRequestError && error.code === "bridge-unavailable",
		);
		const runtime = emptyRuntime(sessionDir);
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-bridge-unknown-mode-"), "host-mode.json"));
		modeStore.write("bridge");
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), {
			hostModeStore: modeStore,
			bridge,
		});
		try {
			await client.handleMessage({ type: "sessions" });
			const reply = frames.at(-1);
			assert.ok(reply);
			const item = (reply.items as Array<Record<string, unknown>>).find((entry) => entry.id === fake.sessionId);
			assert.ok(item);
			assert.equal(item.path, session.getSessionFile());
			assert.equal(item.online, true);
			assert.equal((item.runtime as Record<string, unknown>).pid, process.pid);
		} finally {
			client.close();
		}
	});

	it("serves host mode, merged sessions, snapshot/events and write operations in bridge mode", async () => {
		const sessionId = "11111111-2222-3333-4444-555555555555";
		const fake = startFakeBridge(sessionId);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const sessionDir = tempDir("pi-mgw-bridge-sessions-");
		const runtime = emptyRuntime(sessionDir);
		const modeStore = new HostModeStore(join(tempDir("pi-mgw-bridge-mode-"), "host-mode.json"));
		const bridge = new BridgeHub({ root: fake.root });
		const frames: Array<Record<string, unknown>> = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), {
			hostModeStore: modeStore,
			bridge,
		});
		const last = () => frames.at(-1) as Record<string, unknown>;

		await client.handleMessage({ type: "host-mode" });
		assert.equal(last().kind, "host-mode");
		assert.equal(last().mode, "sdk");

		await client.handleMessage({ type: "host-mode-put", mode: "bridge" });
		assert.equal(last().mode, "bridge");
		assert.equal(last().changed, true);
		assert.equal(modeStore.read(), "bridge");

		fake.setSnapshot({ busy: true });
		await client.handleMessage({ type: "sessions" });
		const sessions = last();
		assert.equal(sessions.kind, "sessions");
		assert.equal(sessions.mode, "bridge");
		const item = (sessions.items as Array<Record<string, unknown>>)[0];
		assert.equal(item?.id, sessionId);
		assert.equal(item?.source, "bridge");
		assert.equal(item?.online, true);
		assert.equal(item?.running, true);
		assert.equal((item?.runtime as Record<string, unknown>)?.pid, process.pid);

		await client.handleMessage({ type: "subscribe", sessionId });
		assert.equal(frames.at(-1)?.kind, "subscribed");
		await until(() => frames.some((frame) => frame.kind === "bridge-snapshot"), "bridge snapshot");
		const snapshotFrame = frames.find((frame) => frame.kind === "bridge-snapshot");
		assert.equal(snapshotFrame?.busy, true);
		assert.equal(snapshotFrame?.epoch, "epoch-1");

		fake.pushEvent({ type: "message_end", message: { role: "assistant", content: "x" } });
		await until(() => frames.some((frame) => frame.kind === "event"), "forwarded event");
		const event = frames.find((frame) => frame.kind === "event");
		assert.equal(event?.seq, 1);
		assert.equal(event?.epoch, "epoch-1");
		assert.equal(event?.bridgeSeq, 4);

		await client.handleMessage({
			type: "message",
			sessionId,
			text: "hello",
			mode: "steer",
			operationId: "op-9",
			instanceId: "instance-1",
			epoch: "epoch-1",
		});
		const sent = last();
		assert.equal(sent.kind, "sent");
		assert.equal(sent.disposition, "submitted");
		assert.equal(sent.status, "submitted");
		assert.equal(sent.operationId, "op-9");
		assert.equal(sent.instanceId, "instance-1");
		assert.equal(sent.epoch, "epoch-1");
		assert.equal(sent.bridgeSeq, 4);
		assert.equal(sent.pendingMessages, false);

		await client.handleMessage({
			type: "message",
			sessionId,
			text: "stale",
			mode: "steer",
			operationId: "op-stale",
			instanceId: "instance-1",
			epoch: "old-epoch",
		});
		assert.equal(last().kind, "error");
		assert.equal(last().code, "bridge-stale-runtime");
		const sendRequest = fake.received.filter((request) => request.op === "send").at(-1);
		assert.equal(sendRequest?.text, "hello");
		assert.equal(sendRequest?.deliverAs, "steer");

		await client.handleMessage({ type: "dequeue", sessionId, queueRequestId: "q-1" });
		const dequeued = last();
		assert.equal(dequeued.kind, "dequeued");
		assert.equal(dequeued.queuedText, "steer\n\nfollow");
		assert.equal(dequeued.pending, false);
		assert.equal(dequeued.isStreaming, true);

		await client.handleMessage({ type: "abort", sessionId, restoreQueued: true, operationId: "stop-1" });
		const aborted = last();
		assert.equal(aborted.kind, "aborted");
		assert.equal(aborted.status, "settled");
		assert.equal(aborted.isStreaming, false);
		assert.equal(aborted.queuedText, "steer\n\nfollow");

		// 旧扩展不支持模型控制时明确拒绝，不回落网关 SDK。
		await client.handleMessage({
			type: "set-model",
			sessionId,
			provider: "fixture",
			modelId: "offline",
			operationId: "legacy-extension-model",
			instanceId: "instance-1",
			epoch: "epoch-1",
		});
		assert.equal(last().kind, "error");
		assert.equal(last().code, "bridge-unavailable");
		assert.equal(last().requestType, "set-model");

		await client.handleMessage({ type: "commands", sessionId });
		assert.equal(last().kind, "error");
		assert.equal(last().code, "bad-request");
		await client.handleMessage({ type: "input-resources", sessionId, query: "" });
		assert.equal(last().kind, "error");
		assert.equal(last().code, "bad-request");

		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(last().code, "mode-switch-blocked");
		assert.deepEqual(last().reasons, ["running"]);
		assert.equal(modeStore.read(), "bridge");

		await client.handleMessage({ type: "history", sessionId });
		const history = last();
		assert.equal(history.kind, "history");
		assert.equal(history.latestEntryId, "leaf-1");
		assert.equal(history.isStreaming, true);
		const messages = history.messages as Array<Record<string, unknown>>;
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.role, "user");

		client.close();
	});
});
