import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import mobileBridge from "../bridge-extension/src/index.ts";
import { BridgeHub } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pim-compact-"));
	const old = process.env.PI_MOBILE_BRIDGE_ROOT;
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let busy = false;
	let editor: unknown;
	let calls = 0;
	let deferredAbort = false;
	let options: CompactOptions | undefined;
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = {
		tokens: 500,
		contextWindow: 1000,
		percent: 50,
	};
	const pi = {
		registerCommand: () => {},
		on: (type: string, fn: (...args: unknown[]) => unknown) => handlers.set(type, fn),
	} as unknown as ExtensionAPI;
	mobileBridge(pi);
	const ctx = {
		mode: "tui",
		cwd: root,
		isIdle: () => !busy,
		hasPendingMessages: () => false,
		model: { provider: "fixture", id: "a" },
		thinkingLevel: "off",
		getContextUsage: () => usage,
		compact: (o: CompactOptions) => {
			calls++;
			busy = true;
			options = o;
		},
		abort: () => {
			if (deferredAbort) {
				setTimeout(() => {
					void handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
				}, 5);
				return;
			}
			busy = false;
			void handlers.get("session_compact_failed")?.(
				{ reason: "manual", aborted: true, willRetry: false, fromExtension: false },
				ctx,
			);
			options?.onError?.(new Error("synthetic cancellation"));
		},
		ui: {
			getEditorComponent: () => editor,
			setEditorComponent: (value: unknown) => {
				editor = value;
			},
		},
		sessionManager: {
			getSessionId: () => "compact-session",
			getSessionFile: () => null,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const hub = new BridgeHub({ root });
	let descriptor = hub.descriptors()[0];
	assert.ok(descriptor);
	return {
		root,
		hub,
		ctx,
		handlers,
		descriptor: () => descriptor,
		calls: () => calls,
		deferAbort: () => {
			deferredAbort = true;
		},
		complete: () => {
			busy = false;
			usage = { tokens: null, contextWindow: 1000, percent: null };
			options?.onComplete?.({ summary: "synthetic", firstKeptEntryId: "entry", tokensBefore: 500 });
		},
		fail: () => {
			busy = false;
			options?.onError?.(new Error("SECRET endpoint and key must not escape"));
		},
		oldCallback: () => options?.onComplete,
		reload: async () => {
			await handlers.get("session_shutdown")?.({ reason: "reload" });
			busy = false;
			await handlers.get("session_start")?.({ reason: "reload" }, ctx);
			descriptor = hub.descriptors()[0];
		},
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({ reason: "quit" });
			if (old === undefined) delete process.env.PI_MOBILE_BRIDGE_ROOT;
			else process.env.PI_MOBILE_BRIDGE_ROOT = old;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

it("bridge snapshot reports native context usage including unknown tokens", async () => {
	const f = await fixture();
	try {
		assert.deepEqual((await f.hub.snapshot(f.descriptor())).contextUsage, {
			tokens: 500,
			contextWindow: 1000,
			percent: 50,
		});
		await f.hub.compact(f.descriptor(), { operationId: "usage" });
		f.complete();
		const state = await f.hub.snapshot(f.descriptor());
		assert.deepEqual(state.contextUsage, { tokens: null, contextWindow: 1000, percent: null });
		assert.equal(state.isCompacting, false);
	} finally {
		await f.cleanup();
	}
});

it("compact submits once, rejects another start, and retains a real completion receipt", async () => {
	const f = await fixture();
	try {
		const first = await f.hub.compact(f.descriptor(), { operationId: "one" });
		assert.equal(first.status, "submitted");
		assert.equal(first.snapshot?.isCompacting, true);
		assert.equal((await f.hub.compact(f.descriptor(), { operationId: "one" })).duplicate, true);
		assert.equal(f.calls(), 1);
		await assert.rejects(f.hub.compact(f.descriptor(), { operationId: "two" }), { code: "compaction-busy" });
		f.complete();
		assert.equal((await f.hub.operationStatus(f.descriptor(), "one")).status, "settled");
		assert.equal((await f.hub.snapshot(f.descriptor())).busy, false);
	} finally {
		await f.cleanup();
	}
});

it("compact failure sanitizes errors and permits an explicit retry", async () => {
	const f = await fixture();
	try {
		await f.hub.compact(f.descriptor(), { operationId: "bad" });
		f.fail();
		const status = await f.hub.operationStatus(f.descriptor(), "bad");
		assert.equal(status.status, "failed");
		assert.equal(status.code, "compaction-failed");
		assert.equal(JSON.stringify(status).includes("SECRET"), false);
		assert.equal((await f.hub.snapshot(f.descriptor())).isCompacting, false);
		await f.hub.compact(f.descriptor(), { operationId: "retry" });
		assert.equal(f.calls(), 2);
	} finally {
		await f.cleanup();
	}
});

it("abort settles cancelled compaction without relying on agent_settled", async () => {
	const f = await fixture();
	try {
		await f.hub.compact(f.descriptor(), { operationId: "cancel" });
		const stopped = await f.hub.abort(f.descriptor(), { operationId: "stop" });
		assert.equal(stopped.status, "settled");
		assert.equal(stopped.busy, false);
		const status = await f.hub.operationStatus(f.descriptor(), "cancel");
		assert.equal(status.status, "failed");
		assert.equal(status.code, "compaction-cancelled");
	} finally {
		await f.cleanup();
	}
});

it("agent_settled cannot acknowledge stop before the compaction callback", async () => {
	const f = await fixture();
	try {
		await f.hub.compact(f.descriptor(), { operationId: "compact" });
		f.deferAbort();
		let replied = false;
		const stop = f.hub.abort(f.descriptor(), { operationId: "stop" }).then((value) => {
			replied = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(replied, false);
		f.complete();
		assert.equal((await stop).status, "settled");
	} finally {
		await f.cleanup();
	}
});

it("old compaction callback cannot finish a new generation", async () => {
	const f = await fixture();
	try {
		await f.hub.compact(f.descriptor(), { operationId: "old" });
		const old = f.oldCallback();
		await f.reload();
		await f.hub.compact(f.descriptor(), { operationId: "new" });
		old?.({ summary: "old", firstKeptEntryId: "old", tokensBefore: 1 });
		assert.equal((await f.hub.snapshot(f.descriptor())).isCompacting, true);
		assert.equal((await f.hub.operationStatus(f.descriptor(), "new")).status, "submitted");
		f.complete();
	} finally {
		await f.cleanup();
	}
});

it("production router preserves compact context, operation binding and mode gate without SDK fallback", async () => {
	const f = await fixture();
	const frames: Array<Record<string, unknown>> = [];
	let sdkCalls = 0;
	const runtime = Object.assign(Object.create(PiRuntime.prototype), {
		listSessions: async () => [],
		openSession: async () => {
			sdkCalls++;
			throw new Error("no SDK handle");
		},
		beginCompact: async () => {
			sdkCalls++;
			throw new Error("no SDK compact");
		},
	}) as PiRuntime;
	const modes = new HostModeStore(join(f.root, "mode.json"));
	modes.write("bridge");
	const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modes, bridge: f.hub });
	try {
		const d = f.descriptor();
		await client.handleMessage({
			type: "compact",
			sessionId: d.sessionId,
			operationId: "stale",
			instanceId: d.instanceId,
			epoch: "old",
		});
		assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
		assert.equal(f.calls(), 0);
		await client.handleMessage({
			type: "compact",
			sessionId: d.sessionId,
			operationId: "native",
			instanceId: d.instanceId,
			epoch: d.epoch,
		});
		const ack = frames.at(-1);
		assert.equal(ack?.kind, "compact-started");
		assert.equal(ack?.operationId, "native");
		assert.equal(ack?.isCompacting, true);
		assert.equal(ack?.isStreaming, false);
		assert.deepEqual(ack?.contextUsage, { tokens: 500, contextWindow: 1000, percent: 50 });
		await client.handleMessage({ type: "state", sessionId: d.sessionId });
		assert.equal(frames.at(-1)?.isCompacting, true);
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(frames.at(-1)?.code, "mode-switch-blocked");
		f.complete();
		await client.handleMessage({ type: "state", sessionId: d.sessionId });
		assert.equal(frames.at(-1)?.isCompacting, false);
		assert.equal(frames.at(-1)?.isStreaming, false);
		assert.deepEqual(frames.at(-1)?.contextUsage, { tokens: null, contextWindow: 1000, percent: null });
		assert.equal(sdkCalls, 0);
	} finally {
		client.close();
		await f.cleanup();
	}
});

it("submitted message with unavailable state does not invent non-compacting activity", async () => {
	const f = await fixture();
	const frames: Array<Record<string, unknown>> = [];
	const runtime = Object.assign(Object.create(PiRuntime.prototype), { listSessions: async () => [] }) as PiRuntime;
	const modes = new HostModeStore(join(f.root, "mode.json"));
	modes.write("bridge");
	f.hub.send = async () => ({ kind: "reply", id: "synthetic", ok: true, status: "submitted" });
	f.hub.snapshot = async () => {
		throw new Error("synthetic transient state failure");
	};
	const client = connectClient(runtime, (frame) => frames.push(frame), { hostModeStore: modes, bridge: f.hub });
	try {
		const d = f.descriptor();
		await client.handleMessage({
			type: "message",
			sessionId: d.sessionId,
			text: "preserve state",
			operationId: "message",
			instanceId: d.instanceId,
			epoch: d.epoch,
		});
		assert.equal(frames.at(-1)?.kind, "sent");
		assert.equal(frames.at(-1)?.disposition, "submitted");
		assert.equal("isCompacting" in (frames.at(-1) ?? {}), false);
		assert.equal("contextUsage" in (frames.at(-1) ?? {}), false);
	} finally {
		client.close();
		await f.cleanup();
	}
});

it("native compaction events preserve trigger and retry-turn metadata", async () => {
	const f = await fixture();
	const events: Array<{ event: unknown }> = [];
	let done: () => void = () => {};
	const ended = new Promise<void>((resolve) => {
		done = resolve;
	});
	const detach = await f.hub.subscribe(f.descriptor(), {
		onSnapshot: () => {},
		onClose: () => {},
		onEvent: (frame) => {
			events.push(frame);
			if ((frame.event as { type?: string }).type === "compaction_end") done();
		},
	});
	try {
		await f.handlers.get("session_before_compact")?.({ reason: "overflow", willRetry: true }, f.ctx);
		await f.handlers.get("session_compact")?.(
			{ reason: "overflow", willRetry: true, compactionEntry: { id: "native", tokensBefore: 500 } },
			f.ctx,
		);
		await ended;
		const phases = events
			.map((frame) => frame.event as { type: string; reason?: string; willRetry?: boolean })
			.filter((e) => e.type.startsWith("compaction_"));
		assert.equal(phases[0]?.reason, "overflow");
		assert.equal(phases[1]?.reason, "overflow");
		assert.equal(phases[1]?.willRetry, true);
	} finally {
		detach();
		await f.cleanup();
	}
});

it("deferred native terminal cannot finish the next compaction in the same epoch", async () => {
	const f = await fixture();
	try {
		await f.handlers.get("session_before_compact")?.({ reason: "threshold", willRetry: false }, f.ctx);
		await f.handlers.get("session_compact_failed")?.({ reason: "threshold", willRetry: false, aborted: true }, f.ctx);
		await f.handlers.get("session_before_compact")?.({ reason: "manual", willRetry: false }, f.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await f.hub.snapshot(f.descriptor())).isCompacting, true);
	} finally {
		await f.cleanup();
	}
});

it("message during manual compaction is rejected before submitted instead of losing the draft", async () => {
	const f = await fixture();
	try {
		await f.hub.compact(f.descriptor(), { operationId: "compact-before-message" });
		await assert.rejects(
			f.hub.send(f.descriptor(), { operationId: "message", text: "keep draft", deliverAs: "followUp" }),
			{ code: "compaction-busy" },
		);
		assert.equal((await f.hub.operationStatus(f.descriptor(), "message")).status, "unknown");
		f.complete();
	} finally {
		await f.cleanup();
	}
});
