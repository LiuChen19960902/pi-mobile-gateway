import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import mobileBridge from "../bridge-extension/src/index.ts";
import { BridgeHub } from "../src/bridge.ts";
import { BridgeLaunchError, BridgeLauncher } from "../src/bridge-launch.ts";
import { BridgeWorkspaces } from "../src/bridge-workspaces.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { connectClient } from "../src/router.ts";
import { WorktreeError } from "../src/worktrees.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pim-workspace-")),
		old = process.env.PI_MOBILE_BRIDGE_ROOT;
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	const target = join(root, "target");
	mkdirSync(target);
	const manager = SessionManager.create(root, sessions),
		handlers = new Map<string, (...a: unknown[]) => unknown>();
	const user = manager.appendMessage({ role: "user", content: "first user", timestamp: 1 });
	const assistant = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "test",
		provider: "fixture",
		model: "offline",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	} as never);
	manager.appendLabelChange(assistant, "bookmark");
	manager.branch(user);
	let busy = false,
		pending = false;
	const pi = {
		on: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f),
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		cwd: root,
		model: { id: "offline", provider: "fixture", reasoning: false, contextWindow: 65536 },
		isIdle: () => !busy,
		hasPendingMessages: () => pending,
		sessionManager: manager,
		ui: { getEditorComponent: () => undefined, setEditorComponent: () => {} },
	} as unknown as ExtensionContext;
	mobileBridge(pi);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const hub = new BridgeHub({ root });
	let d = hub.descriptors()[0];
	return {
		root,
		target,
		sessions,
		manager,
		user,
		assistant,
		hub,
		descriptor: () => d,
		fork: (operationId: string) => hub.forkWorkspace(d, { operationId, targetPath: target, sessionDir: sessions }),
		setBusy: (b: boolean, p = false) => {
			busy = b;
			pending = p;
		},
		reload: async () => {
			await handlers.get("session_shutdown")?.({ reason: "reload" });
			await handlers.get("session_start")?.({ reason: "reload" }, ctx);
			d = hub.descriptors()[0];
		},
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({ reason: "quit" });
			if (old === undefined) delete process.env.PI_MOBILE_BRIDGE_ROOT;
			else process.env.PI_MOBILE_BRIDGE_ROOT = old;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
it("native workspace fork keeps full tree and live selected branch, without changing source", async () => {
	const f = await fixture();
	try {
		const source = f.manager.getSessionFile();
		assert.ok(source);
		const before = hash(source);
		const op = randomUUID();
		const result = await f.fork(op);
		assert.equal(result.targetSessionId, op);
		assert.equal(result.cwd, f.target);
		assert.ok(result.targetSessionFile);
		const target = SessionManager.open(result.targetSessionFile);
		assert.equal(target.getHeader()?.parentSession, source);
		assert.equal(target.getCwd(), f.target);
		assert.equal(target.getLabel(f.assistant), "bookmark");
		assert.equal(target.getEntry(f.assistant)?.id, f.assistant);
		const branch = target.getBranch();
		assert.ok(branch.some((e) => e.id === f.user));
		assert.ok(!branch.some((e) => e.id === f.assistant));
		assert.deepEqual(target.buildSessionContext().model, { provider: "fixture", modelId: "offline" });
		assert.equal(target.buildSessionContext().thinkingLevel, "off");
		assert.equal(hash(source), before);
		assert.equal(f.manager.getLeafId(), f.user);
		const repeated = await f.fork(op);
		assert.equal(repeated.targetSessionFile, result.targetSessionFile);
		await f.reload();
		const restored = await f.fork(op);
		assert.equal(restored.targetSessionFile, result.targetSessionFile);
		assert.equal(readdirSync(f.sessions).filter((p) => p.endsWith(".jsonl")).length, 2);
	} finally {
		await f.cleanup();
	}
});
it("native workspace fork rejects source activity and never adopts a colliding session ID", async () => {
	const f = await fixture();
	try {
		f.setBusy(true);
		await assert.rejects(f.fork(randomUUID()), { code: "worktree-busy" });
		f.setBusy(false, true);
		await assert.rejects(f.fork(randomUUID()), { code: "worktree-queued" });
		f.setBusy(false);
		const id = randomUUID(),
			other = SessionManager.create(f.target, f.sessions, { id });
		other.appendMessage({ role: "user", content: "do not overwrite", timestamp: 1 });
		const file = other.getSessionFile();
		assert.ok(file);
		const before = hash(file);
		await assert.rejects(f.fork(id), { code: "worktree-operation-conflict" });
		assert.equal(hash(file), before);
	} finally {
		await f.cleanup();
	}
});
it("launcher creates empty native sessions with public --session-id, not a nonexistent --session file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pim-new-launch-"));
	try {
		const id = randomUUID();
		let commandArgs: string[] = [];
		const bridge = { descriptors: () => [] } as unknown as BridgeHub;
		const launcher = new BridgeLauncher({
			root,
			bridge,
			extensionPath: import.meta.filename,
			exec: async (_cmd, args) => {
				commandArgs = args;
			},
			waitForDescriptor: async () => ({
				sessionId: id,
				instanceId: "i",
				epoch: "e",
				pid: 123,
				duplicate: false,
				attachHint: "test",
			}),
		});
		const result = await launcher.launch({
			operationId: id,
			sessionId: id,
			cwd: root,
			newSession: true,
			sessionDir: join(root, "sessions"),
		});
		assert.equal(result.sessionId, id);
		assert.ok(commandArgs.includes("--session-id"));
		assert.equal(commandArgs[commandArgs.indexOf("--session-id") + 1], id);
		assert.ok(!commandArgs.includes("--session"));
		assert.ok(commandArgs.includes("--session-dir"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("native workspace orchestration reuses its fork across failed launch and process recreation", async () => {
	const f = await fixture();
	try {
		let starts = 0,
			live: Record<string, unknown> | undefined;
		const originalDescriptor = f.hub.descriptor.bind(f.hub),
			originalSnapshot = f.hub.snapshot.bind(f.hub);
		f.hub.descriptor = (id) => (live?.sessionId === id ? (live as never) : originalDescriptor(id));
		f.hub.snapshot = async (d) =>
			d.sessionId === live?.sessionId
				? ({ ...d, model: { provider: "fixture", modelId: "offline" }, thinkingLevel: "off" } as never)
				: originalSnapshot(d);
		const launcher = {
			launch: async (input: { sessionId: string; sessionFile: string; cwd: string }) => {
				starts++;
				if (starts === 1) throw new BridgeLaunchError("bridge-start-failed", "synthetic");
				live = {
					...f.descriptor(),
					sessionId: input.sessionId,
					sessionFile: input.sessionFile,
					cwd: input.cwd,
					instanceId: "target",
					epoch: "target-epoch",
				};
				return live;
			},
		} as unknown as BridgeLauncher;
		const options = { bridge: f.hub, launcher, sessionDir: f.sessions, trust: (p: string) => p };
		let workspaces = new BridgeWorkspaces(options);
		const op = randomUUID();
		const source = f.descriptor();
		const failed = await workspaces.fork(op, source, f.target);
		assert.equal(failed.status, "failed");
		assert.equal(failed.targetSessionId, op);
		assert.ok(!JSON.stringify(failed).includes("targetSessionFile"));
		const files = readdirSync(f.sessions).filter((x) => x.endsWith(".jsonl"));
		assert.equal(files.length, 2);
		workspaces = new BridgeWorkspaces(options);
		const success = await workspaces.fork(op, source, f.target, false, true);
		assert.equal(success.status, "succeeded");
		assert.equal(success.targetSessionId, op);
		assert.equal(starts, 2);
		assert.equal(readdirSync(f.sessions).filter((x) => x.endsWith(".jsonl")).length, 2);
		assert.equal((await workspaces.status(op)).status, "succeeded");
		assert.equal(f.manager.getLeafId(), f.user);
	} finally {
		await f.cleanup();
	}
});
it("native unknown launch is query-only; target model mismatch never reports success", async () => {
	const f = await fixture();
	try {
		let starts = 0,
			live: Record<string, unknown> | undefined,
			wrong = false;
		const original = f.hub.descriptor.bind(f.hub),
			snapshot = f.hub.snapshot.bind(f.hub);
		f.hub.descriptor = (id) => (live?.sessionId === id ? (live as never) : original(id));
		f.hub.snapshot = async (d) =>
			live?.sessionId === d.sessionId
				? ({
						...d,
						model: { provider: "fixture", modelId: wrong ? "wrong" : "offline" },
						thinkingLevel: "off",
					} as never)
				: snapshot(d);
		const launcher = {
			launch: async (input: { sessionId: string; cwd: string; sessionFile: string }) => {
				starts++;
				live = { ...f.descriptor(), sessionId: input.sessionId, cwd: input.cwd, sessionFile: input.sessionFile };
				throw new BridgeLaunchError("launch-result-unknown", "synthetic");
			},
		} as unknown as BridgeLauncher;
		const ws = new BridgeWorkspaces({ bridge: f.hub, launcher, sessionDir: f.sessions, trust: (p) => p });
		const op = randomUUID();
		assert.equal((await ws.fork(op, f.descriptor(), f.target)).status, "unknown");
		assert.equal((await ws.fork(op, f.descriptor(), f.target, false, true)).status, "unknown");
		assert.equal(starts, 1);
		wrong = true;
		assert.equal((await ws.status(op)).status, "unknown");
		wrong = false;
		assert.equal((await ws.status(op)).status, "succeeded");
	} finally {
		await f.cleanup();
	}
});
it("native first-message creation dedupes opaque send tokens and rejects changed directory", async () => {
	const f = await fixture();
	try {
		let starts = 0,
			live: Record<string, unknown> | undefined;
		const original = f.hub.descriptor.bind(f.hub),
			snap = f.hub.snapshot.bind(f.hub);
		f.hub.descriptor = (id) => (live?.sessionId === id ? (live as never) : original(id));
		f.hub.snapshot = async (d) => (live?.sessionId === d.sessionId ? ({ ...d, owner: true } as never) : snap(d));
		const launcher = {
			launch: async (input: { sessionId: string; cwd: string; newSession: boolean }) => {
				starts++;
				assert.equal(input.newSession, true);
				live = { ...f.descriptor(), sessionId: input.sessionId, cwd: input.cwd, sessionFile: null };
				return live;
			},
		} as unknown as BridgeLauncher;
		const options = { bridge: f.hub, launcher, sessionDir: f.sessions, trust: (p: string) => p };
		const token = "send-fixture-12";
		const first = await new BridgeWorkspaces(options).newSession(token, f.target);
		const repeated = await new BridgeWorkspaces(options).newSession(token, f.target);
		assert.equal(first.sessionId, repeated.sessionId);
		assert.equal(starts, 1);
		await assert.rejects(new BridgeWorkspaces(options).newSession(token, f.root), {
			code: "worktree-operation-conflict",
		});
		assert.equal(
			readdirSync(f.sessions).filter((x) => x.endsWith(".jsonl")).length,
			1,
			"new CLI does not hand-write a header",
		);
	} finally {
		await f.cleanup();
	}
});
it("bridge workspace router never opens an SDK handle; identity errors are correlated", async () => {
	const f = await fixture();
	try {
		const mode = new HostModeStore(join(f.root, "mode.json"));
		mode.write("bridge");
		const frames: Record<string, unknown>[] = [];
		const runtime = {
			worktreeList: async () => {
				throw new Error("SDK must not open");
			},
			unsubscribe: () => {},
		};
		const ws = new BridgeWorkspaces({ bridge: f.hub, launcher: {} as BridgeLauncher, trust: (p) => p });
		const client = connectClient(runtime as never, (x) => frames.push(x), {
			bridge: f.hub,
			hostModeStore: mode,
			bridgeWorkspaces: ws,
		});
		try {
			await client.handleMessage({
				type: "worktree-list",
				sessionId: f.descriptor().sessionId,
				queryId: "q",
				instanceId: "wrong",
				epoch: f.descriptor().epoch,
			});
			assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
			assert.equal(frames.at(-1)?.queryId, "q");
			assert.equal(frames.at(-1)?.instanceId, "wrong");
			await client.handleMessage({
				type: "worktree-list",
				sessionId: f.descriptor().sessionId,
				queryId: "right",
				instanceId: f.descriptor().instanceId,
				epoch: f.descriptor().epoch,
			});
			assert.equal(frames.at(-1)?.kind, "worktree-list");
			assert.equal(frames.at(-1)?.cwd, f.root);
		} finally {
			client.close();
		}
	} finally {
		await f.cleanup();
	}
});

it("native root send establishes identity from subscription snapshot before submitted ACK", async () => {
	const f = await fixture();
	try {
		const mode = new HostModeStore(join(f.root, "root-mode.json"));
		mode.write("bridge");
		const frames: Record<string, unknown>[] = [];
		const runtime = {
			unsubscribe: () => {},
			openSession: () => {
				throw new Error("SDK");
			},
		};
		const ws = { newSession: async () => f.descriptor() } as unknown as BridgeWorkspaces;
		const client = connectClient(runtime as never, (x) => frames.push(x), {
			bridge: f.hub,
			hostModeStore: mode,
			bridgeWorkspaces: ws,
		});
		try {
			await client.handleMessage({
				type: "message",
				cwd: f.root,
				nativeNew: true,
				operationId: "send-root-1",
				text: "synthetic root",
			});
			const ack = frames.find((x) => x.kind === "sent");
			assert.ok(ack, JSON.stringify(frames));
			const snap = frames.find((x) => x.kind === "bridge-snapshot");
			assert.ok(snap);
			assert.ok(frames.indexOf(snap) < frames.indexOf(ack));
			assert.equal(ack.operationId, "send-root-1");
			assert.equal(ack.sessionId, f.descriptor().sessionId);
			assert.equal(ack.instanceId, snap.instanceId);
			assert.equal(ack.epoch, snap.epoch);
		} finally {
			client.close();
		}
	} finally {
		await f.cleanup();
	}
});
it("native root trust refusal preserves opaque operation ID and never starts SDK or Pi", async () => {
	const f = await fixture();
	try {
		const mode = new HostModeStore(join(f.root, "trust-mode.json"));
		mode.write("bridge");
		const ws = new BridgeWorkspaces({
			bridge: f.hub,
			launcher: {
				launch: () => {
					throw new Error("must not launch");
				},
			} as never,
			trust: () => {
				throw new WorktreeError("worktree-trust-required");
			},
		});
		const frames: Record<string, unknown>[] = [];
		const client = connectClient({ unsubscribe: () => {} } as never, (x) => frames.push(x), {
			bridge: f.hub,
			hostModeStore: mode,
			bridgeWorkspaces: ws,
		});
		try {
			await client.handleMessage({
				type: "message",
				cwd: f.target,
				nativeNew: true,
				operationId: "send-trust-2",
				text: "retained",
			});
			assert.equal(frames.at(-1)?.code, "worktree-trust-required");
			assert.equal(frames.at(-1)?.operationId, "send-trust-2");
			assert.ok(!frames.at(-1)?.sessionId);
		} finally {
			client.close();
		}
	} finally {
		await f.cleanup();
	}
});

it("native root subscription timeout closes late snapshots before returning unknown", async (t) => {
	const f = await fixture();
	try {
		const mode = new HostModeStore(join(f.root, "timeout-mode.json"));
		mode.write("bridge");
		let callbacks: { onSnapshot: (v: unknown) => void; onEvent: (v: unknown) => void } | undefined;
		let open: (() => void) | undefined;
		let detached = 0;
		const hub = {
			descriptor: () => f.descriptor(),
			subscribe: async (_d: unknown, c: NonNullable<typeof callbacks>) => {
				callbacks = c;
				await new Promise<void>((r) => {
					open = r;
				});
				return () => {
					detached++;
				};
			},
		} as unknown as BridgeHub;
		const frames: Record<string, unknown>[] = [];
		const client = connectClient({ unsubscribe: () => {} } as never, (x) => frames.push(x), {
			hostModeStore: mode,
			bridge: hub,
			bridgeWorkspaces: { newSession: async () => f.descriptor() } as unknown as BridgeWorkspaces,
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const pending = client.handleMessage({
				type: "message",
				cwd: f.root,
				nativeNew: true,
				text: "root",
				operationId: "timeout-root",
			});
			for (let i = 0; i < 20 && !callbacks; i++) await Promise.resolve();
			assert.ok(callbacks);
			t.mock.timers.tick(8_001);
			await pending;
			assert.equal(frames.at(-1)?.code, "worktree-result-unknown");
			const count = frames.length;
			callbacks.onSnapshot({ ...f.descriptor(), seq: 0, busy: false, tools: [], partial: null });
			assert.equal(frames.length, count, "late snapshot after failed initial subscription must not be pushed");
			open?.();
			for (let i = 0; i < 10 && !detached; i++) await Promise.resolve();
			assert.equal(detached, 1);
		} finally {
			t.mock.timers.reset();
			client.close();
			open?.();
		}
	} finally {
		await f.cleanup();
	}
});
it("native same-directory continuation still requires an idle real source", async () => {
	const f = await fixture();
	try {
		const ws = new BridgeWorkspaces({ bridge: f.hub, launcher: {} as BridgeLauncher, trust: (p) => p });
		f.setBusy(true);
		const result = await ws.fork(randomUUID(), f.descriptor(), f.root);
		assert.equal(result.status, "failed");
		assert.equal(result.code, "worktree-busy");
	} finally {
		await f.cleanup();
	}
});
