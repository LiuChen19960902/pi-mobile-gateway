import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeDescriptor } from "../bridge-extension/src/protocol.ts";
import { type BridgeHub, BridgeRequestError, BridgeUnavailableError } from "../src/bridge.ts";
import { BridgeLaunchError, type BridgeLauncher } from "../src/bridge-launch.ts";
import { BridgeWorkspaces } from "../src/bridge-workspaces.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { connectClient } from "../src/router.ts";
import { WorktreeError } from "../src/worktrees.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-mobile-resume-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendModelChange("fixture", "offline");
	manager.appendMessage({ role: "user", content: "saved history", timestamp: 1 });
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const target = { id: manager.getSessionId(), path: sessionFile, cwd: root };
	const descriptor: BridgeDescriptor = {
		schema: 1,
		extensionVersion: "0.8.1",
		instanceId: "instance-a",
		epoch: "epoch-a",
		sessionId: target.id,
		pid: process.pid,
		socketPath: join(root, "unused.sock"),
		sessionFile: target.path,
		cwd: root,
		startedAt: 1,
		owner: true,
	};
	const sentPayloads: unknown[] = [];
	let online = false,
		launches = 0,
		sends = 0,
		unknownStart = false,
		unknownSubmit = false,
		failSnapshots = false,
		rejectSubmit: string | undefined,
		status = "unknown",
		denyTrust = false;
	const hub = {
		root,
		descriptor: (id: string) => (online && id === target.id ? descriptor : null),
		snapshot: async () => {
			if (failSnapshots) throw new BridgeUnavailableError("synthetic snapshot lost");
			return {
				...descriptor,
				seq: 1,
				busy: false,
				pending: false,
				model: { provider: "fixture", modelId: "offline" },
				thinkingLevel: "off",
			};
		},
		send: async (_d: BridgeDescriptor, input: unknown) => {
			sends++;
			sentPayloads.push(structuredClone(input));
			if (rejectSubmit) {
				const code = rejectSubmit;
				rejectSubmit = undefined;
				throw new BridgeRequestError(code, code);
			}
			if (unknownSubmit) throw new BridgeUnavailableError("synthetic lost IPC reply");
			return { kind: "reply", id: "r", ok: true, status: "submitted", ...descriptor };
		},
		operationStatus: async () => ({ kind: "reply", id: "s", ok: true, status }),
	} as unknown as BridgeHub;
	const launcher = {
		launch: async (input: { sessionId: string; sessionFile: string; cwd: string }) => {
			launches++;
			assert.equal(input.sessionId, target.id);
			assert.equal(input.sessionFile, target.path);
			assert.equal(input.cwd, target.cwd);
			if (unknownStart) throw new BridgeLaunchError("launch-result-unknown", "synthetic unknown");
			online = true;
			return { ...descriptor, duplicate: false, attachHint: "synthetic" };
		},
	} as unknown as BridgeLauncher;
	const make = () =>
		new BridgeWorkspaces({
			bridge: hub,
			launcher,
			sessionDir: join(root, "sessions"),
			trust: (p) => {
				if (denyTrust) throw new WorktreeError("worktree-trust-required");
				return p;
			},
		});
	const payload = { text: "synthetic resumed text", images: [], deliverAs: "followUp" as const };
	return {
		root,
		target,
		descriptor,
		hub,
		make,
		payload,
		counts: () => ({ launches, sends }),
		payloads: () => sentPayloads,
		failSnapshots: (value: boolean) => {
			failSnapshots = value;
		},
		online: () => {
			online = true;
		},
		offline: () => {
			online = false;
		},
		rejectNextSend: (code: string) => {
			rejectSubmit = code;
		},
		unknownStart: () => {
			unknownStart = true;
		},
		unknownSubmit: () => {
			unknownSubmit = true;
		},
		status: (value: string) => {
			status = value;
		},
		denyTrust: () => {
			denyTrust = true;
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

it("resumes original SID/file/cwd and journals one submission across concurrent retry", async () => {
	const f = fixture();
	try {
		const before = createHash("sha256").update(readFileSync(f.target.path)).digest("hex");
		const ws = f.make();
		const d = await ws.resume("message-a", f.target);
		assert.equal(d.sessionId, f.target.id);
		await Promise.all([ws.submitResumed("message-a", d, f.payload), ws.submitResumed("message-a", d, f.payload)]);
		await f.make().resume("message-a", f.target);
		assert.deepEqual(f.counts(), { launches: 1, sends: 1 });
		assert.deepEqual(f.payloads(), [{ operationId: "message-a", ...f.payload }]);
		assert.equal(createHash("sha256").update(readFileSync(f.target.path)).digest("hex"), before);
	} finally {
		f.cleanup();
	}
});
it("unknown start observes the same target without launching again, including a new coordinator", async () => {
	const f = fixture();
	try {
		f.unknownStart();
		await assert.rejects(
			() => f.make().resume("message-a", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		await assert.rejects(
			() => f.make().resume("message-a", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		assert.equal(f.counts().launches, 1);
		f.online();
		const d = await f.make().resume("message-a", f.target);
		assert.equal(d.sessionId, f.target.id);
		assert.equal(f.counts().launches, 1);
	} finally {
		f.cleanup();
	}
});
it("unknown submission only reconciles operation status and never re-sends", async () => {
	const f = fixture();
	try {
		const ws = f.make();
		const d = await ws.resume("message-a", f.target);
		f.unknownSubmit();
		await assert.rejects(
			() => ws.submitResumed("message-a", d, f.payload),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-submit-unconfirmed",
		);
		await assert.rejects(
			() => f.make().submitResumed("message-a", d, f.payload),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-submit-unconfirmed",
		);
		assert.equal(f.counts().sends, 1);
		f.status("submitted");
		const receipt = await f.make().submitResumed("message-a", d, f.payload);
		assert.equal(receipt.status, "submitted");
		assert.equal(f.counts().sends, 1);
	} finally {
		f.cleanup();
	}
});
it("trust and observer ownership refuse before submission", async () => {
	const f = fixture();
	try {
		f.denyTrust();
		await assert.rejects(
			() => f.make().resume("trust", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "worktree-trust-required",
		);
		assert.equal(f.counts().launches, 0);
	} finally {
		f.cleanup();
	}
	const g = fixture();
	try {
		g.online();
		g.descriptor.owner = false;
		await assert.rejects(
			() => g.make().resume("observer", g.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "session-owned",
		);
		assert.equal(g.counts().sends, 0);
	} finally {
		g.cleanup();
	}
});
it("same operation cannot change payload or follow a replacement runtime", async () => {
	const f = fixture();
	try {
		const ws = f.make();
		const d = await ws.resume("message-a", f.target);
		await ws.submitResumed("message-a", d, f.payload);
		await assert.rejects(
			() => ws.submitResumed("message-a", d, { ...f.payload, text: "different" }),
			(e: unknown) => e instanceof WorktreeError && e.code === "worktree-operation-conflict",
		);
		f.descriptor.epoch = "replacement";
		await assert.rejects(
			() => f.make().resume("message-a", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		assert.equal(f.counts().sends, 1);
	} finally {
		f.cleanup();
	}
});
it("SDK mode refuses nativeResume before opening any SDK handle", async () => {
	const f = fixture();
	try {
		const mode = new HostModeStore(join(f.root, "mode.json"));
		mode.write("sdk");
		let sdk = 0;
		const frames: Record<string, unknown>[] = [];
		const runtime = {
			openSession: async () => {
				sdk++;
				throw new Error("must not open SDK");
			},
			unsubscribe: () => {},
		};
		const client = connectClient(runtime as never, (x) => frames.push(x), { hostModeStore: mode });
		try {
			await client.handleMessage({
				type: "message",
				sessionId: f.target.id,
				nativeResume: true,
				operationId: "message-a",
				text: "synthetic",
			});
			assert.equal(frames.at(-1)?.code, "mode-switch-blocked");
			assert.equal(sdk, 0);
		} finally {
			client.close();
		}
	} finally {
		f.cleanup();
	}
});

it("preflight busy may retry the same unchanged commit but unknown may not", async () => {
	const f = fixture();
	try {
		const ws = f.make(),
			d = await ws.resume("retry-busy", f.target);
		f.rejectNextSend("busy");
		await assert.rejects(
			ws.submitResumed("retry-busy", d, f.payload),
			(e: unknown) => e instanceof BridgeRequestError && e.code === "busy",
		);
		await ws.submitResumed("retry-busy", d, f.payload);
		assert.equal(f.counts().sends, 2);
	} finally {
		f.cleanup();
	}
});
it("observer rejection does not poison the original startup operation", async () => {
	const f = fixture();
	try {
		f.online();
		f.descriptor.owner = false;
		await assert.rejects(
			f.make().resume("retry-owner", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "session-owned",
		);
		f.descriptor.owner = true;
		const d = await f.make().resume("retry-owner", f.target);
		assert.equal(d.sessionId, f.target.id);
	} finally {
		f.cleanup();
	}
});
it("worktree status cannot promote an unconfirmed native submission", async () => {
	const f = fixture();
	try {
		const ws = f.make(),
			d = await ws.resume("status-unknown", f.target);
		f.unknownSubmit();
		await assert.rejects(ws.submitResumed("status-unknown", d, f.payload));
		const h = createHash("sha256").update("native-resume:send\0status-unknown").digest("hex");
		const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
		assert.equal((await ws.status(id)).status, "unknown");
		await assert.rejects(ws.submitResumed("status-unknown", d, f.payload));
		assert.equal(f.counts().sends, 1);
	} finally {
		f.cleanup();
	}
});
it("lost target before commit stays native-start-unconfirmed", async () => {
	const f = fixture();
	try {
		const ws = f.make(),
			d = await ws.resume("lost-target", f.target);
		f.offline();
		await assert.rejects(
			ws.submitResumed("lost-target", d, f.payload),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		assert.equal(f.counts().sends, 0);
	} finally {
		f.cleanup();
	}
});

it("a registered launch with lost verification stays unknown and pins the original epoch", async () => {
	const f = fixture();
	try {
		f.failSnapshots(true);
		await assert.rejects(
			f.make().resume("snapshot-lost", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		f.failSnapshots(false);
		const epoch = f.descriptor.epoch;
		f.descriptor.epoch = "replacement";
		await assert.rejects(
			f.make().resume("snapshot-lost", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "native-start-unconfirmed",
		);
		f.descriptor.epoch = epoch;
		await f.make().resume("snapshot-lost", f.target);
		assert.equal(f.counts().launches, 1);
	} finally {
		f.cleanup();
	}
});
it("owner changing between precheck and startup does not poison retry", async () => {
	const f = fixture();
	try {
		f.online();
		const original = f.hub.descriptor.bind(f.hub);
		let calls = 0;
		f.hub.descriptor = (id: string) => {
			const d = original(id);
			return ++calls === 2 && d ? { ...d, owner: false } : d;
		};
		await assert.rejects(
			f.make().resume("owner-race", f.target),
			(e: unknown) => e instanceof WorktreeError && e.code === "session-owned",
		);
		assert.equal(f.counts().launches, 0);
		await f.make().resume("owner-race", f.target);
		assert.equal(f.counts().launches, 1);
	} finally {
		f.cleanup();
	}
});

it("registered runtime identity is durable before the first verification IPC", async () => {
	const f = fixture();
	try {
		const real = f.hub.snapshot.bind(f.hub);
		const observations: Record<string, unknown>[] = [];
		const h = createHash("sha256").update("native-resume:start\0durable-start").digest("hex");
		const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
		f.hub.snapshot = async (d) => {
			const saved = JSON.parse(readFileSync(join(f.root, "workspaces", `${id}.json`), "utf8")).result;
			observations.push(saved);
			return real(d);
		};
		await f.make().resume("durable-start", f.target);
		assert.ok(observations.length > 0);
		assert.equal(observations[0].expectedInstanceId, f.descriptor.instanceId);
		assert.equal(observations[0].expectedEpoch, f.descriptor.epoch);
	} finally {
		f.cleanup();
	}
});
