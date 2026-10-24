// 桥接扩展的真实 CLI 合成验证：原生 Pi 1.3.0 TUI + 合成 Provider/工具 +
// 独立 tmux 服务 + 临时 Pi 配置。客户端代替网关/手机，只走扩展的本机 socket。
// 由 run.py 在 bwrap 隔离环境中启动，路径固定为 /work。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = "/work/state";
const BRIDGE = `${ROOT}/bridge`;
const CLI = "/work/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const TMUX = "/usr/local/bin/tmux";
const SOCKET = "/work/tmux.sock";
const OBSERVE = `${ROOT}/observe.json`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { cases: [], passed: false };
const clients = [];

const tmux = (...args) => exec(TMUX, ["-S", SOCKET, "-f", "/dev/null", ...args], { maxBuffer: 4 * 1024 * 1024 });
const rows = () =>
	existsSync(`${ROOT}/fixture.jsonl`)
		? readFileSync(`${ROOT}/fixture.jsonl`, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const observe = () => {
	try {
		return JSON.parse(readFileSync(OBSERVE, "utf8"));
	} catch {
		return { editorText: "", pending: false, busy: false };
	}
};
const textOf = (message) => {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
};

async function until(check, label, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await sleep(40);
	}
	throw new Error(`timeout: ${label}`);
}

function descriptor() {
	let names = [];
	try {
		names = readdirSync(`${BRIDGE}/registry`).filter((name) => name.endsWith(".json"));
	} catch {
		return null;
	}
	const found = names
		.flatMap((name) => {
			try {
				return [JSON.parse(readFileSync(`${BRIDGE}/registry/${name}`, "utf8"))];
			} catch {
				return [];
			}
		})
		.filter((value) => value && typeof value.sessionId === "string")
		.sort((a, b) => Number(b.owner) - Number(a.owner) || b.startedAt - a.startedAt);
	return found[0] ?? null;
}

class Client {
	constructor(socket, desc) {
		this.socket = socket;
		this.desc = desc;
		this.frames = [];
		this.pending = new Map();
		this.buffer = "";
		socket.on("data", (chunk) => {
			this.buffer += chunk.toString("utf8");
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (!line) continue;
				const frame = JSON.parse(line);
				this.frames.push(frame);
				const waiter = this.pending.get(frame.id);
				if (waiter) {
					this.pending.delete(frame.id);
					waiter.resolve(frame);
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			for (const waiter of this.pending.values()) waiter.reject(new Error("socket closed"));
			this.pending.clear();
		});
	}
	call(op, payload = {}) {
		return this.raw(op, this.desc, payload);
	}
	raw(op, identity, payload = {}) {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout: ${op}`));
			}, 12_000);
			this.pending.set(id, {
				resolve,
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.socket.write(
				`${JSON.stringify({
					id,
					op,
					instanceId: identity.instanceId,
					epoch: identity.epoch,
					sessionId: identity.sessionId,
					...payload,
				})}\n`,
			);
		});
	}
	async snapshot() {
		const reply = await this.call("snapshot");
		assert.equal(reply.ok, true, JSON.stringify(reply));
		return reply.snapshot;
	}
	close() {
		this.socket.destroy();
	}
}

async function connect(selected) {
	const desc = selected ?? (await until(() => descriptor(), "bridge registry"));
	const socket = createConnection(desc.socketPath);
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const client = new Client(socket, desc);
	clients.push(client);
	await until(() => client.frames.some((frame) => frame.kind === "hello"), "bridge hello");
	return client;
}

async function input(name, text) {
	await tmux("send-keys", "-t", name, "-l", "--", text);
	await tmux("send-keys", "-t", name, "Enter");
}
const release = (key) => writeFileSync(`${ROOT}/gates/${key}.release`, "release\n");

function trace(name, data = {}) {
	results.cases.push({ name, pass: true, ...data });
	writeFileSync("/work/results.json", `${JSON.stringify(results, null, 2)}\n`);
	console.log(JSON.stringify({ name, pass: true, ...data }));
}

// R2 限定场景：另一个正常 custom editor 占用输入框时的停止/队列归属。
// 只跑这两组，不重跑无关变体；观察全部通过公开 API（编辑器正文/队列布尔/busy）。
async function foreignEditorCases(client, panePid) {
	const owned = await client.snapshot();
	assert.equal(owned.editor, "unavailable", "别家正常编辑器在岗时桥接必须报告 unavailable");
	assert.equal(owned.pid, panePid);
	const refused = await client.call("dequeue", { operationId: "foreign-dequeue" });
	assert.equal(refused.ok, false, "不能借用别家编辑器的 dequeue 动作");
	assert.equal(refused.code, "editor-unavailable");

	// 空的非桥接编辑器仍可原生导航；不要求dequeue，也不撤回Pi自己的回填。
	const seedText = "foreign_tree_empty_seed";
	assert.equal((await client.call("send", { operationId: "foreign-tree-seed", text: seedText })).ok, true);
	await until(
		async () =>
			rows().some((row) => row.value.modelRequest && row.value.text === seedText) && !(await client.snapshot()).busy,
		"foreign tree seed settled",
	);
	const firstTree = await client.call("tree");
	const target = firstTree.tree.find(
		(node) =>
			node.entry.type === "message" && node.entry.message?.role === "user" && textOf(node.entry.message) === seedText,
	);
	assert.ok(target);
	const emptyNav = await client.call("switch-branch", { operationId: "foreign-tree-empty", entryId: target.entry.id });
	assert.equal(emptyNav.ok, true, JSON.stringify(emptyNav));
	assert.equal(emptyNav.editorText, seedText);
	await until(() => observe().editorText === seedText, "native foreign editor fill");
	assert.equal((await client.snapshot()).pid, panePid);
	trace("foreign-editor-empty-navigation-native-fill");
	await tmux("send-keys", "-t", "cli", "C-u");
	await until(() => observe().editorText === "", "clear synthetic navigation fill");

	// ① 无排队稿的停止：基础停止必须完成，不得声称"电脑端已恢复"。
	const noQueueRun = await client.call("send", { operationId: "foreign-run-1", text: "stream:foreign-a" });
	assert.equal(noQueueRun.ok, true, JSON.stringify(noQueueRun));
	await until(async () => (await client.snapshot()).busy, "foreign run busy");
	await tmux("send-keys", "-t", "cli", "-l", "--", "foreign_draft_keep");
	await until(() => observe().editorText === "foreign_draft_keep", "desktop draft typed into the foreign editor");
	const stopNoQueue = await client.call("abort", { operationId: "foreign-stop-1", restoreQueued: true });
	assert.equal(stopNoQueue.ok, true, JSON.stringify(stopNoQueue));
	assert.equal(stopNoQueue.status, "settled", "无队列时停止必须完成");
	assert.ok(stopNoQueue.queuedText == null, "没取到队列就不能带出文字");
	assert.equal(stopNoQueue.queuedRestoredToDesktop, undefined, "没有排队稿时不标注电脑端恢复");
	assert.equal(stopNoQueue.queuedDisposition, undefined, "没有排队稿时不编造去向");
	const afterNoQueue = await client.snapshot();
	assert.equal(afterNoQueue.busy, false);
	assert.equal(afterNoQueue.pending, false);
	assert.equal(observe().editorText, "foreign_draft_keep", "别家编辑器里的原稿不能被改写");
	trace("foreign-editor-stop-without-queue");

	// ② 有 steer/follow-up 的停止：队列按 Pi 原生语义交回该编辑器，原稿保留，不重发。
	const queuedRun = await client.call("send", { operationId: "foreign-run-2", text: "stream:foreign-b" });
	assert.equal(queuedRun.ok, true, JSON.stringify(queuedRun));
	await until(async () => (await client.snapshot()).busy, "foreign run 2 busy");
	assert.equal(
		(await client.call("send", { operationId: "foreign-steer", text: "foreign_queued_steer", deliverAs: "steer" })).ok,
		true,
	);
	assert.equal(
		(
			await client.call("send", {
				operationId: "foreign-follow",
				text: "foreign_queued_followup",
				deliverAs: "followUp",
			})
		).ok,
		true,
	);
	await until(async () => (await client.snapshot()).pending, "foreign queue populated");
	await tmux("send-keys", "-t", "cli", "C-u");
	await tmux("send-keys", "-t", "cli", "-l", "--", "foreign_draft_keep");
	await until(() => observe().editorText === "foreign_draft_keep", "foreign editor draft before stop");
	const stopQueued = await client.call("abort", { operationId: "foreign-stop-2", restoreQueued: true });
	assert.equal(stopQueued.ok, true, JSON.stringify(stopQueued));
	assert.equal(stopQueued.status, "settled", "有队列且别家持有输入框时停止仍必须完成");
	assert.equal(
		stopQueued.queuedText,
		"foreign_queued_steer\n\nforeign_queued_followup",
		"手机必须获得本次原生中止实际取回的队列，不能包含电脑原稿",
	);
	assert.equal(stopQueued.queuedDisposition, "captured", "按实际回读取得队列，不能只回电脑归属");
	assert.equal(stopQueued.queuedRestoredToDesktop, true);
	const restored = await until(() => {
		const text = observe().editorText;
		return text.includes("foreign_queued_steer") && text.includes("foreign_queued_followup") ? text : null;
	}, "native abort returns the queue to the foreign editor");
	assert.ok(restored.includes("foreign_draft_keep"), "别家编辑器里的原稿必须保留");
	assert.ok(
		restored.indexOf("foreign_queued_steer") < restored.indexOf("foreign_queued_followup"),
		"取回顺序应为 steering 再 follow-up",
	);
	assert.ok(
		restored.indexOf("foreign_queued_followup") < restored.lastIndexOf("foreign_draft_keep"),
		"队列文字拼在原稿之前（Pi 原生 Esc 语义）",
	);
	await sleep(300);
	assert.equal(
		rows().filter((row) => row.value.modelRequest && /foreign_queued_(steer|followup)/.test(row.value.text)).length,
		0,
		"取回的排队稿不能被自动重发",
	);
	const afterQueued = await client.snapshot();
	assert.equal(afterQueued.busy, false);
	assert.equal(afterQueued.pending, false);
	trace("foreign-editor-stop-returns-queue-keeps-draft", { restored });
	const preserved = observe().editorText;
	const keptNav = await client.call("switch-branch", { operationId: "foreign-tree-kept", entryId: target.entry.id });
	assert.equal(keptNav.ok, true, JSON.stringify(keptNav));
	assert.equal(keptNav.editorText, seedText);
	await sleep(150);
	assert.equal(observe().editorText, preserved, "native navigation must retain existing desktop draft");
	assert.equal((await client.snapshot()).editor, "unavailable");
	trace("foreign-editor-navigation-keeps-existing-draft");
}

async function main() {
	try {
		for (const dir of ["agent", "project", "sessions", "gates", "home"])
			mkdirSync(`${ROOT}/${dir}`, { recursive: true });
		writeFileSync(
			`${ROOT}/agent/settings.json`,
			`${JSON.stringify({
				defaultProvider: "fixture",
				defaultModel: "offline",
				enabledModels: ["fixture/extra"],
				compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 },
				retry: { enabled: false },
				packages: [],
				lastChangelogVersion: "1.3.0",
			})}\n`,
		);

		if (process.env.E2E_INPUT === "1") {
			mkdirSync(`${ROOT}/project/skills/mobile-review`, { recursive: true });
			writeFileSync(
				`${ROOT}/project/skills/mobile-review/SKILL.md`,
				"---\nname: mobile-review\ndescription: Synthetic review skill\n---\nNATIVE_SKILL_BODY\n",
			);
			writeFileSync(
				`${ROOT}/project/mobile-prompt.md`,
				"---\ndescription: Synthetic prompt\n---\nNATIVE_PROMPT $1 $ARGUMENTS",
			);
		}
		await tmux(
			"new-session",
			"-d",
			"-s",
			"cli",
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			`${ROOT}/project`,
			"-e",
			"E2E_ROOT=/work/state",
			"-e",
			"E2E_OBSERVE_FILE=/work/state/observe.json",
			"/runtime/bin/node",
			CLI,
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			...(process.env.E2E_INPUT === "1"
				? [
						"--skill",
						`${ROOT}/project/skills/mobile-review/SKILL.md`,
						"--prompt-template",
						`${ROOT}/project/mobile-prompt.md`,
					]
				: []),
			"--no-context-files",
			"--no-themes",
			"--no-mcp",
			"--no-builtin-tools",
			"--tui-mode",
			"regular",
			"--session-dir",
			`${ROOT}/sessions`,
			"-e",
			"/work/src/fixture.ts",
			"-e",
			"/work/src/observer.ts",
			...(process.env.E2E_FOREIGN === "1" ? ["-e", "/work/src/foreign-editor.ts"] : []),
			"-e",
			"/work/src/bridge-extension/index.ts",
			"--models",
			"fixture/offline,fixture/reasoning",
			"--model",
			"fixture/offline",
		);
		await tmux("set-option", "-t", "cli", "history-limit", "10000");
		const pane = (await tmux("list-panes", "-t", "cli", "-F", "#{pane_pid}")).stdout.trim();
		const panePid = Number(pane);

		let client = await connect();
		const first = await client.snapshot();
		assert.equal(first.pid, panePid, "bridge must run inside the original CLI process");
		assert.ok(first.sessionId.length > 0, "snapshot must carry the native sessionId");
		assert.equal(first.schema, 1);

		if (process.env.E2E_FOREIGN === "1") {
			await foreignEditorCases(client, panePid);
			results.passed = true;
			results.cleanup = { panePid, clients: clients.length };
			writeFileSync("/work/results.json", `${JSON.stringify(results, null, 2)}\n`);
			return;
		}

		if (process.env.E2E_INPUT === "1") {
			const resources = await client.call("input-resources");
			assert.equal(resources.ok, true, JSON.stringify(resources));
			assert.equal(resources.skillCommandsEnabled, true);
			assert.ok(resources.commands.some((c) => c.name === "skill:mobile-review" && c.source === "skill"));
			assert.ok(resources.commands.some((c) => c.name === "mobile-prompt" && c.source === "prompt"));
			assert.ok(resources.commands.every((c) => c.source !== "extension" && !c.path && !c.origin));
			trace("native-input-live-resources");
			for (const [operationId, text, body] of [
				["input-prompt", "/mobile-prompt hello", "NATIVE_PROMPT hello hello"],
				["input-prompt-tab", "/mobile-prompt\thello-tab", "NATIVE_PROMPT hello-tab hello-tab"],
				["input-prompt-wide", "/mobile-prompt　hello-wide", "NATIVE_PROMPT hello-wide hello-wide"],
				["input-skill", "/skill:mobile-review review-args", "NATIVE_SKILL_BODY"],
			]) {
				const reply = await client.call("send", { operationId, text });
				assert.equal(reply.ok, true, JSON.stringify(reply));
				await until(
					async () =>
						rows().some((r) => r.value.modelRequest && r.value.text.includes(body)) && !(await client.snapshot()).busy,
					`native expand ${operationId}`,
				);
				const modelInput = rows().find((r) => r.value.modelRequest && r.value.text.includes(body)).value.text;
				assert.ok(!modelInput.startsWith(text));
				if (operationId === "input-skill") assert.ok(modelInput.includes("review-args"));
				trace(`native-${operationId}-expands-in-original-cli`);
			}
			const before = rows().filter((r) => r.value.modelRequest).length;
			const denied = await client.call("send", { operationId: "input-extension", text: "/fixture-empty-custom" });
			assert.equal(denied.ok, false);
			assert.equal(denied.code, "unsupported");
			assert.equal(rows().filter((r) => r.value.modelRequest).length, before);
			trace("native-input-extension-command-rejected");
		}

		// 模型控制必须读这个 CLI 的 --models，不能读全局 enabledModels。
		const catalog = await client.call("models");
		assert.equal(catalog.ok, true);
		assert.deepEqual(
			catalog.groups.map((group) => [group.provider, group.models.map((model) => model.id)]),
			[["fixture", ["offline", "reasoning"]]],
		);
		const reasoning = catalog.groups[0].models.find((model) => model.id === "reasoning");
		assert.deepEqual(reasoning.thinkingLevels, ["minimal", "low", "medium", "high", "xhigh"]);
		trace("native-cli-model-scope", { models: catalog.groups[0].models.map((model) => model.id) });
		const chosen = await client.call("set-model", {
			operationId: "native-model-1",
			provider: "fixture",
			modelId: "reasoning",
			thinkingLevel: "high",
		});
		assert.equal(chosen.ok, true);
		assert.equal(chosen.thinkingLevel, "high");
		const chosenState = await client.snapshot();
		assert.equal(chosenState.model.modelId, "reasoning");
		assert.equal(chosenState.thinkingLevel, "high");
		assert.equal(chosenState.pid, panePid);
		assert.equal(chosenState.sessionId, first.sessionId);
		assert.equal(
			(
				await client.call("set-model", {
					operationId: "native-model-1",
					provider: "fixture",
					modelId: "reasoning",
					thinkingLevel: "high",
				})
			).duplicate,
			true,
		);
		await input("cli", "native_model_probe");
		await until(
			async () =>
				rows().some((row) => row.value.modelRequest && row.value.text === "native_model_probe") &&
				!(await client.snapshot()).busy,
			"new model actually used by native CLI",
		);
		const actualRequest = rows().find((row) => row.value.modelRequest && row.value.text === "native_model_probe").value;
		assert.equal(actualRequest.model, "reasoning");
		assert.equal(actualRequest.reasoning, "high");
		trace("native-model-write-used", { model: actualRequest.model, thinking: actualRequest.reasoning, pid: panePid });
		// 真正的原生 TUI /model 命令，不用测试后门冒充电脑操作。
		await input("cli", "/model fixture/offline");
		await sleep(150);
		// TUI 补全可能先消费第一次 Enter；仅当命令仍完整留在编辑器时确认。
		if (observe().editorText === "/model fixture/offline") await tmux("send-keys", "-t", "cli", "Enter");
		await until(
			async () => (await client.snapshot()).model?.modelId === "offline",
			"desktop native model command reflected",
		);
		assert.equal((await client.snapshot()).thinkingLevel, "off");
		assert.ok(
			client.frames.some(
				(frame) =>
					frame.kind === "event" && frame.event?.type === "model_select" && frame.event.model?.modelId === "offline",
			),
		);
		trace("desktop-model-command-reflected");
		const refreshed = await client.call("refresh-model", { operationId: "native-refresh-e2e" });
		assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
		assert.deepEqual(refreshed.model, { provider: "fixture", modelId: "offline" });
		assert.equal((await client.snapshot()).pid, panePid);
		trace("native-registry-refresh-uses-public-api-in-same-cli");

		// 1) 生成中途接入：看到尚未落盘的 BEGIN，身份与终端进程一致。
		await input("cli", "stream:demo");
		const attached = await until(async () => {
			const snapshot = await client.snapshot();
			return snapshot.busy && textOf(snapshot.partial).includes("BEGIN:stream:demo") ? snapshot : null;
		}, "partial BEGIN while streaming");
		assert.equal(attached.pid, panePid);
		assert.equal(attached.sessionId, first.sessionId);
		const seqBefore = attached.seq;
		const instanceId = client.desc.instanceId;
		const sessionId = attached.sessionId;
		trace("attach-mid-stream", { pid: panePid, seq: seqBefore });

		// 2) 断线期间继续输出，重连补回未完成前缀；seq 在 epoch 内前进。
		client.close();
		release("demo");
		await until(() => rows().some((row) => row.value.streamChunk?.includes("MIDDLE:stream:demo")), "offline advance");
		client = await connect();
		const reattached = await client.snapshot();
		assert.ok(reattached.seq > seqBefore, "seq must advance across reconnect");
		assert.ok(textOf(reattached.partial).includes("BEGIN:stream:demo"));
		assert.ok(textOf(reattached.partial).includes("MIDDLE:stream:demo"));
		assert.equal(reattached.pid, panePid);
		assert.equal(reattached.sessionId, sessionId);
		assert.equal(reattached.instanceId, instanceId);
		trace("reconnect-keeps-partial", { seq: reattached.seq });

		// 3) 忙时 steer/follow-up 入队；取回顺序为 steering 再 follow-up，电脑草稿不动。
		const follow = await client.call("send", {
			operationId: "op-follow",
			text: "queued_followup",
			deliverAs: "followUp",
		});
		assert.equal(follow.ok, true);
		const duplicateSend = await client.call("send", {
			operationId: "op-follow",
			text: "queued_followup",
			deliverAs: "followUp",
		});
		assert.equal(duplicateSend.duplicate, true);
		const steer = await client.call("send", { operationId: "op-steer", text: "queued_steer", deliverAs: "steer" });
		assert.equal(steer.ok, true);
		await until(async () => (await client.snapshot()).pending, "native queue populated");
		await tmux("send-keys", "-t", "cli", "-l", "--", "desktop_draft_unsubmitted");
		await until(() => observe().editorText === "desktop_draft_unsubmitted", "desktop draft visible");
		const dequeued = await client.call("dequeue", { operationId: "op-dequeue" });
		assert.equal(dequeued.ok, true, JSON.stringify(dequeued));
		assert.equal(dequeued.queuedText, "queued_steer\n\nqueued_followup", "native queue order steering then follow-up");
		const afterDequeue = await client.snapshot();
		assert.equal(afterDequeue.pending, false, "native queue must actually clear");
		assert.equal(afterDequeue.busy, true, "dequeue must not abort the native run");
		assert.equal(textOf(afterDequeue.partial).includes("MIDDLE:stream:demo"), true);
		assert.equal(observe().editorText, "desktop_draft_unsubmitted", "desktop draft must stay untouched");
		const emptyDequeue = await client.call("dequeue", { operationId: "op-dequeue-2" });
		assert.equal(emptyDequeue.queuedText, "");
		trace("dequeue-keeps-desktop-draft", { queuedText: dequeued.queuedText });

		// 4) 停止：先取回（此处已空）再 abort，等真实 idle；abort ACK 不冒充完成。
		const stopped = await client.call("abort", { operationId: "op-stop", restoreQueued: true });
		assert.equal(stopped.ok, true, JSON.stringify(stopped));
		assert.equal(stopped.status, "settled");
		assert.equal(stopped.busy, false);
		assert.equal(stopped.queuedText, "");
		const idleSnapshot = await client.snapshot();
		assert.equal(idleSnapshot.busy, false);
		assert.equal(observe().editorText, "desktop_draft_unsubmitted");
		const repeatedStop = await client.call("abort", { operationId: "op-stop", restoreQueued: true });
		assert.equal(repeatedStop.duplicate, true, "same operationId must not abort twice");
		trace("stop-settles-and-keeps-draft", { status: stopped.status });

		// 5) 工具进行中的实时状态与取消。
		await tmux("send-keys", "-t", "cli", "C-u");
		await until(() => observe().editorText === "", "editor cleared");
		await input("cli", "tool:job");
		const toolActive = await until(async () => {
			const snapshot = await client.snapshot();
			return snapshot.tools.length === 1 && snapshot.busy ? snapshot : null;
		}, "tool execution visible mid-run");
		assert.equal(toolActive.partial, null, "assistant message already ended before tool execution");
		const stopTool = await client.call("abort", { operationId: "op-stop-tool", restoreQueued: true });
		assert.equal(stopTool.status, "settled");
		const afterToolStop = await client.snapshot();
		assert.equal(afterToolStop.busy, false);
		assert.equal(afterToolStop.tools.length, 0);
		await until(() => rows().some((row) => row.value.tool === "aborted-or-failed"), "tool cancelled");
		trace("stop-active-tool", { toolCallId: toolActive.tools[0]?.toolCallId });

		// 6) 回到原 CLI 输入下一条消息：同 PID/sessionId，一个会话文件，队列文字未执行。
		await input("cli", "hello_desktop");
		const settled = await until(async () => {
			const snapshot = await client.snapshot();
			return !snapshot.busy && rows().some((row) => row.value.modelRequest && row.value.text === "hello_desktop")
				? snapshot
				: null;
		}, "desktop message completes");
		assert.equal(settled.pid, panePid);
		assert.equal(settled.sessionId, sessionId);
		assert.equal(
			rows().filter((row) => row.value.modelRequest && ["queued_steer", "queued_followup"].includes(row.value.text))
				.length,
			0,
			"dequeued messages must not execute",
		);
		const sessionFiles = readdirSync(`${ROOT}/sessions`).filter((name) => name.endsWith(".jsonl"));
		assert.equal(sessionFiles.length, 1, "attach and reconnect must not create sessions");
		trace("desktop-continues-same-runtime", { sessionFiles: sessionFiles.length });

		// 7) /reload：新 epoch、同 PID/sessionId，旧 epoch 请求被拒绝，编辑器适配重装后可用。
		await tmux("send-keys", "-t", "cli", "C-u");
		await until(() => observe().editorText === "", "editor cleared before reload");
		const epochBefore = client.desc.epoch;
		const identityBefore = { instanceId: client.desc.instanceId, epoch: client.desc.epoch, sessionId };
		await input("cli", "/reload");
		const reloaded = await until(() => {
			const desc = descriptor();
			return desc && desc.sessionId === sessionId && desc.epoch !== epochBefore ? desc : null;
		}, "reload rewrites registry with new epoch");
		assert.equal(reloaded.pid, panePid);
		assert.equal(reloaded.sessionId, sessionId);
		assert.notEqual(reloaded.epoch, epochBefore);
		client = await connect();
		const reloadSnapshot = await client.snapshot();
		assert.equal(reloadSnapshot.epoch, reloaded.epoch);
		assert.equal(reloadSnapshot.pid, panePid);
		const stale = await client.raw("snapshot", identityBefore);
		assert.equal(stale.ok, false, "old epoch must be rejected after reload");
		assert.equal(stale.code, "stale-runtime");
		await tmux("send-keys", "-t", "cli", "-l", "--", "draft_after_reload");
		await until(() => observe().editorText === "draft_after_reload", "bridge editor reinstalled after reload");
		await tmux("send-keys", "-t", "cli", "Enter");
		await until(
			() => rows().some((row) => row.value.modelRequest && row.value.text === "draft_after_reload"),
			"draft submits after reload",
		);
		trace("reload-new-epoch", { epochBefore, epochAfter: reloaded.epoch });

		// 8) /new：新 sessionId、同 PID，旧 epoch/session 请求被拒绝。
		const oldSessionId = sessionId;
		await input("cli", "/new");
		const created = await until(() => {
			const desc = descriptor();
			return desc && desc.pid === panePid && desc.sessionId !== oldSessionId ? desc : null;
		}, "new session registered");
		assert.notEqual(created.epoch, reloaded.epoch);
		client = await connect();
		const newSnapshot = await client.snapshot();
		assert.equal(newSnapshot.sessionId, created.sessionId);
		const staleNew = await client.raw("snapshot", { instanceId, epoch: reloaded.epoch, sessionId: oldSessionId });
		assert.equal(staleNew.ok, false, "old sessionId/epoch must be rejected after /new");
		assert.equal(staleNew.code, "stale-runtime");
		await input("cli", "after_new");
		await until(
			() => rows().some((row) => row.value.modelRequest && row.value.text === "after_new") && !observe().busy,
			"new session runs",
		);
		const afterNewFiles = readdirSync(`${ROOT}/sessions`).filter((name) => name.endsWith(".jsonl"));
		assert.equal(afterNewFiles.length, 2, "/new creates exactly one additional session file");
		trace("new-session-epoch", { oldSessionId, newSessionId: created.sessionId, sessionFiles: afterNewFiles.length });

		// 9) 公开扩展回调早于落盘：终态必须在后续公开边界补上精确条目ID。
		const checkText = "entry_identity_check";
		await input("cli", checkText);
		await until(async () => {
			const ended = client.frames.some(
				(frame) =>
					frame.kind === "event" &&
					frame.event?.type === "message_end" &&
					frame.event.message?.role === "assistant" &&
					textOf(frame.event.message).includes(checkText),
			);
			return ended && !(await client.snapshot()).busy;
		}, "identity check settled");
		const history = await client.call("history", { limit: 400 });
		assert.equal(history.ok, true);
		const entries = history.entries.filter(
			(entry) => entry.type === "message" && textOf(entry.message).includes(checkText),
		);
		assert.equal(entries.length, 2, "one native user and one assistant entry");
		for (const entry of entries) {
			const terminal = client.frames.filter(
				(frame) =>
					frame.kind === "event" &&
					frame.event?.type === "message_end" &&
					frame.event.message?.role === entry.message.role &&
					textOf(frame.event.message).includes(checkText),
			);
			assert.equal(terminal.length, 1, "terminal remains exactly once");
			assert.equal(terminal[0].entryId, entry.id, "live terminal and native history must carry the same real entryId");
		}
		trace("terminal-entry-identity", { entryIds: entries.map((entry) => entry.id) });

		if (process.env.E2E_TREE === "1") {
			const read = await client.call("tree");
			assert.equal(read.ok, true, JSON.stringify(read));
			const user = read.tree.find((n) => n.entry.type === "message" && n.entry.message?.role === "user").entry;
			const assistant = read.tree.find(
				(n) => n.entry.type === "message" && n.entry.message?.role === "assistant",
			).entry;
			const copied = await client.call("entry-copy", { entryId: user.id });
			assert.equal(copied.ok, true, JSON.stringify(copied));
			assert.equal(copied.text, textOf(user.message));
			assert.equal(copied.bytes, Buffer.byteLength(copied.text));
			trace("native-tree-live-copy", { nodes: read.tree.length });
			const labeled = await client.call("label-put", {
				operationId: "tree-label",
				entryId: user.id,
				label: "mobile bookmark",
			});
			assert.equal(labeled.ok, true, JSON.stringify(labeled));
			const replay = await client.call("label-put", {
				operationId: "tree-label",
				entryId: user.id,
				label: "mobile bookmark",
			});
			assert.equal(replay.duplicate, true);
			const labelTree = await client.call("tree");
			assert.equal(labelTree.tree.find((n) => n.entry.id === user.id).label, "mobile bookmark");
			assert.equal(labelTree.tree.filter((n) => n.entry.type === "label" && n.entry.targetId === user.id).length, 1);
			const named = await client.call("name", { operationId: "tree-name", name: "Native Tree acceptance" });
			assert.equal(named.ok, true, JSON.stringify(named));
			const namedTree = await client.call("tree");
			assert.ok(
				namedTree.tree.some((n) => n.entry.type === "session_info" && n.entry.name === "Native Tree acceptance"),
			);
			trace("native-tree-label-name-persist");
			const requestsBefore = rows().filter((row) => row.value.modelRequest).length;
			await tmux("send-keys", "-t", "cli", "-l", "--", "desktop_tree_draft");
			await until(() => observe().editorText === "desktop_tree_draft", "tree desktop draft");
			const moved = await client.call("switch-branch", { operationId: "tree-nav-user", entryId: user.id });
			assert.equal(moved.ok, true, JSON.stringify(moved));
			assert.equal(moved.editorText, copied.text);
			assert.equal(moved.leafId, user.parentId);
			await until(() => observe().editorText === "desktop_tree_draft", "navigation keeps desktop draft");
			assert.equal(
				(await client.call("switch-branch", { operationId: "tree-nav-user", entryId: user.id })).duplicate,
				true,
			);
			trace("native-tree-user-navigation-keeps-desktop");
			await tmux("send-keys", "-t", "cli", "C-u");
			await until(() => observe().editorText === "", "tree desktop empty");
			const toAssistant = await client.call("switch-branch", {
				operationId: "tree-nav-assistant",
				entryId: assistant.id,
			});
			assert.equal(toAssistant.ok, true, JSON.stringify(toAssistant));
			assert.equal(toAssistant.editorText, undefined);
			const emptyMoved = await client.call("switch-branch", { operationId: "tree-nav-empty", entryId: user.id });
			assert.equal(emptyMoved.ok, true, JSON.stringify(emptyMoved));
			assert.equal(emptyMoved.editorText, copied.text);
			await sleep(250);
			assert.equal(observe().editorText, "");
			assert.equal(
				rows().filter((row) => row.value.modelRequest).length,
				requestsBefore,
				"internal command must not trigger a model call",
			);
			trace("native-tree-navigation-no-desktop-fill-or-model-call");
			await input("cli", "/fixture-empty-custom");
			const empty = await until(async () => {
				const value = await client.call("tree");
				return value.tree.find((n) => n.entry.type === "custom_message" && n.entry.customType === "fixture-empty")
					?.entry;
			}, "native empty custom entry");
			await tmux("send-keys", "-t", "cli", "-l", "--", "empty_entry_desktop_draft");
			await until(() => observe().editorText === "empty_entry_desktop_draft", "empty custom draft setup");
			const toEmpty = await client.call("switch-branch", { operationId: "tree-nav-empty-custom", entryId: empty.id });
			assert.equal(toEmpty.ok, true, JSON.stringify(toEmpty));
			assert.equal(toEmpty.editorText, "");
			await sleep(200);
			assert.equal(observe().editorText, "empty_entry_desktop_draft");
			await tmux("send-keys", "-t", "cli", "C-u");
			await until(() => observe().editorText === "", "empty custom draft cleanup");
			trace("native-empty-custom-does-not-clear-desktop-draft");
			// Restore a complete branch before the following compaction checks.
			const restore = await client.call("switch-branch", {
				operationId: "tree-nav-restore",
				entryId: entries.at(-1).id,
			});
			assert.equal(restore.ok, true, JSON.stringify(restore));
		}
		if (process.env.E2E_WORKSPACE === "1") {
			const targetCwd = `${ROOT}/workspace-target`;
			mkdirSync(targetCwd);
			const sourceTree = await client.call("tree");
			const node = sourceTree.tree.find((n) => n.entry.type === "message" && n.entry.message?.role === "assistant");
			assert.ok(node);
			const nav = await client.call("switch-branch", { operationId: "workspace-source-leaf", entryId: node.entry.id });
			assert.equal(nav.ok, true, JSON.stringify(nav));
			await tmux("send-keys", "-t", "cli", "-l", "--", "desktop_workspace_draft");
			await until(() => observe().editorText === "desktop_workspace_draft", "workspace draft setup");
			const source = await client.snapshot();
			const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
			const before = digest(source.sessionFile);
			const operationId = randomUUID();
			const fork = await client.call("worktree-fork", {
				operationId,
				targetPath: targetCwd,
				sessionDir: `${ROOT}/sessions`,
			});
			assert.equal(fork.ok, true, JSON.stringify(fork));
			assert.equal(fork.targetSessionId, operationId);
			const copy = await client.call("worktree-fork", {
				operationId,
				targetPath: targetCwd,
				sessionDir: `${ROOT}/sessions`,
			});
			assert.equal(copy.targetSessionFile, fork.targetSessionFile);
			assert.equal(copy.duplicate, true);
			await sleep(100);
			assert.equal(observe().editorText, "desktop_workspace_draft");
			assert.equal(digest(source.sessionFile), before);
			assert.equal((await client.snapshot()).sessionId, source.sessionId);
			trace("native-workspace-fork-keeps-source-file-runtime-and-editor");
			const launch = async (name, args) => {
				await tmux(
					"new-session",
					"-d",
					"-s",
					name,
					"-c",
					targetCwd,
					"-e",
					`E2E_OBSERVE_FILE=${ROOT}/${name}-observe.json`,
					"/runtime/bin/node",
					CLI,
					"--offline",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-themes",
					"--no-mcp",
					"--no-builtin-tools",
					"--tui-mode",
					"regular",
					"-e",
					"/work/src/fixture.ts",
					"-e",
					"/work/src/observer.ts",
					"-e",
					"/work/src/bridge-extension/index.ts",
					...args,
				);
			};
			const find = async (id) =>
				until(() => {
					for (const name of readdirSync(`${BRIDGE}/registry`)) {
						if (!name.endsWith(".json")) continue;
						try {
							const value = JSON.parse(readFileSync(`${BRIDGE}/registry/${name}`, "utf8"));
							if (value.sessionId === id) return value;
						} catch {}
					}
					return null;
				}, "target native registry");
			await launch("fork-target", ["--session", fork.targetSessionFile]);
			const target = await connect(await find(fork.targetSessionId));
			const targetSnapshot = await target.snapshot();
			assert.equal(targetSnapshot.cwd, targetCwd);
			assert.deepEqual(targetSnapshot.model, source.model);
			assert.equal(targetSnapshot.thinkingLevel, source.thinkingLevel);
			const targetTree = await target.call("tree");
			const sourceNodes = sourceTree.tree.map((n) => n.entry.id);
			assert.ok(sourceNodes.every((id) => targetTree.tree.some((n) => n.entry.id === id)));
			assert.ok(targetTree.tree.find((n) => n.entry.id === node.entry.id).entry.id);
			trace("native-workspace-fork-starts-target-with-full-tree-and-settings");
			const emptyId = randomUUID();
			await launch("empty-target", ["--session-id", emptyId, "--session-dir", `${ROOT}/empty-sessions`]);
			const empty = await connect(await find(emptyId));
			const blank = await empty.snapshot();
			assert.equal(blank.sessionId, emptyId);
			assert.equal(blank.cwd, targetCwd);
			assert.equal(existsSync(blank.sessionFile), false, "native empty session remains lazily persisted");
			const emptyHistory = await empty.call("history", { limit: 10 });
			assert.equal(emptyHistory.entries.filter((e) => e.type === "message").length, 0);
			trace("native-new-session-id-empty-without-handwritten-header");
			target.close();
			empty.close();
			await tmux("kill-session", "-t", "fork-target");
			await tmux("kill-session", "-t", "empty-target");
			await tmux("send-keys", "-t", "cli", "C-u");
			await until(() => observe().editorText === "", "workspace source cleanup");
		}
		if (process.env.E2E_COMPACT === "1") {
			const before = await client.snapshot();
			assert.ok(before.contextUsage.tokens > 0);
			assert.ok(before.contextUsage.percent > 0);
			assert.equal(before.contextUsage.contextWindow, 65536);
			trace("native-context-usage", before.contextUsage);
			writeFileSync(`${ROOT}/compact-control.json`, JSON.stringify({ mode: "hold" }));
			const compact = await client.call("compact", { operationId: "compact-cancel-1" });
			assert.equal(compact.ok, true, JSON.stringify(compact));
			await until(
				() => rows().some((row) => row.value.compactionHook && row.value.mode === "hold"),
				"real native compact hook",
			);
			assert.equal((await client.snapshot()).isCompacting, true);
			assert.equal((await client.call("compact", { operationId: "compact-cancel-1" })).duplicate, true);
			const rejected = await client.call("send", {
				operationId: "compact-reject-send",
				text: "must-keep-phone-draft",
				deliverAs: "followUp",
			});
			assert.equal(rejected.ok, false);
			assert.equal(rejected.code, "compaction-busy");
			trace("native-compact-send-rejected");
			await tmux("send-keys", "-t", "cli", "-l", "--", "desktop_compact_draft");
			await until(() => observe().editorText === "desktop_compact_draft", "desktop compact draft");
			const stop = await client.call("abort", { operationId: "compact-stop", restoreQueued: true });
			assert.equal(stop.ok, true, JSON.stringify(stop));
			assert.equal(stop.status, "settled", JSON.stringify(stop));
			assert.equal((await client.snapshot()).busy, false);
			assert.equal((await client.snapshot()).isCompacting, false);
			const cancelled = await client.call("operation-status", { operationId: "compact-cancel-1" });
			assert.equal(cancelled.status, "failed");
			assert.equal(cancelled.code, "compaction-cancelled");
			assert.equal(observe().editorText, "desktop_compact_draft");
			await tmux("send-keys", "-t", "cli", "C-u");
			trace("native-compact-cancel-keeps-desktop-draft");
			writeFileSync(`${ROOT}/compact-control.json`, JSON.stringify({ mode: "complete" }));
			const started = await client.call("compact", { operationId: "compact-success-1" });
			assert.equal(started.ok, true, JSON.stringify(started));
			await until(
				async () => (await client.call("operation-status", { operationId: "compact-success-1" })).status === "settled",
				"native compaction callback complete",
			);
			const done = await client.snapshot();
			assert.equal(done.pid, panePid);
			assert.equal(done.busy, false);
			assert.equal(done.isCompacting, false);
			assert.equal(done.contextUsage.tokens, null);
			assert.equal(done.contextUsage.percent, null);
			assert.equal(done.contextUsage.contextWindow, 65536);
			const nativeHistory = await client.call("history", { limit: 400 });
			assert.ok(nativeHistory.entries.some((entry) => entry.type === "compaction" && entry.fromHook === true));
			trace("native-compact-extension-success-unknown-usage");
			// 再次直接压缩已压缩的叶子，Pi返回业务失败；回调必须释放活动态。
			await client.call("compact", { operationId: "compact-already" });
			await until(
				async () => (await client.call("operation-status", { operationId: "compact-already" })).status === "failed",
				"native already compacted failure",
			);
			assert.equal((await client.snapshot()).busy, false);
			assert.equal((await client.snapshot()).isCompacting, false);
			trace("native-compact-business-failure-settles");
			await input("cli", "after_compact_usage");
			await until(async () => {
				const state = await client.snapshot();
				return !state.busy && state.contextUsage.tokens !== null;
			}, "usage restored by next real native model response");
			trace("native-context-usage-restored");
			const hookCount = rows().filter((row) => row.value.compactionHook && row.value.mode === "complete").length;
			await input("cli", "/compact");
			await sleep(150);
			if (observe().editorText === "/compact") await tmux("send-keys", "-t", "cli", "Enter");
			await until(async () => {
				const state = await client.snapshot();
				return (
					rows().filter((row) => row.value.compactionHook && row.value.mode === "complete").length > hookCount &&
					!state.busy &&
					!state.isCompacting &&
					state.contextUsage.tokens === null
				);
			}, "native CLI compact lifecycle reflected");
			trace("native-cli-compact-state-reflected");

			assert.ok(
				client.frames.some(
					(frame) => frame.kind === "event" && frame.event?.type === "compaction_end" && frame.isCompacting === false,
				),
			);
		}

		if (process.env.E2E_IMAGE === "1") {
			const images = [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGPQiNryH4QZYAwAScgI1bHC8IcAAAAASUVORK5CYII=",
				},
			];
			const waitImage = async (text) =>
				until(async () => {
					const history = await client.call("history", { limit: 100 }),
						state = await client.snapshot();
					return (
						history.entries.some(
							(e) =>
								e.type === "message" && e.message.role === "assistant" && textOf(e.message).includes(`END:${text}`),
						) &&
						!state.busy &&
						state.partial === null
					);
				}, "image reply settles");
			const sent = await client.call("send", { operationId: "image-success", text: "image:success", images });
			assert.equal(sent.ok, true, JSON.stringify(sent));
			await waitImage("image:success");
			const request = rows().find((r) => r.value.modelRequest && r.value.text === "image:success");
			assert.ok(request, "native model must receive the unchanged image prompt");
			assert.equal(request.value.imageCount, 1);
			assert.equal(
				(await client.call("send", { operationId: "image-success", text: "image:success", images })).duplicate,
				true,
			);
			assert.equal(rows().filter((r) => r.value.modelRequest && r.value.text === "image:success").length, 1);
			trace("native-image-delivered-once-with-submitted-receipt");
			const invalid = await client.call("send", {
				operationId: "image-invalid",
				text: "image:invalid",
				images: [...images, ...images, ...images, ...images, ...images],
			});
			assert.equal(invalid.ok, false);
			assert.equal(invalid.code, "image-invalid");
			assert.equal(rows().filter((r) => r.value.modelRequest && r.value.text === "image:invalid").length, 0);
			trace("native-image-rejection-does-not-start-a-model");
			const failed = await client.call("send", { operationId: "image-fail", text: "image:fail", images });
			assert.equal(failed.ok, true);
			await until(async () => {
				const h = await client.call("history", { limit: 100 }),
					s = await client.snapshot();
				const user = h.entries.findLastIndex(
					(e) => e.type === "message" && e.message.role === "user" && textOf(e.message) === "image:fail",
				);
				return (
					user >= 0 &&
					h.entries
						.slice(user + 1)
						.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error") &&
					!s.busy &&
					s.partial === null
				);
			}, "image model error settles");
			trace("native-image-model-error-clears-working");
			assert.equal(
				(await client.call("send", { operationId: "image-recover", text: "image:recover", images })).ok,
				true,
			);
			await waitImage("image:recover");
			assert.equal(rows().filter((r) => r.value.modelRequest && r.value.text === "image:recover").length, 1);
			trace("native-image-can-send-after-a-model-failure");
			// 写完请求即关闭连接，不等待ACK；同ID重连只能回放，不再执行模型。
			const d = client.desc;
			const dropped = createConnection(d.socketPath);
			await new Promise((resolve, reject) => {
				dropped.once("error", reject);
				dropped.once("data", () => {
					dropped.write(
						JSON.stringify({
							id: randomUUID(),
							op: "send",
							sessionId: d.sessionId,
							instanceId: d.instanceId,
							epoch: d.epoch,
							operationId: "image-dropped",
							text: "image:dropped",
							images,
						}) + "\n",
						() => {
							dropped.destroy();
							resolve();
						},
					);
				});
			});
			await waitImage("image:dropped");
			const replay = await client.call("send", { operationId: "image-dropped", text: "image:dropped", images });
			assert.equal(replay.duplicate, true);
			assert.equal(rows().filter((r) => r.value.modelRequest && r.value.text === "image:dropped").length, 1);
			trace("native-image-lost-ipc-ack-replay-does-not-duplicate");
		}
		results.passed = true;
		results.cleanup = { panePid, clients: clients.length };
		writeFileSync("/work/results.json", `${JSON.stringify(results, null, 2)}\n`);
	} catch (error) {
		results.error = String(error.stack ?? error);
		writeFileSync("/work/results.json", `${JSON.stringify(results, null, 2)}\n`);
		console.error(results.error);
		process.exitCode = 1;
	} finally {
		for (const client of clients) {
			const index = clients.indexOf(client);
			writeFileSync(`/work/peer-${index}.jsonl`, `${client.frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
			client.close();
		}
		try {
			writeFileSync("/work/terminal.txt", (await tmux("capture-pane", "-p", "-S", "-2000", "-t", "cli")).stdout);
		} catch {
			// 终端可能已退出。
		}
		try {
			await tmux("send-keys", "-t", "cli", "C-c");
			await sleep(80);
			await input("cli", "/quit");
		} catch {
			// 已退出。
		}
		await sleep(400);
		try {
			await tmux("kill-server");
		} catch {
			// 已回收。
		}
	}
}

await main();
