import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, it } from "node:test";
import { BridgeHub, BridgeRequestError } from "../src/bridge.ts";
import { BridgeLauncher } from "../src/bridge-launch.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { connectClient } from "../src/router.ts";

// 生产 router/launcher 的确定性交错；Hub/runtime/tmux exec 为合成注入，不启动真实 Pi。
let root = "";
before(() => {
	root = mkdtempSync(join(tmpdir(), "pi-mgw-lifecycle-"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

type Frame = Record<string, unknown>;

function fakeBridge(onSend: () => Promise<unknown>) {
	const descriptor = { sessionId: "session-a", instanceId: "i2", epoch: "e2", pid: process.pid };
	const snapshot = { ...descriptor, seq: 1, busy: false, pending: false, tools: [], partial: null };
	let handlers:
		| { onSnapshot: (value: typeof snapshot) => void; onEvent: (value: Record<string, unknown>) => void }
		| undefined;
	let statusCalls = 0;
	const bridge = {
		descriptors: () => [descriptor],
		descriptor: () => descriptor,
		snapshot: async () => snapshot,
		subscribe: async (_descriptor: unknown, next: NonNullable<typeof handlers>) => {
			handlers = next;
			next.onSnapshot(snapshot);
			return () => {};
		},
		send: onSend,
		operationStatus: async () => {
			statusCalls += 1;
			return { ok: true, status: "settled" };
		},
	};
	return {
		bridge,
		descriptor,
		event: (seq: number) => handlers?.onEvent({ ...descriptor, seq, event: { type: "agent_start" } }),
		statusCalls: () => statusCalls,
	};
}

it("宿主范围切换会阻断另一连接的在途写，并停止旧连接旧模式事件", async () => {
	const mode = new HostModeStore(join(root, "host-mode.json"));
	mode.write("bridge");
	let enterSend = () => {};
	let releaseSend = () => {};
	const entered = new Promise<void>((resolve) => {
		enterSend = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseSend = resolve;
	});
	const fake = fakeBridge(async () => {
		enterSend();
		await release;
		return { ok: true, status: "submitted" };
	});
	const runtime = { listSessions: async () => [], unsubscribe: () => {} };
	const framesA: Frame[] = [];
	const framesB: Frame[] = [];
	const a = connectClient(runtime as never, (frame) => framesA.push(frame as Frame), {
		hostModeStore: mode,
		bridge: fake.bridge as never,
	});
	const b = connectClient(runtime as never, (frame) => framesB.push(frame as Frame), {
		hostModeStore: mode,
		bridge: fake.bridge as never,
	});
	try {
		const pending = a.handleMessage({
			type: "message",
			sessionId: fake.descriptor.sessionId,
			instanceId: fake.descriptor.instanceId,
			epoch: fake.descriptor.epoch,
			operationId: "send-a",
			text: "synthetic",
		});
		await entered;
		await b.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(mode.read(), "bridge", "其他连接的在途写必须阻断宿主切换");

		releaseSend();
		await pending;
		if (mode.read() !== "sdk") await b.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(mode.read(), "sdk");
		const before = framesA.filter((frame) => frame.kind === "event").length;
		fake.event(2);
		const after = framesA.filter((frame) => frame.kind === "event").length;
		assert.equal(after, before, "切换后旧连接的旧模式事件必须停止投递");
	} finally {
		a.close();
		b.close();
	}
});

it("桥接模式未配置 hub 时 subscribe 报 bridge-unavailable", async () => {
	const mode = new HostModeStore(join(root, "missing-hub-mode.json"));
	mode.write("bridge");
	const frames: Frame[] = [];
	const client = connectClient(
		{ listSessions: async () => [], unsubscribe: () => {} } as never,
		(frame) => frames.push(frame as Frame),
		{
			hostModeStore: mode,
		},
	);
	try {
		await client.handleMessage({ type: "subscribe", sessionId: "session-a" });
		const error = frames.find((frame) => frame.kind === "error" && frame.requestType === "subscribe");
		assert.equal(error?.code, "bridge-unavailable");
	} finally {
		client.close();
	}
});

it("SDK openSession 在途时阻断模式切换，切换后不会补挂旧订阅", async () => {
	const mode = new HostModeStore(join(root, "sdk-subscribe-mode.json"));
	mode.write("sdk");
	let enterOpen = () => {};
	let releaseOpen = () => {};
	const entered = new Promise<void>((resolve) => {
		enterOpen = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	let attachments = 0;
	const runtime = {
		listSessions: async () => [],
		unsubscribe: () => {},
		openSession: async () => {
			enterOpen();
			await release;
			return {
				session: { sessionId: "session-a" },
				attach: () => {
					attachments += 1;
				},
			};
		},
		extensionStatuses: () => [],
	};
	const frames: Frame[] = [];
	const client = connectClient(runtime as never, (frame) => frames.push(frame as Frame), { hostModeStore: mode });
	try {
		const pending = client.handleMessage({ type: "subscribe", sessionId: "session-a" });
		await entered;
		await client.handleMessage({ type: "host-mode-put", mode: "bridge" });
		assert.equal(mode.read(), "sdk", "SDK openSession 在途必须阻断切换");
		releaseOpen();
		await pending;
		assert.equal(attachments, 1);
		await client.handleMessage({ type: "host-mode-put", mode: "bridge" });
		assert.equal(mode.read(), "bridge");
		assert.ok(frames.some((frame) => frame.kind === "unsubscribed" && frame.reason === "host-mode-changed"));
	} finally {
		client.close();
	}
});

it("bridge-start 启动窗口阻断切换到 sdk", async () => {
	const mode = new HostModeStore(join(root, "launch-mode.json"));
	mode.write("bridge");
	let enterList = () => {};
	let releaseList = () => {};
	let enterLaunch = () => {};
	let releaseLaunch = () => {};
	const enteredList = new Promise<void>((resolve) => {
		enterList = resolve;
	});
	const listGate = new Promise<void>((resolve) => {
		releaseList = resolve;
	});
	const enteredLaunch = new Promise<void>((resolve) => {
		enterLaunch = resolve;
	});
	const launchGate = new Promise<void>((resolve) => {
		releaseLaunch = resolve;
	});
	let listCalls = 0;
	const launcher = {
		launch: async (input: { sessionId: string; operationId: string }) => {
			enterLaunch();
			await launchGate;
			return { sessionId: input.sessionId, instanceId: "i9", epoch: "e9", pid: 9, duplicate: false };
		},
	};
	const runtime = {
		listSessions: async () => {
			listCalls += 1;
			if (listCalls === 1) {
				enterList();
				await listGate;
			}
			return [{ id: "launch-session", path: join(root, "launch-session.jsonl"), cwd: root, running: false }];
		},
		unsubscribe: () => {},
	};
	const fake = fakeBridge(async () => ({ ok: true, status: "submitted" }));
	const frames: Frame[] = [];
	const client = connectClient(runtime as never, (frame) => frames.push(frame as Frame), {
		hostModeStore: mode,
		bridge: fake.bridge as never,
		bridgeLauncher: launcher as never,
	});
	try {
		const pending = client.handleMessage({
			type: "bridge-start",
			sessionId: "launch-session",
			operationId: "launch-1",
		});
		await enteredList;
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(mode.read(), "bridge", "读会话列表期间也不能切到 sdk");
		releaseList();
		await enteredLaunch;
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(mode.read(), "bridge", "后台启动期间不能切到 sdk 形成双写者");
		releaseLaunch();
		await pending;
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(mode.read(), "sdk");
	} finally {
		client.close();
	}
});

it("operation-status 不把旧身份的查询投给新实例", async () => {
	const mode = new HostModeStore(join(root, "stale-mode.json"));
	mode.write("bridge");
	const fake = fakeBridge(async () => ({ ok: true, status: "submitted" }));
	const frames: Frame[] = [];
	const client = connectClient(
		{ listSessions: async () => [], unsubscribe: () => {} } as never,
		(frame) => frames.push(frame as Frame),
		{ hostModeStore: mode, bridge: fake.bridge as never },
	);
	try {
		await client.handleMessage({
			type: "operation-status",
			sessionId: fake.descriptor.sessionId,
			instanceId: "old-instance",
			epoch: "old-epoch",
			operationId: "receipt-a",
		});
		assert.equal(fake.statusCalls(), 0, "旧身份查询必须在进入 Hub 前被拒绝");
	} finally {
		client.close();
	}
});

it("native /new 后旧启动 journal 不能冒充新会话成功", async () => {
	const launchRoot = join(root, "launch-replay");
	mkdirSync(join(launchRoot, "registry"), { recursive: true });
	const extensionPath = join(launchRoot, "extension.ts");
	writeFileSync(extensionPath, "export {}\n");
	const registryPath = (id: string) => join(launchRoot, "registry", `${id}.json`);
	const descriptor = (id: string, epoch = "epoch-a") => ({
		schema: 1,
		extensionVersion: "0.2.0",
		instanceId: "same-live-instance",
		sessionId: id,
		epoch,
		pid: process.pid,
		owner: true,
		startedAt: Date.now(),
		cwd: launchRoot,
		socketPath: join(launchRoot, `${id}.sock`),
		sessionFile: join(launchRoot, `${id}.jsonl`),
	});
	const launcher = new BridgeLauncher({
		root: launchRoot,
		bridge: new BridgeHub({ root: launchRoot }),
		extensionPath,
		exec: async (_command: string, args: string[]) => {
			const id = args[args.indexOf("-s") + 1].slice("pi-mobile-".length);
			writeFileSync(registryPath(id), JSON.stringify(descriptor(id)));
		},
	});
	const input = (id: string, operationId: string) => ({
		sessionId: id,
		operationId,
		sessionFile: join(launchRoot, `${id}.jsonl`),
		cwd: launchRoot,
	});
	await launcher.launch(input("first-session", "original-start"));
	unlinkSync(registryPath("first-session"));
	writeFileSync(registryPath("different-session"), JSON.stringify(descriptor("different-session", "epoch-b")));
	const replay = await launcher.launch(input("first-session", "original-start")).then(
		(value) => ({ sessionId: value.sessionId, duplicate: value.duplicate }),
		(error: { code?: string }) => ({ code: error.code }),
	);
	const oldSessionReplayed = "sessionId" in replay && replay.sessionId === "first-session";
	assert.ok(!oldSessionReplayed, `旧 journal 不能让旧会话在 /new 后回放成功：${JSON.stringify(replay)}`);
});

it("同一启动 operationId 不能并发启动两个会话目标", async () => {
	const launchRoot = join(root, "launch-concurrent");
	mkdirSync(join(launchRoot, "registry"), { recursive: true });
	const extensionPath = join(launchRoot, "extension.ts");
	writeFileSync(extensionPath, "export {}\n");
	let execs = 0;
	const launcher = new BridgeLauncher({
		root: launchRoot,
		bridge: new BridgeHub({ root: launchRoot }),
		extensionPath,
		exec: async (_command: string, args: string[]) => {
			execs += 1;
			const id = args[args.indexOf("-s") + 1].slice("pi-mobile-".length);
			writeFileSync(
				join(launchRoot, "registry", `${id}.json`),
				JSON.stringify({
					schema: 1,
					extensionVersion: "0.2.0",
					instanceId: "instance-concurrent",
					epoch: "epoch-concurrent",
					sessionId: id,
					pid: process.pid,
					owner: true,
					startedAt: Date.now(),
					cwd: launchRoot,
					socketPath: join(launchRoot, `${id}.sock`),
					sessionFile: join(launchRoot, `${id}.jsonl`),
				}),
			);
		},
	});
	const input = (id: string) => ({
		sessionId: id,
		operationId: "shared-operation",
		sessionFile: join(launchRoot, `${id}.jsonl`),
		cwd: launchRoot,
	});
	await Promise.allSettled([launcher.launch(input("concurrent-a")), launcher.launch(input("concurrent-b"))]);
	assert.equal(execs, 1, "同一 operationId 只能产生一个启动动作");
});

it("桥接 abort 透传编辑器归属错误与电脑端恢复标注", async () => {
	const mode = new HostModeStore(join(root, "abort-mode.json"));
	mode.write("bridge");
	const descriptor = { sessionId: "session-abort", instanceId: "i9", epoch: "e9", pid: process.pid };
	const snapshot = { ...descriptor, seq: 1, busy: false, pending: true, tools: [], partial: null };
	let abortImpl: () => Promise<unknown> = async () => ({ ok: true });
	const bridge = {
		descriptors: () => [descriptor],
		descriptor: () => descriptor,
		snapshot: async () => snapshot,
		subscribe: async (_descriptor: unknown, next: { onSnapshot: (value: typeof snapshot) => void }) => {
			next.onSnapshot(snapshot);
			return () => {};
		},
		send: async () => ({ ok: true, status: "submitted" }),
		abort: async () => abortImpl(),
		operationStatus: async () => ({ ok: true, status: "settled" }),
	};
	const frames: Frame[] = [];
	// 复用生产 router：直接以桥接模式运行，mobile 只看稳定码。
	const bridged = connectClient(
		{ listSessions: async () => [], unsubscribe: () => {} } as never,
		(frame) => frames.push(frame as Frame),
		{ hostModeStore: mode, bridge: bridge as never },
	);
	try {
		// 其他 custom editor 占用输入框：取回失败回独立稳定码，不再伪装成模式不支持。
		abortImpl = async () => {
			throw new BridgeRequestError("editor-unavailable", "editor owned by another extension");
		};
		await bridged.handleMessage({
			type: "abort",
			sessionId: descriptor.sessionId,
			operationId: "abort-owner",
			restoreQueued: true,
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
		});
		const rejected = frames.at(-1) as Frame;
		assert.equal(rejected.kind, "error");
		assert.equal(rejected.code, "editor-unavailable");
		assert.equal(rejected.requestType, "abort");
		assert.equal(rejected.operationId, "abort-owner");
		assert.ok(!String(rejected.message).includes("editor owned"), "不透出扩展原始报文");

		// 有排队稿而桥接不持有 editor：中止成功，并明示文字留给电脑编辑器。
		abortImpl = async () => ({
			...descriptor,
			ok: true,
			status: "settled",
			busy: false,
			queuedText: null,
			queuedRestoredToDesktop: true,
			snapshot: { ...snapshot, busy: false },
		});
		await bridged.handleMessage({
			type: "abort",
			sessionId: descriptor.sessionId,
			operationId: "abort-desktop",
			restoreQueued: true,
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
		});
		const aborted = frames.at(-1) as Frame;
		assert.equal(aborted.kind, "aborted");
		assert.equal(aborted.queuedRestoredToDesktop, true);
		assert.equal(aborted.queuedText, undefined, "取不到队列就不回 queuedText");
		assert.equal(aborted.isStreaming, false);
	} finally {
		bridged.close();
	}
});
