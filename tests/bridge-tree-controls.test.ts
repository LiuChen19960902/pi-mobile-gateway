import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { BridgeEditor } from "../bridge-extension/src/editor.ts";
import mobileBridge from "../bridge-extension/src/index.ts";
import { BridgeHub } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";
import { type PiTreeNode, toWireTreeNodes } from "../src/wire.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pim-tree-")),
		old = process.env.PI_MOBILE_BRIDGE_ROOT;
	process.env.PI_MOBILE_BRIDGE_ROOT = root;
	const manager = SessionManager.inMemory(root),
		handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();
	const user = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: `node user ${"汉".repeat(260)}` },
			{ type: "image", data: "PRIVATE-IMAGE", mimeType: "image/png" },
		],
		timestamp: 1,
	});
	const custom = manager.appendCustomMessageEntry("fixture", "custom full text", true);
	let factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
	let editor: BridgeEditor;
	let busy = false,
		pending = false,
		calls = 0,
		cancelled = false;
	let navigationGate: Promise<void> | undefined;
	let afterGate: (() => void) | undefined;
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
		registerCommand: (
			name: string,
			command: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, command),
		setLabel: (id: string, label: string | undefined) => manager.appendLabelChange(id, label),
		setSessionName: (name: string) => manager.appendSessionInfo(name),
		sendUserMessage: (text: string, options: { expandPromptTemplates?: boolean }) => {
			assert.equal(options.expandPromptTemplates, true);
			const [name, nonce] = text.slice(1).split(" ");
			const command = commands.get(name);
			assert.ok(command);
			void command.handler(nonce, {
				...ctx,
				navigateTree: async (id: string, options: { summarize?: boolean }) => {
					calls++;
					assert.equal(options.summarize, false);
					if (navigationGate) await navigationGate;
					afterGate?.();
					if (cancelled) return { cancelled: true };
					const entry = manager.getEntry(id);
					assert.ok(entry);
					if (entry.type === "message" && entry.message.role === "user") {
						if (entry.parentId) manager.branch(entry.parentId);
						else manager.resetLeaf();
						const text =
							typeof entry.message.content === "string"
								? entry.message.content
								: entry.message.content
										.filter((b) => b.type === "text")
										.map((b) => b.text)
										.join("");
						if (text && !editor.getText().trim()) editor.setText(text);
					} else if (entry.type === "custom_message") {
						if (entry.parentId) manager.branch(entry.parentId);
						else manager.resetLeaf();
						if (!editor.getText().trim()) editor.setText(String(entry.content));
					} else manager.branch(id);
					return { cancelled: false };
				},
			} as ExtensionCommandContext);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		cwd: root,
		isIdle: () => !busy,
		hasPendingMessages: () => pending,
		sessionManager: manager,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (value: typeof factory) => {
				factory = value;
				if (value)
					editor = value(
						{ requestRender: () => {} } as never,
						{ borderColor: (v: string) => v } as never,
						{ matches: () => false } as never,
					) as BridgeEditor;
			},
		},
	} as unknown as ExtensionContext;
	mobileBridge(pi);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const hub = new BridgeHub({ root });
	let descriptor = hub.descriptors()[0];
	assert.ok(descriptor);
	const call = (op: Parameters<BridgeHub["treeControl"]>[1], input: Record<string, unknown> = {}) =>
		hub.treeControl(descriptor, op, input);
	return {
		root,
		manager,
		hub,
		user,
		custom,
		call,
		descriptor: () => descriptor,
		editor: () => editor,
		calls: () => calls,
		busy: (v: boolean) => {
			busy = v;
		},
		pending: (v: boolean) => {
			pending = v;
		},
		cancel: () => {
			cancelled = true;
		},
		gate: (gate: Promise<void>, during?: () => void) => {
			navigationGate = gate;
			afterGate = during;
		},
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
it("native tree reads unflushed live entries; copy is full text and excludes images", async () => {
	const f = await fixture();
	try {
		const tree = await f.call("tree");
		assert.equal(tree.tree?.length, 2);
		assert.equal(tree.leafId, f.custom);
		assert.equal(JSON.stringify(tree).includes("PRIVATE-IMAGE"), false);
		const copied = await f.call("entry-copy", { entryId: f.user });
		assert.equal(copied.text, `node user ${"汉".repeat(260)}`);
		assert.equal(copied.bytes, Buffer.byteLength(copied.text ?? ""));
		await assert.rejects(f.call("entry-copy", { entryId: "missing" }), { code: "entry-not-found" });
	} finally {
		await f.cleanup();
	}
});
it("label/name write the native manager exactly once and enforce operation identity", async () => {
	const f = await fixture();
	try {
		const input = { operationId: "label", entryId: f.user, label: "  bookmark  " };
		const first = await f.call("label-put", input);
		assert.equal(first.label, "bookmark");
		assert.equal(f.manager.getLabel(f.user), "bookmark");
		const size = f.manager.getEntries().length;
		assert.equal((await f.call("label-put", input)).duplicate, true);
		assert.equal(f.manager.getEntries().length, size);
		await assert.rejects(f.call("name", { operationId: "label", name: "other" }), { code: "operation-id-conflict" });
		await f.call("name", { operationId: "name", name: "  native title  " });
		assert.equal(f.manager.getSessionName(), "native title");
		await f.call("label-put", { operationId: "clear", entryId: f.user, label: "  " });
		assert.equal(f.manager.getLabel(f.user), undefined);
	} finally {
		await f.cleanup();
	}
});
it("native navigation uses a fresh command, restores only its own editor fill and replays receipt", async () => {
	const f = await fixture();
	try {
		f.editor().setText("");
		const input = { operationId: "navigate", entryId: f.user };
		const result = await f.call("switch-branch", input);
		assert.equal(result.editorText, `node user ${"汉".repeat(260)}`);
		assert.equal(f.editor().getText(), "");
		assert.equal(result.leafId, null);
		await f.call("switch-branch", input);
		assert.equal(f.calls(), 1);
		f.editor().setText("desktop draft");
		await f.call("switch-branch", { operationId: "nav2", entryId: f.custom });
		assert.equal(f.editor().getText(), "desktop draft");
	} finally {
		await f.cleanup();
	}
});
it("typing during navigation and cancelled navigation preserve desktop draft", async () => {
	const f = await fixture();
	try {
		let release!: () => void;
		f.gate(
			new Promise<void>((r) => {
				release = r;
			}),
			() => f.editor().handleInput("new typing"),
		);
		const navigation = f.call("switch-branch", { operationId: "nav", entryId: f.custom });
		await new Promise((r) => setTimeout(r, 15));
		release();
		await navigation;
		assert.equal(f.editor().getText(), "new typing");
		f.cancel();
		await assert.rejects(f.call("switch-branch", { operationId: "cancel", entryId: f.user }), {
			code: "navigation-cancelled",
		});
		assert.equal(f.editor().getText(), "new typingnew typing");
	} finally {
		await f.cleanup();
	}
});
it("busy/pending native session never navigates or steals queued messages", async () => {
	const f = await fixture();
	try {
		f.busy(true);
		await assert.rejects(f.call("switch-branch", { operationId: "busy", entryId: f.user }), { code: "busy" });
		f.busy(false);
		f.pending(true);
		await assert.rejects(f.call("switch-branch", { operationId: "pending", entryId: f.user }), { code: "busy" });
		assert.equal(f.calls(), 0);
	} finally {
		await f.cleanup();
	}
});
it("gateway bridge tree controls never create SDK handles and bind replies to four identities", async () => {
	const f = await fixture();
	const frames: Record<string, unknown>[] = [];
	const runtime = new PiRuntime({ sessionDir: join(f.root, "sessions"), agentDir: join(f.root, "agent") });
	const mode = new HostModeStore(join(f.root, "mode.json"));
	mode.write("bridge");
	const connection = connectClient(runtime, (frame) => frames.push(frame), { bridge: f.hub, hostModeStore: mode });
	try {
		const identity = {
			sessionId: f.descriptor().sessionId,
			instanceId: f.descriptor().instanceId,
			epoch: f.descriptor().epoch,
		};
		await connection.handleMessage({
			type: "tree",
			...identity,
			operationId: "tree-1",
			view: { filter: "all", search: "", foldedIds: [] },
		});
		const tree = frames.at(-1);
		assert.ok(tree);
		assert.equal(tree.kind, "tree");
		assert.equal(tree.operationId, "tree-1");
		assert.equal((tree.nodes as unknown[]).length, 2);
		await connection.handleMessage({
			type: "label-put",
			...identity,
			operationId: "label-1",
			entryId: f.user,
			label: "mobile",
		});
		assert.equal(frames.at(-1)?.kind, "label-put");
		await connection.handleMessage({
			type: "tree",
			...identity,
			operationId: "tree-2",
			view: { filter: "labeled-only", search: "mobile", foldedIds: [] },
		});
		assert.equal((frames.at(-1)?.nodes as unknown[] | undefined)?.length, 1);
		await connection.handleMessage({ type: "entry-copy", ...identity, operationId: "copy", entryId: f.user });
		assert.equal(frames.at(-1)?.text, `node user ${"汉".repeat(260)}`);
		await connection.handleMessage({ type: "switch-branch", ...identity, operationId: "nav", entryId: f.user });
		assert.equal(frames.at(-1)?.kind, "branch-switched");
		assert.deepEqual(frames.at(-1)?.queued, [], "branch-switched queue is the shared Android list contract");
		await connection.handleMessage({ type: "name", ...identity, operationId: "name", name: "renamed" });
		assert.equal(frames.at(-1)?.kind, "session-named");
		assert.equal(frames.at(-1)?.queuedMessages, undefined);
		assert.equal(frames.at(-1)?.isStreaming, undefined);
		await connection.handleMessage({ type: "name", ...identity, epoch: "old", operationId: "late", name: "bad" });
		assert.equal(frames.at(-1)?.code, "bridge-stale-runtime");
		assert.equal(frames.at(-1)?.operationId, "late");
		assert.equal((await runtime.listSessions()).length, 0);
	} finally {
		connection.close();
		runtime.disposeAll();
		await f.cleanup();
	}
});

it("native copy rejects empty content and returns only byte metadata when oversized", async () => {
	const f = await fixture();
	try {
		const image = f.manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "PRIVATE-IMAGE", mimeType: "image/png" }],
			timestamp: 3,
		});
		const huge = f.manager.appendMessage({ role: "user", content: "汉".repeat(200000), timestamp: 4 });
		const tree = await f.call("tree");
		const row = tree.tree?.find((n) => n.entry.id === image);
		assert.ok(row);
		assert.ok(JSON.stringify(row).includes('"image"'));
		assert.equal(JSON.stringify(tree).includes("PRIVATE-IMAGE"), false);
		await assert.rejects(f.call("entry-copy", { entryId: image }), { code: "entry-copy-empty" });
		const copied = await f.call("entry-copy", { entryId: huge });
		assert.equal(copied.oversized, true);
		assert.equal(copied.text, undefined);
		assert.equal(copied.bytes, 600000);
	} finally {
		await f.cleanup();
	}
});

it("navigation timeout does not unlock another write or host mode switch before the native call ends", async () => {
	const f = await fixture();
	const runtime = new PiRuntime({ sessionDir: join(f.root, "sessions"), agentDir: join(f.root, "agent") });
	const modes = new HostModeStore(join(f.root, "mode.json"));
	modes.write("bridge");
	const frames: Record<string, unknown>[] = [];
	const client = connectClient(runtime, (frame) => frames.push(frame), { bridge: f.hub, hostModeStore: modes });
	let release!: () => void;
	f.gate(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	try {
		await assert.rejects(f.call("switch-branch", { operationId: "slow", entryId: f.user }), {
			code: "navigation-unconfirmed",
		});
		assert.equal((await f.hub.snapshot(f.descriptor())).controlPending, true);
		await assert.rejects(f.call("name", { operationId: "unsafe", name: "must wait" }), { code: "busy" });
		await assert.rejects(f.call("switch-branch", { operationId: "second", entryId: f.custom }), { code: "busy" });
		await client.handleMessage({ type: "host-mode-put", mode: "sdk" });
		assert.equal(frames.at(-1)?.code, "mode-switch-blocked");
		assert.ok((frames.at(-1)?.reasons as string[] | undefined)?.includes("in-flight"));
		release();
		for (let i = 0; i < 50 && (await f.hub.snapshot(f.descriptor())).controlPending; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal((await f.hub.snapshot(f.descriptor())).controlPending, false);
		await f.call("switch-branch", { operationId: "after", entryId: f.custom });
		assert.equal(f.calls(), 2);
	} finally {
		release();
		client.close();
		runtime.disposeAll();
		await f.cleanup();
	}
});

it("native tree whitespace prefix preserves the full-entry visibility rule", async () => {
	const f = await fixture();
	try {
		const assistant = f.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `${" ".repeat(250)}answer` }],
			api: "openai-completions",
			provider: "fixture",
			model: "offline",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 5,
		});
		const leaf = f.manager.appendCustomMessageEntry("after", "after", true);
		const view = { filter: "default" as const, search: "", foldedIds: [] };
		const original = f.manager.getEntry(assistant);
		assert.ok(original);
		const expected = toWireTreeNodes([{ entry: original, children: [] }], leaf, view);
		assert.equal(expected.length, 1);
		const read = await f.call("tree");
		const sanitized = read.tree?.find((n) => n.entry.id === assistant);
		assert.ok(sanitized);
		const actual = toWireTreeNodes(
			[{ entry: sanitized.entry as unknown as PiTreeNode["entry"], children: [] }],
			leaf,
			view,
		);
		assert.equal(actual.length, 1, "projection metadata must not hide a real nonblank assistant entry");
	} finally {
		await f.cleanup();
	}
});
