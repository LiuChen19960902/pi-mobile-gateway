import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import mobileBridge from "../bridge-extension/src/index.ts";
import type { BridgeReply } from "../bridge-extension/src/protocol.ts";
import { BridgeHub, BridgeUnavailableError } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";

const models = [
	{
		provider: "fixture",
		id: "a",
		name: "A",
		reasoning: true,
		thinkingLevelMap: { off: null, xhigh: "high" },
		input: ["text"],
		contextWindow: 1000,
		maxTokens: 100,
		baseUrl: "https://secret.invalid",
		headers: { Authorization: "NEVER-SEND" },
	},
	{
		provider: "fixture",
		id: "b",
		name: "B",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 2000,
		maxTokens: 200,
	},
	{
		provider: "Fixture",
		id: "a",
		name: "Separate case",
		reasoning: false,
		input: ["text"],
		contextWindow: 1000,
		maxTokens: 100,
	},
];

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pim-model-"));
	const oldRoot = process.env.PI_MOBILE_BRIDGE_ROOT;
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let current = models[0];
	let catalogue = models,
		refreshes = 0,
		busy = false,
		queued = false;
	let onRefresh: (() => Promise<void>) | undefined;
	let thinking = "low";
	let calls = 0;
	let gate: Promise<void> | undefined;
	let allowed = true;
	let thinkingFails = false;
	let editor: unknown;
	const pi = {
		registerCommand: () => {},
		on: (type: string, fn: (...args: unknown[]) => unknown) => handlers.set(type, fn),
		setModel: async (model: typeof current) => {
			calls++;
			if (gate) await gate;
			if (!allowed) return false;
			current = model;
			return true;
		},
		setThinkingLevel: (level: string) => {
			if (thinkingFails) throw new Error("synthetic thinking failure");
			thinking = current.reasoning ? level : "off";
		},
		getThinkingLevel: () => thinking,
	} as unknown as ExtensionAPI;
	mobileBridge(pi);
	const ctx = {
		mode: "tui",
		cwd: root,
		isIdle: () => !busy,
		hasPendingMessages: () => queued,
		get model() {
			return current;
		},
		get thinkingLevel() {
			return thinking;
		},
		scopedModels: [{ model: models[0] }, { model: models[1] }],
		modelRegistry: {
			getAvailable: () => catalogue,
			getError: () => undefined,
			refresh: async () => {
				refreshes++;
				await onRefresh?.();
			},
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
		ui: {
			getEditorComponent: () => editor,
			setEditorComponent: (value: unknown) => {
				editor = value;
			},
		},
		sessionManager: {
			getSessionId: () => "model-session",
			getSessionFile: () => null,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const hub = new BridgeHub({ root });
	const descriptor = hub.descriptors()[0];
	assert.ok(descriptor);
	let next = 0;
	async function request(payload: Record<string, unknown>) {
		const socket = createConnection(descriptor.socketPath);
		const frames: Record<string, unknown>[] = [];
		let buffer = "";
		const id = `test-${++next}`;
		return await new Promise<BridgeReply>((resolve, reject) => {
			const timeout = setTimeout(() => {
				socket.destroy();
				reject(new Error("IPC timeout"));
			}, 2000);
			socket.on("error", reject);
			socket.on("close", () => {
				clearTimeout(timeout);
				reject(new Error("IPC closed"));
			});
			socket.on("data", (data) => {
				buffer += data.toString();
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) break;
					const frame = JSON.parse(buffer.slice(0, end));
					buffer = buffer.slice(end + 1);
					frames.push(frame);
					if (frame.kind === "hello")
						socket.write(
							`${JSON.stringify({ id, instanceId: descriptor.instanceId, epoch: descriptor.epoch, sessionId: descriptor.sessionId, ...payload })}\n`,
						);
					if (frame.kind === "reply" && frame.id === id) {
						clearTimeout(timeout);
						socket.destroy();
						resolve(frame as BridgeReply);
					}
				}
			});
		});
	}
	return {
		root,
		hub,
		descriptor,
		request,
		handlers,
		ctx,
		calls: () => calls,
		refreshes: () => refreshes,
		setRefresh: (fn: () => Promise<void>) => {
			onRefresh = fn;
		},
		replaceCatalogue: (value: typeof models) => {
			catalogue = value;
		},
		externalModel: (value: typeof current) => {
			current = value;
		},
		setBusy: (value: boolean, pending = false) => {
			busy = value;
			queued = pending;
		},
		setGate: (p: Promise<void>) => {
			gate = p;
		},
		failThinking: () => {
			thinkingFails = true;
		},
		refuse: () => {
			allowed = false;
		},
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({ reason: "exit" });
			if (oldRoot === undefined) delete process.env.PI_MOBILE_BRIDGE_ROOT;
			else process.env.PI_MOBILE_BRIDGE_ROOT = oldRoot;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

it("native catalog honors CLI scope and exposes only safe fields with Pi thinking levels", async () => {
	const f = await fixture();
	try {
		const reply = await f.request({ op: "models" });
		assert.equal(reply.ok, true);
		assert.deepEqual(
			reply.groups?.map((g) => [g.provider, ...g.models.map((m) => m.id)]),
			[["fixture", "a", "b"]],
		);
		assert.deepEqual(reply.groups?.[0].models[0].thinkingLevels, ["minimal", "low", "medium", "high", "xhigh"]);
		assert.equal(JSON.stringify(reply).includes("NEVER-SEND"), false);
		assert.equal(JSON.stringify(reply).includes("secret.invalid"), false);
		f.ctx.scopedModels = [];
		assert.equal((await f.request({ op: "models" })).groups?.length, 2);
	} finally {
		await f.cleanup();
	}
});

it("model writes call native APIs, deduplicate concurrent retry and return effective level", async () => {
	const f = await fixture();
	try {
		let release!: () => void;
		f.setGate(
			new Promise<void>((r) => {
				release = r;
			}),
		);
		const payload = {
			op: "set-model",
			operationId: "model-op",
			provider: "fixture",
			modelId: "b",
			thinkingLevel: "high",
		};
		const a = f.request(payload);
		await new Promise((r) => setTimeout(r, 25));
		const b = f.request(payload);
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(f.calls(), 1);
		assert.equal(
			(await f.request({ op: "send", operationId: "model-op", text: "must not submit" })).code,
			"operation-id-conflict",
		);
		release();
		const replies = await Promise.all([a, b]);
		for (const reply of replies) {
			assert.equal(reply.ok, true);
			assert.equal(reply.thinkingLevel, "off");
			assert.deepEqual(reply.model, { provider: "fixture", modelId: "b" });
		}
		assert.equal(f.calls(), 1);
		assert.equal((await f.request({ ...payload, modelId: "a" })).code, "operation-id-conflict");
		assert.equal((await f.request({ ...payload, operationId: "case", provider: "Fixture" })).code, "model-not-found");
	} finally {
		await f.cleanup();
	}
});

it("native auth failure and stale identity never become successful model writes", async () => {
	const f = await fixture();
	try {
		f.refuse();
		assert.equal(
			(await f.request({ op: "set-model", operationId: "auth", provider: "fixture", modelId: "a" })).code,
			"model-auth-missing",
		);
		assert.equal(
			(await f.request({ op: "set-model", operationId: "stale", provider: "fixture", modelId: "b", epoch: "old" }))
				.code,
			"stale-runtime",
		);
		assert.equal(f.calls(), 1);
	} finally {
		await f.cleanup();
	}
});

it("production router routes scoped catalog and writes through IPC without SDK handles", async () => {
	const f = await fixture();
	const frames: Record<string, unknown>[] = [];
	const runtime = new PiRuntime({
		sessionDir: f.root,
		modelRegistry: { getAvailable: async () => [], getModel: () => undefined },
	});
	runtime.listModels = async () => {
		throw new Error("SDK catalog must not run");
	};
	runtime.setModel = async () => {
		throw new Error("SDK writer must not run");
	};
	const mode = new HostModeStore(join(f.root, "mode.json"));
	mode.write("bridge");
	const client = connectClient(runtime, (frame) => frames.push(frame), { bridge: f.hub, hostModeStore: mode });
	try {
		const identity = {
			sessionId: f.descriptor.sessionId,
			instanceId: f.descriptor.instanceId,
			epoch: f.descriptor.epoch,
		};
		await client.handleMessage({ type: "models", queryId: "q1", ...identity });
		assert.equal(frames.at(-1)?.kind, "models");
		assert.equal(frames.at(-1)?.queryId, "q1");
		assert.equal(frames.at(-1)?.sessionId, "model-session");
		await client.handleMessage({
			type: "set-model",
			operationId: "write-1",
			provider: "fixture",
			modelId: "b",
			thinkingLevel: "high",
			...identity,
		});
		assert.equal(frames.at(-1)?.kind, "model-set");
		assert.equal(frames.at(-1)?.operationId, "write-1");
		assert.equal(frames.at(-1)?.thinkingLevel, "off");
		await client.handleMessage({ type: "models", queryId: "q2", ...identity, epoch: "old" });
		assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
		assert.equal(frames.at(-1)?.queryId, "q2");
	} finally {
		client.close();
		runtime.disposeAll();
		await f.cleanup();
	}
});

it("native model events never expose complete Model credentials and busy changes stay busy", async () => {
	const f = await fixture();
	const events: unknown[] = [];
	const detach = await f.hub.subscribe(f.descriptor, {
		onSnapshot: () => {},
		onEvent: (event) => events.push(event),
		onClose: () => {},
	});
	try {
		await f.handlers.get("model_select")?.({ type: "model_select", model: models[0] }, f.ctx);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(events.length, 1);
		assert.equal(JSON.stringify(events).includes("NEVER-SEND"), false);
		assert.equal(JSON.stringify(events).includes("secret.invalid"), false);
		f.ctx.isIdle = () => false;
		const reply = await f.request({
			op: "set-model",
			operationId: "busy-choice",
			provider: "fixture",
			modelId: "b",
			thinkingLevel: "high",
		});
		assert.equal(reply.ok, true);
		assert.equal(reply.busy, true);
		assert.equal(reply.thinkingLevel, "off");
	} finally {
		detach();
		await f.cleanup();
	}
});

it("a previous epoch model write rejects new writes promptly until native completion", async () => {
	const f = await fixture();
	let release: () => void = () => {};
	try {
		f.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const old = f
			.request({ op: "set-model", operationId: "old-model", provider: "fixture", modelId: "a" })
			.catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
		const next = f.hub.descriptors()[0];
		assert.notEqual(next.epoch, f.descriptor.epoch);
		const reply = await f.request({
			op: "set-model",
			operationId: "new-model",
			provider: "fixture",
			modelId: "b",
			epoch: next.epoch,
		});
		assert.equal(reply.code, "model-change-pending");
		assert.equal(f.calls(), 1);
		release();
		await old;
		await new Promise((resolve) => setTimeout(resolve, 25));
		const retry = await f.request({
			op: "set-model",
			operationId: "retry-model",
			provider: "fixture",
			modelId: "b",
			epoch: next.epoch,
		});
		assert.equal(retry.ok, true);
		assert.equal(retry.model?.modelId, "b");
	} finally {
		release();
		await f.cleanup();
	}
});

it("thinking exceptions report an unconfirmed result and state preserves the actual changed model", async () => {
	const f = await fixture();
	try {
		f.failThinking();
		const reply = await f.request({
			op: "set-model",
			operationId: "partial-model",
			provider: "fixture",
			modelId: "b",
			thinkingLevel: "high",
		});
		assert.equal(reply.ok, false);
		assert.equal(reply.code, "model-change-unconfirmed");
		assert.equal((await f.hub.snapshot(f.descriptor)).model?.modelId, "b");
	} finally {
		await f.cleanup();
	}
});

it("lost native model replies are uncertain and never prove the instance went offline", async () => {
	const f = await fixture();
	const frames: Record<string, unknown>[] = [];
	const runtime = new PiRuntime({
		sessionDir: f.root,
		modelRegistry: { getAvailable: async () => [], getModel: () => undefined },
	});
	const mode = new HostModeStore(join(f.root, "uncertain-mode.json"));
	mode.write("bridge");
	const client = connectClient(runtime, (frame) => frames.push(frame), { bridge: f.hub, hostModeStore: mode });
	try {
		f.hub.setModel = async () => {
			throw new BridgeUnavailableError("synthetic timeout");
		};
		const identity = {
			sessionId: f.descriptor.sessionId,
			instanceId: f.descriptor.instanceId,
			epoch: f.descriptor.epoch,
		};
		await client.handleMessage({
			type: "set-model",
			operationId: "uncertain",
			provider: "fixture",
			modelId: "a",
			...identity,
		});
		assert.equal(frames.at(-1)?.code, "model-change-unconfirmed");
		assert.equal(frames.at(-1)?.operationId, "uncertain");
		f.hub.models = async () => {
			throw new BridgeUnavailableError("synthetic timeout");
		};
		await client.handleMessage({ type: "models", queryId: "uncertain-read", ...identity });
		assert.equal(frames.at(-1)?.code, "bridge-unavailable");
		assert.equal(frames.at(-1)?.queryId, "uncertain-read");
	} finally {
		client.close();
		runtime.disposeAll();
		await f.cleanup();
	}
});

it("native refresh reapplies the same model with fresh configuration once, preserving scope and hiding secrets", async () => {
	const f = await fixture();
	try {
		const fresh = {
			...models[0],
			baseUrl: "https://updated.invalid",
			thinkingLevelMap: { off: null, xhigh: "high" },
			headers: { Authorization: "NEVER-SEND" },
		};
		f.setRefresh(async () => {
			f.replaceCatalogue([fresh, models[1], models[2]]);
		});
		const reply = await f.hub.refreshModel(f.descriptor, "refresh-1");
		assert.equal(reply.model?.modelId, "a");
		assert.equal(f.ctx.model, fresh);
		assert.equal(reply.thinkingLevel, "low");
		assert.equal(f.ctx.scopedModels.length, 2);
		assert.equal(f.refreshes(), 1);
		assert.equal(f.calls(), 1);
		assert.equal((await f.hub.refreshModel(f.descriptor, "refresh-1")).duplicate, true);
		assert.equal(f.refreshes(), 1);
		assert.equal(f.calls(), 1);
		assert.ok(!JSON.stringify(reply).includes("updated.invalid"));
		assert.ok(!JSON.stringify(reply).includes("NEVER-SEND"));
	} finally {
		await f.cleanup();
	}
});
it("native refresh refuses busy and queued work without touching configuration or model", async () => {
	const f = await fixture();
	try {
		f.setBusy(true);
		await assert.rejects(f.hub.refreshModel(f.descriptor, "busy-refresh"), { code: "model-refresh-busy" });
		f.setBusy(false, true);
		await assert.rejects(f.hub.refreshModel(f.descriptor, "queued-refresh"), { code: "model-refresh-busy" });
		assert.equal(f.refreshes(), 0);
		assert.equal(f.calls(), 0);
	} finally {
		await f.cleanup();
	}
});
it("native refresh cannot overwrite a model changed while registry refresh is pending", async () => {
	const f = await fixture();
	try {
		let release = () => {},
			entered = false;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		f.setRefresh(async () => {
			entered = true;
			await gate;
		});
		const pending = f.hub.refreshModel(f.descriptor, "race-refresh");
		for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 1));
		assert.ok(entered);
		assert.equal((await f.hub.snapshot(f.descriptor)).controlPending, true);
		f.externalModel(models[1]);
		release();
		await assert.rejects(pending, { code: "model-change-unconfirmed" });
		assert.equal(f.ctx.model, models[1]);
		assert.equal(f.calls(), 0);
	} finally {
		await f.cleanup();
	}
});
it("native refresh errors are stable and router never opens an SDK session", async () => {
	const f = await fixture();
	try {
		const runtime = new PiRuntime({ agentDir: join(f.root, "agent"), sessionDir: join(f.root, "sessions") });
		let opened = 0;
		runtime.openSession = async () => {
			opened++;
			throw new Error("forbidden");
		};
		const mode = new HostModeStore(join(f.root, "mode.json"));
		mode.write("bridge");
		const frames: Record<string, unknown>[] = [];
		const client = connectClient(runtime, (x) => frames.push(x), { bridge: f.hub, hostModeStore: mode });
		try {
			const binding = {
				sessionId: f.descriptor.sessionId,
				instanceId: f.descriptor.instanceId,
				epoch: f.descriptor.epoch,
			};
			await client.handleMessage({ type: "refresh-model", ...binding, operationId: "wire-refresh" });
			assert.equal(frames.at(-1)?.kind, "model-refreshed");
			assert.equal(frames.at(-1)?.operationId, "wire-refresh");
			f.setRefresh(async () => {
				throw new Error("PRIVATE CONFIG ERROR");
			});
			await client.handleMessage({ type: "refresh-model", ...binding, operationId: "error-refresh" });
			assert.equal(frames.at(-1)?.code, "model-config-refresh-failed");
			assert.ok(!JSON.stringify(frames).includes("PRIVATE CONFIG"));
			assert.equal(opened, 0);
		} finally {
			client.close();
			runtime.disposeAll();
		}
	} finally {
		await f.cleanup();
	}
});
