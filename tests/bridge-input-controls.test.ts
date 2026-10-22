import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import mobileBridge from "../bridge-extension/src/index.ts";
import { BridgeHub } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pim-input-")),
		old = process.env.PI_MOBILE_BRIDGE_ROOT;
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const manager = SessionManager.inMemory(root),
		handlers = new Map<string, (...args: unknown[]) => unknown>();
	let enabled: boolean | undefined,
		reads = 0;
	const sourceInfo = { source: "path", scope: "user", path: "/PRIVATE/skill.md", baseDir: "/PRIVATE" };
	const commands = [
		{ name: "skill:review", description: "Review", source: "skill", sourceInfo },
		{ name: "greet", description: "Greet", source: "prompt", sourceInfo },
		{ name: "blocked", description: "Hidden", source: "prompt", sourceInfo },
		{ name: "blocked", source: "extension", sourceInfo },
		{ name: "skill:review", source: "prompt", sourceInfo },
		{ name: "danger", source: "extension", sourceInfo },
	];
	const sent: Array<{ text: unknown; options: { expandPromptTemplates?: boolean; deliverAs?: string } }> = [];
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
		registerCommand: () => {},
		getCommands: () => {
			reads++;
			return commands;
		},
		getSettings: () => ({ enableSkillCommands: enabled }),
		sendUserMessage: (text: unknown, options: { expandPromptTemplates?: boolean; deliverAs?: string }) =>
			sent.push({ text, options }),
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		cwd: root,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: manager,
		ui: { getEditorComponent: () => undefined, setEditorComponent: () => {} },
	} as unknown as ExtensionContext;
	mobileBridge(pi);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const hub = new BridgeHub({ root });
	let descriptor = hub.descriptors()[0];
	assert.ok(descriptor);
	const read = () => hub.inputResources(descriptor);
	return {
		root,
		hub,
		read,
		sent,
		reads: () => reads,
		descriptor: () => descriptor,
		enabled: (v: boolean) => {
			enabled = v;
		},
		send: (text: string, operationId: string) => hub.send(descriptor, { operationId, text }),
		reload: async () => {
			await handlers.get("session_shutdown")?.({ reason: "reload" });
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

it("native input uses current commands/settings, defaults skills on and removes paths and shadowed entries", async () => {
	const f = await fixture();
	try {
		const r = await f.read();
		assert.equal(r.skillCommandsEnabled, true);
		assert.deepEqual(
			r.commands?.map((x) => [x.name, x.source]),
			[
				["skill:review", "skill"],
				["greet", "prompt"],
			],
		);
		assert.ok(!JSON.stringify(r).includes("PRIVATE"));
		f.enabled(false);
		const disabled = await f.read();
		assert.equal(disabled.skillCommandsEnabled, false);
		assert.deepEqual(
			disabled.commands?.map((x) => x.name),
			["greet"],
		);
	} finally {
		await f.cleanup();
	}
});
it("native invocation expands only current skills/prompts; explicit skills ignore suggestion flag and extension is rejected", async () => {
	const f = await fixture();
	try {
		await f.send("/greet FineCat", "prompt");
		f.enabled(false);
		await f.send("/skill:review args", "skill");
		await f.send("plain text", "plain");
		await f.send("/unknown args", "unknown");
		await f.send("/greet\tFineCat", "tab");
		await f.send("/greet　FineCat", "wide");
		assert.deepEqual(
			f.sent.map((x) => x.options.expandPromptTemplates),
			[true, true, false, false, true, true],
		);
		await assert.rejects(f.send("/danger", "extension"), { code: "unsupported" });
		await assert.rejects(f.send("/blocked", "masked"), { code: "unsupported" });
		assert.equal(f.sent.length, 6);
	} finally {
		await f.cleanup();
	}
});
it("native input router binds query identity, completes files and never opens SDK handles", async () => {
	const f = await fixture();
	let closed: (() => void) | undefined;
	try {
		writeFileSync(join(f.root, "native-file.txt"), "private file body");
		let opened = 0;
		const runtime = new PiRuntime({ sessionDir: join(f.root, "sessions"), agentDir: join(f.root, "agent") });
		runtime.openSession = async () => {
			opened++;
			throw new Error("SDK FORBIDDEN");
		};
		const mode = new HostModeStore(join(f.root, "host-mode.json"));
		mode.write("bridge");
		const frames: Record<string, unknown>[] = [];
		const client = connectClient(runtime, (frame) => frames.push(frame), { bridge: f.hub, hostModeStore: mode });
		closed = () => client.close();
		const d = f.descriptor(),
			binding = { sessionId: d.sessionId, instanceId: d.instanceId, epoch: d.epoch };
		await client.handleMessage({ type: "input-resources", queryId: "resources", ...binding });
		assert.equal(frames.at(-1)?.kind, "input-resources");
		assert.equal(frames.at(-1)?.complete, true);
		assert.equal(frames.at(-1)?.epoch, d.epoch);
		assert.equal(frames.at(-1)?.queryId, "resources");
		const count = f.reads();
		await client.handleMessage({ type: "input-completions", queryId: "paths", token: "@native", ...binding });
		assert.equal(frames.at(-1)?.kind, "input-completions");
		assert.ok(JSON.stringify(frames.at(-1)?.items).includes("native-file.txt"));
		assert.ok(!JSON.stringify(frames.at(-1)).includes("private file body"));
		assert.equal(f.reads(), count);
		await client.handleMessage({ type: "input-resources", queryId: "stale", ...binding, epoch: "old" });
		assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
		assert.equal(frames.at(-1)?.queryId, "stale");
		await client.handleMessage({ type: "input-resources", queryId: "unbound", sessionId: d.sessionId });
		assert.equal(frames.at(-1)?.code, "bad-request");
		assert.equal(opened, 0);
	} finally {
		closed?.();
		await f.cleanup();
	}
});

it("native input finishing after reload returns a correlated stale error, never the old list", async () => {
	const f = await fixture();
	let client: ReturnType<typeof connectClient> | undefined;
	try {
		const original = f.hub.inputResources.bind(f.hub);
		let release!: (v: Awaited<ReturnType<typeof original>>) => void;
		const gate = new Promise<Awaited<ReturnType<typeof original>>>((r) => {
			release = r;
		});
		let entered = false;
		const result = await original(f.descriptor());
		f.hub.inputResources = async () => {
			entered = true;
			return gate;
		};
		const runtime = new PiRuntime({ sessionDir: join(f.root, "sessions"), agentDir: join(f.root, "agent") });
		const mode = new HostModeStore(join(f.root, "mode"));
		mode.write("bridge");
		const frames: Record<string, unknown>[] = [];
		client = connectClient(runtime, (f) => frames.push(f), { bridge: f.hub, hostModeStore: mode });
		const d = f.descriptor();
		const pending = client.handleMessage({
			type: "input-resources",
			queryId: "old",
			sessionId: d.sessionId,
			instanceId: d.instanceId,
			epoch: d.epoch,
		});
		for (let retry = 0; !entered && retry < 100; retry++) await new Promise((r) => setTimeout(r, 1));
		assert.ok(entered);
		await f.reload();
		release(result);
		await pending;
		assert.equal(frames.at(-1)?.kind, "error");
		assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
		assert.equal(frames.at(-1)?.queryId, "old");
		assert.equal(frames.at(-1)?.epoch, d.epoch);
	} finally {
		client?.close();
		await f.cleanup();
	}
});

it("aborting native resource reads closes the actual IPC socket and releases its waiter", {
	timeout: 2000,
}, async () => {
	const f = await fixture();
	const server = createServer();
	const path = join(f.root, "slow.sock");
	let connected!: () => void, closed!: () => void;
	const connection = new Promise<void>((r) => {
			connected = r;
		}),
		closure = new Promise<void>((r) => {
			closed = r;
		});
	server.on("connection", (socket) => {
		socket.on("data", () => connected());
		socket.on("close", closed);
	});
	try {
		server.listen(path);
		await once(server, "listening");
		const controller = new AbortController();
		const pending = f.hub.inputResources({ ...f.descriptor(), socketPath: path }, controller.signal);
		const rejected = assert.rejects(pending);
		await connection;
		controller.abort();
		await rejected;
		await closure;
		await assert.rejects(f.hub.inputResources({ ...f.descriptor(), socketPath: path }, controller.signal));
	} finally {
		server.close();
		await f.cleanup();
	}
});
