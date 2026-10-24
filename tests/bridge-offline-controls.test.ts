import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeDescriptor } from "../bridge-extension/src/protocol.ts";
import type { BridgeHub } from "../src/bridge.ts";
import type { BridgeLauncher } from "../src/bridge-launch.ts";
import { BridgeWorkspaces } from "../src/bridge-workspaces.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";
import { WorktreeError } from "../src/worktrees.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-offline-controls-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	const entryId = manager.appendMessage({ role: "user", content: "saved offline question", timestamp: 1 });
	const sessionId = manager.getSessionId(),
		path = manager.getSessionFile();
	assert.ok(path);
	let interruptSubscription = false;
	let duringCatalog: (() => void) | undefined;
	let online = false,
		launches = 0,
		writes = 0,
		sdk = 0,
		denied = false;
	const descriptor: BridgeDescriptor = {
		schema: 1,
		extensionVersion: "0.8.1",
		sessionId,
		instanceId: "native-i",
		epoch: "native-e",
		pid: process.pid,
		socketPath: join(root, "unused.sock"),
		sessionFile: path,
		cwd: root,
		startedAt: 1,
		owner: true,
	};
	const snapshot = () => ({
		...descriptor,
		seq: 1,
		busy: false,
		pending: false,
		model: { provider: "fixture", modelId: "a" },
		thinkingLevel: "off",
	});
	const hub = {
		root,
		descriptor: (id: string) => (online && id === sessionId ? descriptor : null),
		snapshot: async () => snapshot(),
		models: async () => ({ groups: [{ provider: "native-live-scope", models: [] }] }),
		subscribe: async (_: unknown, listener: { onSnapshot: (x: unknown) => void }) => {
			if (interruptSubscription) {
				interruptSubscription = false;
				queueMicrotask(() => client.close());
				return () => {};
			}
			listener.onSnapshot(snapshot());
			return () => {};
		},
		setModel: async () => {
			writes++;
			return { model: { provider: "fixture", modelId: "a" }, thinkingLevel: "off" };
		},
		treeControl: async (_: unknown, type: string, input: { entryId: string }) => {
			writes++;
			return {
				entryId: input.entryId,
				leafId: entryId,
				label: "bookmark",
				labelEntryId: "label-id",
				snapshot: snapshot(),
				editorText: type === "switch-branch" ? "saved offline question" : undefined,
			};
		},
	} as unknown as BridgeHub;
	const launcher = {
		launch: async () => {
			launches++;
			online = true;
			return { ...descriptor, duplicate: false, attachHint: "fixture" };
		},
	} as unknown as BridgeLauncher;
	const runtime = new PiRuntime({
		sessionDir: join(root, "sessions"),
		agentDir: join(root, "agent"),
		sessionFactory: async () => {
			sdk++;
			throw new Error("must not open SDK");
		},
		modelRegistry: {
			getAvailable: async () => {
				duringCatalog?.();
				return [
					{
						provider: "fixture",
						id: "a",
						name: "A",
						reasoning: false,
						input: ["text"],
						contextWindow: 1000,
						maxTokens: 100,
					},
				];
			},
			getModel: () => undefined,
		},
		enabledModelsLoader: () => [],
	});
	runtime.listSessions = async () => [{ id: sessionId, path, cwd: root, mtime: 1, name: "offline" } as never];
	const mode = new HostModeStore(join(root, "mode.json"));
	mode.write("bridge");
	const ws = new BridgeWorkspaces({
		bridge: hub,
		launcher,
		sessionDir: join(root, "sessions"),
		trust: (p) => {
			if (denied) throw new WorktreeError("worktree-trust-required");
			return p;
		},
	});
	const frames: Record<string, unknown>[] = [];
	const createClient = () =>
		connectClient(runtime, (x) => frames.push(x), {
			bridge: hub,
			hostModeStore: mode,
			bridgeWorkspaces: ws,
			bridgeLauncher: launcher,
		});
	let client = createClient();
	return {
		sessionId,
		entryId,
		path,
		frames,
		descriptor,
		mode,
		request: async (frame: Record<string, unknown>) => {
			await client.handleMessage(frame);
			const reply = frames.at(-1);
			assert.ok(reply);
			return reply;
		},
		counts: () => ({ launches, writes, sdk }),
		deny: () => {
			denied = true;
		},
		online: () => {
			online = true;
		},
		onlineDuringCatalog: () => {
			duringCatalog = () => {
				online = true;
			};
		},
		interruptSubscription: () => {
			interruptSubscription = true;
		},
		reconnect: () => {
			client.close();
			client = createClient();
		},
		cleanup: () => {
			client.close();
			runtime.disposeAll();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
it("offline native model catalog and tree/copy are read-only and preserve the session file", async () => {
	const f = fixture();
	try {
		const before = readFileSync(f.path, "utf8");
		const models = await f.request({ type: "models", nativeRead: true, queryId: "models-home" });
		assert.equal(models.kind, "models");
		assert.equal(models.nativeRead, true);
		assert.equal(models.queryId, "models-home");
		assert.equal(models.sessionId, undefined);
		assert.equal((models.groups as { provider: string }[])[0].provider, "fixture");
		const tree = await f.request({
			type: "tree",
			nativeRead: true,
			operationId: "tree-read",
			sessionId: f.sessionId,
			view: { filter: "user-only", search: "offline", foldedIds: [] },
		});
		assert.equal(tree.kind, "tree");
		assert.equal(tree.operationId, "tree-read");
		assert.equal(tree.nativeRead, true);
		assert.equal((tree.nodes as { id: string }[])[0].id, f.entryId);
		const copy = await f.request({
			type: "entry-copy",
			nativeRead: true,
			operationId: "copy-read",
			sessionId: f.sessionId,
			entryId: f.entryId,
		});
		assert.equal(copy.kind, "entry-copy");
		assert.equal(copy.text, "saved offline question");
		assert.equal(copy.operationId, "copy-read");
		assert.deepEqual(f.counts(), { launches: 0, writes: 0, sdk: 0 });
		assert.equal(readFileSync(f.path, "utf8"), before);
	} finally {
		f.cleanup();
	}
});
it("explicit native controls start the original runtime and establish a snapshot before their reply", async () => {
	const f = fixture();
	try {
		const result = await f.request({
			type: "set-model",
			nativeResume: true,
			operationId: "model-write",
			sessionId: f.sessionId,
			provider: "fixture",
			modelId: "a",
		});
		assert.equal(result.kind, "model-set");
		assert.equal(result.instanceId, "native-i");
		assert.equal(result.epoch, "native-e");
		assert.ok(f.frames.findIndex((x) => x.kind === "bridge-snapshot") < f.frames.indexOf(result));
		assert.deepEqual(f.counts(), { launches: 1, writes: 1, sdk: 0 });
		const label = await f.request({
			type: "label-put",
			nativeResume: true,
			operationId: "label-write",
			sessionId: f.sessionId,
			entryId: f.entryId,
			label: "bookmark",
		});
		assert.equal(label.kind, "label-put");
		assert.equal(label.operationId, "label-write");
		const branch = await f.request({
			type: "switch-branch",
			nativeResume: true,
			operationId: "branch-write",
			sessionId: f.sessionId,
			entryId: f.entryId,
		});
		assert.equal(branch.kind, "branch-switched");
		assert.equal(branch.editorText, "saved offline question");
		assert.equal(f.counts().sdk, 0);
	} finally {
		f.cleanup();
	}
});
it("native activation requires trust and rejects observer ownership before writes", async () => {
	const f = fixture();
	try {
		f.deny();
		const result = await f.request({
			type: "set-model",
			nativeResume: true,
			operationId: "trust",
			sessionId: f.sessionId,
			provider: "fixture",
			modelId: "a",
		});
		assert.equal(result.code, "worktree-trust-required");
		assert.equal(result.operationId, "trust");
		assert.equal(result.instanceId, undefined);
		assert.deepEqual(f.counts(), { launches: 0, writes: 0, sdk: 0 });
	} finally {
		f.cleanup();
	}
	const g = fixture();
	try {
		g.online();
		g.descriptor.owner = false;
		const result = await g.request({
			type: "label-put",
			nativeResume: true,
			operationId: "observer",
			sessionId: g.sessionId,
			entryId: g.entryId,
			label: "x",
		});
		assert.equal(result.code, "session-owned");
		assert.equal(g.counts().writes, 0);
	} finally {
		g.cleanup();
	}
});
it("read and resume flags cannot bypass mode or instance binding", async () => {
	const f = fixture();
	try {
		const mixed = await f.request({
			type: "tree",
			nativeRead: true,
			operationId: "mixed",
			sessionId: f.sessionId,
			instanceId: "old",
			epoch: "old",
		});
		assert.equal(mixed.code, "bad-request");
		assert.equal(mixed.instanceId, undefined);
		assert.equal(mixed.epoch, undefined);
		const resumeMixed = await f.request({
			type: "set-model",
			sessionId: f.sessionId,
			operationId: "resume-mixed",
			nativeResume: true,
			provider: "fixture",
			modelId: "a",
			instanceId: "forged",
			epoch: "old",
		});
		assert.equal(resumeMixed.code, "bad-request");
		assert.equal(resumeMixed.instanceId, undefined);
		assert.equal(resumeMixed.epoch, undefined);
		f.mode.write("sdk");
		const wrongMode = await f.request({ type: "models", nativeRead: true, queryId: "sdk" });
		assert.equal(wrongMode.code, "mode-switch-blocked");
		assert.equal(f.counts().sdk, 0);
	} finally {
		f.cleanup();
	}
});

it("a catalog read before mobile identity establishment still respects an already online CLI scope", async () => {
	const f = fixture();
	try {
		f.online();
		const result = await f.request({
			type: "models",
			sessionId: f.sessionId,
			nativeRead: true,
			queryId: "before-snapshot",
		});
		assert.equal(result.kind, "models");
		assert.equal((result.groups as { provider: string }[])[0].provider, "native-live-scope");
		assert.deepEqual(f.counts(), { launches: 0, writes: 0, sdk: 0 });
	} finally {
		f.cleanup();
	}
});

it("a completed startup journal cannot acknowledge a control whose subscription was interrupted", async () => {
	const f = fixture();
	try {
		f.interruptSubscription();
		const payload = {
			type: "set-model",
			nativeResume: true,
			operationId: "startup-only",
			sessionId: f.sessionId,
			provider: "fixture",
			modelId: "a",
		};
		const failed = await f.request(payload);
		assert.equal(failed.code, "native-start-unconfirmed");
		assert.equal(f.counts().launches, 1);
		assert.equal(f.counts().writes, 0);
		assert.equal(
			f.frames.some((x) => x.kind === "model-set"),
			false,
		);
		f.reconnect();
		const retried = await f.request(payload);
		assert.equal(retried.kind, "model-set");
		assert.deepEqual(f.counts(), { launches: 1, writes: 1, sdk: 0 });
	} finally {
		f.cleanup();
	}
});

it("global preview is rejected when the selected CLI comes online during its catalog read", async () => {
	const f = fixture();
	try {
		f.onlineDuringCatalog();
		const result = await f.request({
			type: "models",
			sessionId: f.sessionId,
			nativeRead: true,
			queryId: "online-race",
		});
		assert.equal(result.code, "bridge-stale-runtime");
		assert.equal(result.groups, undefined);
		assert.deepEqual(f.counts(), { launches: 0, writes: 0, sdk: 0 });
	} finally {
		f.cleanup();
	}
});
