// Pi Mobile 桥接扩展：把已经加载扩展的原生 Pi 运行实例公开给本机网关。
//
// 只使用公开 Extension API：会话事件、`pi.sendUserMessage`、`ctx.abort`、
// `ctx.sessionManager` 与公开 `CustomEditor`。不导入 Pi 内部模块，不捕获私有
// AgentSession；`sendUserMessage` 返回 void，所以回执只到“已调用”为止。
//
// 隐私边界：不向网关发送编辑器正文（电脑草稿）、原始错误或路径以外的宿主信息。

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BridgeEditor } from "./editor.ts";
import { ENTRY_COPY_MAX_BYTES, entryCopyText, treeEntry } from "./entries.ts";
import {
	BRIDGE_EXTENSION_VERSION,
	BRIDGE_MAX_FRAME_BYTES,
	BRIDGE_SCHEMA,
	type BridgeDescriptor,
	type BridgeEventFrame,
	type BridgeImage,
	type BridgeModelGroup,
	type BridgeReply,
	type BridgeRequest,
	type BridgeSnapshot,
} from "./protocol.ts";
import {
	buildDescriptor,
	claimSessionOwner,
	ensureBridgeDirs,
	releaseSessionOwner,
	removeDescriptor,
	resolveBridgeRoot,
	writeDescriptor,
} from "./registry.ts";
import { forkNativeWorkspace, NativeWorkspaceError } from "./workspace.ts";

const MAX_OPERATIONS = 256;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGES = 4;
const SETTLE_TIMEOUT_MS = 10_000;

interface Operation {
	digest: string;
	reply: BridgeReply;
}

/** 写操作回执按插入顺序保留最近 MAX_OPERATIONS 条；超限淘汰最旧。
 *  只用于断线重试去重，不承诺跨 epoch 或无限历史。 */
function rememberOperation(operations: Map<string, Operation>, id: string, entry: Operation): void {
	operations.set(id, entry);
	while (operations.size > MAX_OPERATIONS) {
		const oldest = operations.keys().next().value;
		if (oldest === undefined) break;
		operations.delete(oldest);
	}
}

/** 写操作去重指纹：同一 operationId 必须内容一致，否则 operation-id-conflict。 */
function operationDigest(request: BridgeRequest, text: string, images: BridgeImage[]): string {
	if (request.op !== "send" && request.op !== "abort" && request.op !== "dequeue" && request.op !== "compact")
		return "";
	return createHash("sha256")
		.update(
			JSON.stringify({
				op: request.op,
				text,
				images: images.map((image) => createHash("sha256").update(image.data).digest("hex")),
				deliverAs: request.op === "send" ? request.deliverAs : undefined,
				restoreQueued: request.op === "abort" ? request.restoreQueued === true : undefined,
			}),
		)
		.digest("hex");
}

interface Waiter {
	resolve: (settled: boolean) => void;
	timer: NodeJS.Timeout;
}

export default function mobileBridge(pi: ExtensionAPI): void {
	const root = resolveBridgeRoot();
	const instanceId = randomUUID();
	const startedAt = Date.now();
	const peers = new Set<Socket>();
	const operations = new Map<string, Operation>();
	const waiters = new Set<Waiter>();
	const treeWrites = new Map<string, { digest: string; result: Promise<BridgeReply> }>();
	const nativeCommands = new Map<
		string,
		{ run: (context: ExtensionCommandContext) => Promise<void>; cancel: () => void }
	>();
	const commandName = `_mobile_bridge_${instanceId.replaceAll("-", "")}`;
	pi.registerCommand(commandName, {
		description: "Pi Mobile internal session control",
		handler: async (nonce, commandContext) => {
			const command = nativeCommands.get(nonce);
			if (!command) return;
			nativeCommands.delete(nonce);
			await command.run(commandContext);
		},
	});
	const modelWrites = new Map<string, { digest: string; result: Promise<BridgeReply> }>();
	let modelTail: Promise<unknown> = Promise.resolve();
	let modelWriteEpoch: string | undefined;
	let modelWriteCount = 0;

	let ctx: ExtensionContext | undefined;
	let editor: BridgeEditor | undefined;
	type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
	let editorFactory: EditorFactory | undefined;

	/** Pi 公开 API 只暴露“当前工厂”，不能拿到别人的组件实例；同一时刻只能有一个
	 *  custom editor，因此不是我们的工厂时按 unavailable 处理，绝不覆盖或借用。 */
	function ownEditorIsCurrent(): boolean {
		if (!editorFactory) return false;
		try {
			return ctx?.ui.getEditorComponent() === editorFactory;
		} catch {
			return false;
		}
	}

	function editorAvailable(): boolean {
		return ownEditorIsCurrent() && editor?.actionHandlers.has("app.message.dequeue") === true;
	}

	function clearOwnEditor(): void {
		if (!ctx || !ownEditorIsCurrent()) return;
		try {
			ctx.ui.setEditorComponent(undefined);
		} catch {
			// 恢复默认编辑器失败时保留 Pi 原生行为，不再干预。
		}
	}
	let server: Server | undefined;
	let socketPath = "";
	let epoch = "";
	let seq = 0;
	let partial: unknown = null;
	let assistantStreamId = 0;
	let partialStreamId: number | undefined;
	// 扩展 message_end 早于 appendMessage；等待后续公开边界再按引用补身份。
	const pendingEvents: Array<{ value: unknown; message?: unknown; waitsForEntry: boolean; assistantStream?: number }> =
		[];
	const tools = new Map<string, unknown>();
	let running = false;
	let owner = false;
	let compacting = false;
	let navigationPending = false;
	let nativeCompactAborted = false;
	let compactCycle = 0;
	let compactReason: "manual" | "threshold" | "overflow" = "manual";
	let compactWillRetry = false;
	let manualCompact: { epoch: string; sessionId: string; operationId: string; digest: string } | undefined;
	let nativeCompactEnd: NodeJS.Immediate | undefined;

	function contextUsage(): BridgeSnapshot["contextUsage"] {
		try {
			const usage = ctx?.getContextUsage();
			if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
			const tokens = usage.tokens !== null && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
			return {
				tokens,
				contextWindow: usage.contextWindow,
				percent:
					tokens !== null && usage.percent !== null && Number.isFinite(usage.percent) && usage.percent >= 0
						? usage.percent
						: null,
			};
		} catch {
			return null;
		}
	}

	function currentSessionId(): string | null {
		try {
			return ctx?.sessionManager.getSessionId() ?? null;
		} catch {
			return null;
		}
	}

	function identity(): Pick<
		BridgeDescriptor,
		"schema" | "extensionVersion" | "instanceId" | "epoch" | "sessionId" | "pid" | "socketPath" | "cwd"
	> {
		return {
			schema: BRIDGE_SCHEMA,
			extensionVersion: BRIDGE_EXTENSION_VERSION,
			instanceId,
			epoch,
			sessionId: currentSessionId() ?? "",
			pid: process.pid,
			socketPath,
			cwd: ctx?.cwd ?? "",
		};
	}

	function snapshot(): BridgeSnapshot {
		flushPendingEvents();
		const sessionId = currentSessionId() ?? "";
		const active = ctx;
		let model: BridgeSnapshot["model"] = null;
		try {
			const current = active?.model as { provider?: unknown; id?: unknown } | undefined;
			if (current && typeof current.provider === "string" && typeof current.id === "string") {
				model = { provider: current.provider, modelId: current.id };
			}
		} catch {
			model = null;
		}
		let thinkingLevel: string | null = null;
		try {
			if (typeof active?.thinkingLevel === "string") thinkingLevel = active.thinkingLevel;
		} catch {
			thinkingLevel = null;
		}
		return {
			...identity(),
			sessionId,
			sessionFile: active?.sessionManager.getSessionFile() ?? null,
			owner,
			seq,
			busy: compacting || (active ? !active.isIdle() : true),
			isCompacting: compacting,
			contextUsage: contextUsage(),
			pending: active?.hasPendingMessages() ?? false,
			controlPending: navigationPending || modelWriteCount > 0,
			leafId: active?.sessionManager.getLeafId() ?? null,
			model,
			thinkingLevel,
			editor: editorAvailable() ? "bridge" : "unavailable",
			partial,
			tools: [...tools.values()],
		};
	}

	function sendFrame(socket: Socket, frame: unknown): void {
		if (socket.destroyed) return;
		const payload = JSON.stringify(frame);
		if (Buffer.byteLength(payload, "utf8") > BRIDGE_MAX_FRAME_BYTES) {
			// 大快照/历史不能把网关读缓冲拖爆；用同 id 的小错误帧替代，
			// 让网关按 frame-too-large 处理，而不是看到 socket 断开就报离线。
			const id = (frame as { id?: unknown }).id;
			const fallback = {
				kind: "reply",
				id: typeof id === "string" ? id : "",
				ok: false,
				code: "frame-too-large",
			};
			socket.write(`${JSON.stringify(fallback)}\n`);
			return;
		}
		socket.write(`${payload}\n`);
	}

	function emit(event: unknown, entryId?: string): void {
		if (!running) return;
		seq += 1;
		const frame: BridgeEventFrame = { kind: "event", ...identity(), sessionId: currentSessionId() ?? "", seq, event };
		if (
			["agent_start", "agent_settled", "compaction_start", "compaction_end", "model_select"].includes(
				(event as { type?: string }).type ?? "",
			)
		) {
			frame.isCompacting = compacting;
			frame.isStreaming = !compacting && (ctx ? !ctx.isIdle() : false);
			frame.contextUsage = contextUsage();
		}
		if (entryId !== undefined) frame.entryId = entryId;
		for (const peer of peers) sendFrame(peer, frame);
	}

	function reply(socket: Socket, request: BridgeRequest, payload: Record<string, unknown> | BridgeReply): void {
		sendFrame(socket, {
			kind: "reply",
			id: request.id,
			ok: true,
			...identity(),
			...(payload as Record<string, unknown>),
		});
	}

	function reject(socket: Socket, request: BridgeRequest | { id?: unknown }, code: string): void {
		sendFrame(socket, {
			kind: "reply",
			id: typeof request.id === "string" ? request.id : "",
			ok: false,
			code,
			...identity(),
		});
	}

	/** 与网关同款身份匹配：只认 message 对象引用，不做内容指纹。 */
	function entryIdFor(message: unknown): string | undefined {
		const active = ctx;
		if (!active || message === null || typeof message !== "object") return undefined;
		try {
			const entries = active.sessionManager.getEntries();
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry?.type === "message" && entry.message === message) return entry.id;
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	function flushPendingEvents(force = false): void {
		while (pendingEvents.length > 0) {
			const next = pendingEvents[0];
			const entryId = next.waitsForEntry ? entryIdFor(next.message) : undefined;
			if (next.waitsForEntry && entryId === undefined && !force) return;
			pendingEvents.shift();
			if (next.assistantStream !== undefined && next.assistantStream === partialStreamId) {
				partial = null;
				partialStreamId = undefined;
			}
			emit(next.value, entryId);
		}
	}

	function settleWaiters(settled: boolean): void {
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(settled);
		}
		waiters.clear();
	}

	function waitForSettle(): Promise<boolean> {
		const active = ctx;
		if (!active || (!compacting && active.isIdle())) return Promise.resolve(true);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				resolve,
				timer: setTimeout(() => {
					waiters.delete(waiter);
					resolve(false);
				}, SETTLE_TIMEOUT_MS),
			};
			waiters.add(waiter);
		});
	}

	function compactEnd(aborted: boolean, failed: boolean, message?: string): void {
		compacting = false;
		emit({
			type: "compaction_end",
			reason: compactReason,
			aborted,
			willRetry: compactWillRetry,
			...(failed && !aborted ? { errorMessage: message ?? "上下文压缩失败，请重试" } : {}),
		});
		if (ctx?.isIdle()) settleWaiters(true);
	}

	function startCompact(request: BridgeRequest & { op: "compact" }, socket: Socket): void {
		if (!owner) {
			reject(socket, request, "session-owned");
			return;
		}
		if (typeof request.operationId !== "string" || !request.operationId || request.operationId.length > 128) {
			reject(socket, request, "invalid-request");
			return;
		}
		const active = ctx;
		if (!active) {
			reject(socket, request, "runtime-offline");
			return;
		}
		const digest = operationDigest(request, "", []);
		if (modelWrites.has(request.operationId)) {
			reject(socket, request, "operation-id-conflict");
			return;
		}
		const previous = operations.get(request.operationId);
		if (previous) {
			if (previous.digest !== digest) {
				reject(socket, request, "operation-id-conflict");
				return;
			}
			sendFrame(socket, { ...previous.reply, id: request.id, duplicate: true });
			return;
		}
		if (compacting) {
			reject(socket, request, "compaction-busy");
			return;
		}
		const operation = { epoch, sessionId: currentSessionId() ?? "", operationId: request.operationId, digest };
		manualCompact = operation;
		compactCycle += 1;
		compactReason = "manual";
		compactWillRetry = false;
		compacting = true;
		nativeCompactAborted = false;
		const current = () =>
			running && manualCompact === operation && epoch === operation.epoch && currentSessionId() === operation.sessionId;
		const finish = (failed: boolean, error?: Error) => {
			if (!current()) return;
			const code = nativeCompactAborted ? "compaction-cancelled" : "compaction-failed";
			const status: BridgeReply = {
				kind: "reply",
				id: request.id,
				ok: true,
				...identity(),
				status: failed ? "failed" : "settled",
				...(failed ? { code } : {}),
			};
			rememberOperation(operations, request.operationId, { digest, reply: status });
			manualCompact = undefined;
			// 只白名单映射两个Pi业务原因，不把原始上游错误/凭据传到手机。
			const message =
				error && ["Nothing to compact (session too small)", "Already compacted"].includes(error.message)
					? error.message
					: undefined;
			compactEnd(nativeCompactAborted, failed, message);
		};
		const submitted: BridgeReply = { kind: "reply", id: request.id, ok: true, ...identity(), status: "submitted" };
		rememberOperation(operations, request.operationId, { digest, reply: submitted });
		emit({ type: "compaction_start", reason: "manual" });
		try {
			active.compact({ onComplete: () => finish(false), onError: (error) => finish(true, error) });
		} catch {
			finish(true);
		}
		// 回调可能同步结束；ACK反映当前真实状态，不重新伪造“压缩中”。
		sendFrame(socket, { ...operations.get(request.operationId)?.reply, id: request.id, snapshot: snapshot() });
	}

	function observe(value: { type?: string; message?: { role?: string } }): void {
		if (!running) return;
		if ((value.type === "message_start" || value.type === "message_update") && value.message?.role === "assistant") {
			if (value.type === "message_start") assistantStreamId += 1;
			partialStreamId = assistantStreamId;
			partial = structuredClone(value.message);
		}
		const payload = value as unknown as { type?: string; toolCallId?: string };
		if ((payload.type === "tool_execution_start" || payload.type === "tool_execution_update") && payload.toolCallId) {
			tools.set(payload.toolCallId, structuredClone(value));
		}
		if (payload.type === "tool_execution_end" && payload.toolCallId) tools.delete(payload.toolCallId);
		if (payload.type === "agent_settled" && !compacting) settleWaiters(true);
		const role = value.message?.role;
		pendingEvents.push({
			value,
			message: value.message,
			assistantStream: value.type === "message_end" && role === "assistant" ? assistantStreamId : undefined,
			waitsForEntry: value.type === "message_end" && (role === "user" || role === "assistant" || role === "toolResult"),
		});
		// 正常只滞留一个尚未落盘的终态。读条目失败时保守省略ID，不能无界积压。
		flushPendingEvents(value.type === "agent_settled" || pendingEvents.length >= 32);
	}

	function validImages(images: unknown): BridgeImage[] | null {
		if (images === undefined) return [];
		if (!Array.isArray(images) || images.length === 0) return images !== undefined && Array.isArray(images) ? [] : null;
		if (images.length > MAX_IMAGES) return null;
		const parsed: BridgeImage[] = [];
		for (const item of images) {
			if (item === null || typeof item !== "object") return null;
			const value = item as Record<string, unknown>;
			if (value.type !== "image" || typeof value.data !== "string" || value.data.length === 0) return null;
			if (typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/")) return null;
			parsed.push({ type: "image", data: value.data, mimeType: value.mimeType });
		}
		return parsed;
	}

	function readHistory(request: BridgeRequest & { op: "history" }): BridgeReply {
		const active = ctx;
		const empty: BridgeReply = {
			kind: "reply",
			id: request.id,
			ok: true,
			...identity(),
			entries: [],
			hasMore: false,
			oldestEntryId: null,
		};
		if (!active) return { ...empty, ok: false, code: "runtime-offline" };
		const limit = Math.min(Math.max(typeof request.limit === "number" ? Math.floor(request.limit) : 100, 1), 400);
		const branch = active.sessionManager.getBranch() as Array<{ id?: unknown }>;
		let end = branch.length;
		if (typeof request.beforeEntryId === "string" && request.beforeEntryId.length > 0) {
			const index = branch.findIndex((entry) => entry.id === request.beforeEntryId);
			if (index < 0) return { ...empty, ok: false, code: "history-cursor-invalid" };
			end = index;
		}
		const start = Math.max(0, end - limit);
		const entries = branch.slice(start, end);
		const oldest = entries[0];
		const snapshotState = snapshot();
		return {
			...empty,
			entries,
			hasMore: start > 0,
			oldestEntryId: typeof oldest?.id === "string" ? oldest.id : null,
			leafId: snapshotState.leafId,
			model: snapshotState.model,
			thinkingLevel: snapshotState.thinkingLevel,
			busy: snapshotState.busy,
			pending: snapshotState.pending,
		};
	}

	/** 只投影公开目录的白名单字段；Model 内的地址、headers 和密钥不出 IPC。 */
	function availableModels(active: ExtensionContext) {
		const available = active.modelRegistry.getAvailable();
		const scoped = active.scopedModels;
		return scoped.length === 0
			? available
			: scoped.flatMap(({ model }) => {
					const match = available.find((item) => item.provider === model.provider && item.id === model.id);
					return match ? [match] : [];
				});
	}

	function modelGroups(active: ExtensionContext): BridgeModelGroup[] {
		const groups = new Map<string, BridgeModelGroup>();
		for (const model of availableModels(active)) {
			let group = groups.get(model.provider);
			if (!group) {
				group = { provider: model.provider, models: [] };
				groups.set(model.provider, group);
			}
			if (group.models.some((item) => item.id === model.id)) continue;
			group.models.push({
				id: model.id,
				name: model.name || model.id,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				input: [...model.input],
				thinkingLevels: [...getSupportedThinkingLevels(model)],
			});
		}
		return [...groups.values()];
	}

	async function setModel(
		request: Extract<BridgeRequest, { op: "set-model" }>,
		socket: Socket,
		refreshRegistry = false,
	): Promise<void> {
		if (!owner) return reject(socket, request, "session-owned");
		if (
			typeof request.operationId !== "string" ||
			!request.operationId ||
			request.operationId.length > 128 ||
			typeof request.provider !== "string" ||
			!request.provider ||
			typeof request.modelId !== "string" ||
			!request.modelId ||
			(request.thinkingLevel !== undefined &&
				!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.thinkingLevel))
		) {
			return reject(socket, request, "invalid-request");
		}
		const digest = createHash("sha256")
			.update(JSON.stringify([request.op, request.provider, request.modelId, request.thinkingLevel, refreshRegistry]))
			.digest("hex");
		const previous = operations.get(request.operationId);
		if (previous) {
			if (previous.digest !== digest) return reject(socket, request, "operation-id-conflict");
			return sendFrame(socket, { ...previous.reply, id: request.id, duplicate: true });
		}
		const pending = modelWrites.get(request.operationId);
		if (pending) {
			if (pending.digest !== digest) return reject(socket, request, "operation-id-conflict");
			return sendFrame(socket, { ...(await pending.result), id: request.id, duplicate: true });
		}
		// 公开 setModel 没有取消句柄；旧代认证尚未返回时不能重置 tail 并发写。
		// 明确拒绝新代重试，避免让它无限排在旧 Promise 后面。
		if (modelWriteCount > 0 && modelWriteEpoch !== epoch) return reject(socket, request, "model-change-pending");
		if (modelWrites.size >= 16) return reject(socket, request, "operation-capacity");
		const active = ctx;
		const target = { ...identity() };
		const current = () =>
			running && ctx === active && epoch === request.epoch && currentSessionId() === request.sessionId;
		modelWriteEpoch = epoch;
		modelWriteCount += 1;
		const result = modelTail.then(async (): Promise<BridgeReply> => {
			const base = { kind: "reply" as const, id: request.id, ...target };
			if (!active || !current()) return { ...base, ok: false, code: "stale-runtime" };
			if (refreshRegistry) {
				const beforeModel = active.model,
					beforeThinking = pi.getThinkingLevel();
				if (!active.isIdle() || active.hasPendingMessages() || compacting || navigationPending || treeWrites.size)
					return { ...base, ok: false, code: "model-refresh-busy" };
				if (
					!beforeModel ||
					beforeModel.provider !== request.provider ||
					beforeModel.id !== request.modelId ||
					beforeThinking !== request.thinkingLevel
				)
					return { ...base, ok: false, code: "model-change-unconfirmed" };
				try {
					await active.modelRegistry.refresh();
				} catch {
					return { ...base, ok: false, code: "model-config-refresh-failed" };
				}
				if (!current()) return { ...base, ok: false, code: "stale-runtime" };
				if (active.modelRegistry.getError()) return { ...base, ok: false, code: "model-config-refresh-failed" };
				if (active.model !== beforeModel || pi.getThinkingLevel() !== beforeThinking)
					return { ...base, ok: false, code: "model-change-unconfirmed" };
				if (!active.isIdle() || active.hasPendingMessages() || compacting || navigationPending || treeWrites.size)
					return { ...base, ok: false, code: "model-refresh-busy" };
			}
			const model = availableModels(active).find(
				(item) => item.provider === request.provider && item.id === request.modelId,
			);
			if (!model) return { ...base, ok: false, code: "model-not-found" };
			try {
				if (!(await pi.setModel(model))) return { ...base, ok: false, code: "model-auth-missing" };
				if (!current()) return { ...base, ok: false, code: "stale-runtime" };
				if (request.thinkingLevel !== undefined)
					pi.setThinkingLevel(request.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				const state = snapshot();
				return {
					...base,
					ok: true,
					model: state.model,
					thinkingLevel: state.thinkingLevel,
					busy: state.busy,
					pending: state.pending,
					snapshot: state,
				};
			} catch {
				return { ...base, ok: false, code: "model-change-unconfirmed" };
			}
		});
		modelWrites.set(request.operationId, { digest, result });
		modelTail = result.catch(() => undefined);
		try {
			const value = await result;
			if (current()) rememberOperation(operations, request.operationId, { digest, reply: value });
			sendFrame(socket, value);
		} finally {
			modelWriteCount -= 1;
			if (modelWrites.get(request.operationId)?.result === result) modelWrites.delete(request.operationId);
		}
	}

	async function treeControl(
		request: Extract<BridgeRequest, { op: "tree" | "entry-copy" | "label-put" | "name" | "switch-branch" }>,
		socket: Socket,
	): Promise<void> {
		const active = ctx;
		if (!active || !running) return reject(socket, request, "runtime-offline");
		if (request.op === "tree") {
			const tree: NonNullable<BridgeReply["tree"]> = [];
			const stack = [...active.sessionManager.getTree()].reverse();
			while (stack.length) {
				const node = stack.pop();
				if (!node) break;
				tree.push({
					entry: treeEntry(node.entry),
					...(node.label !== undefined ? { label: node.label, labelTimestamp: node.labelTimestamp } : {}),
				});
				for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
			}
			return reply(socket, request, { tree, leafId: active.sessionManager.getLeafId() });
		}
		if (
			request.op !== "name" &&
			(typeof request.entryId !== "string" || !request.entryId || request.entryId.length > 256)
		)
			return reject(socket, request, "invalid-request");
		const entry = request.op === "name" ? undefined : active.sessionManager.getEntry(request.entryId);
		if (request.op !== "name" && !entry) return reject(socket, request, "entry-not-found");
		if (request.op === "entry-copy") {
			const text = entryCopyText(entry);
			if (text === undefined) return reject(socket, request, "entry-copy-empty");
			const bytes = Buffer.byteLength(text, "utf8");
			return reply(socket, request, {
				entryId: request.entryId,
				bytes,
				oversized: bytes > ENTRY_COPY_MAX_BYTES,
				...(bytes <= ENTRY_COPY_MAX_BYTES ? { text } : {}),
			});
		}
		if (!owner) return reject(socket, request, "session-owned");
		if (typeof request.operationId !== "string" || !request.operationId || request.operationId.length > 128)
			return reject(socket, request, "invalid-request");
		if (
			request.op === "name" &&
			(typeof request.name !== "string" || !request.name.trim() || request.name.length > 200)
		)
			return reject(socket, request, "invalid-request");
		if (
			request.op === "label-put" &&
			request.label != null &&
			(typeof request.label !== "string" || request.label.length > 200)
		)
			return reject(socket, request, "invalid-request");
		const digest = createHash("sha256")
			.update(
				JSON.stringify({
					op: request.op,
					entryId: request.op === "name" ? undefined : request.entryId,
					value:
						request.op === "name"
							? request.name
							: request.op === "label-put"
								? (request.label?.trim() ?? "")
								: undefined,
				}),
			)
			.digest("hex");
		const previous = operations.get(request.operationId);
		if (previous) {
			if (previous.digest !== digest) return reject(socket, request, "operation-id-conflict");
			return sendFrame(socket, { ...previous.reply, id: request.id, duplicate: true });
		}
		const pending = treeWrites.get(request.operationId);
		if (pending) {
			if (pending.digest !== digest) return reject(socket, request, "operation-id-conflict");
			return sendFrame(socket, { ...(await pending.result), id: request.id, duplicate: true });
		}
		if (modelWrites.has(request.operationId)) return reject(socket, request, "operation-id-conflict");
		if (
			navigationPending ||
			treeWrites.size ||
			modelWrites.size ||
			compacting ||
			!active.isIdle() ||
			active.hasPendingMessages()
		)
			return reject(socket, request, "busy");
		if (request.op === "switch-branch" && (!ownEditorIsCurrent() || !editor))
			return reject(socket, request, "editor-unavailable");
		const target = { ...identity() };
		const current = () =>
			running && ctx === active && epoch === target.epoch && currentSessionId() === target.sessionId;
		const result = (async (): Promise<BridgeReply> => {
			const base = { kind: "reply" as const, id: request.id, ...target };
			try {
				// 在异步命令启动前先登记在途项，重复请求共用实际结果。
				await Promise.resolve();
				if (!current()) return { ...base, ok: false, code: "stale-runtime" };
				if (request.op === "name") {
					const name = request.name.trim();
					pi.setSessionName(name);
					return { ...base, ok: true, status: "settled", name, snapshot: snapshot() };
				}
				if (request.op === "label-put") {
					const label = request.label?.trim() || undefined;
					pi.setLabel(request.entryId, label);
					return {
						...base,
						ok: true,
						status: "settled",
						entryId: request.entryId,
						label: active.sessionManager.getLabel(request.entryId) ?? null,
						labelEntryId: active.sessionManager.getLeafId(),
						leafId: active.sessionManager.getLeafId(),
						snapshot: snapshot(),
					};
				}
				const m = entry as unknown as {
					message?: { role?: string; content?: unknown };
					type?: string;
					content?: unknown;
				};
				const restores = m.type === "custom_message" || (m.type === "message" && m.message?.role === "user");
				// user/custom 回填沿用 Pi 的纯文本语义。
				const raw = m.type === "custom_message" ? m.content : m.message?.content;
				const editorText = restores
					? typeof raw === "string"
						? raw
						: Array.isArray(raw)
							? raw
									.filter((b) => b?.type === "text")
									.map((b) => b.text)
									.join("")
							: ""
					: undefined;
				const oldLeaf = active.sessionManager.getLeafId();
				return await new Promise<BridgeReply>((resolve) => {
					const nonce = randomUUID();
					const timer = setTimeout(() => {
						nativeCommands.delete(nonce);
						resolve({ ...base, ok: false, code: "navigation-unconfirmed" });
					}, 6000);
					const finish = (value: BridgeReply) => {
						clearTimeout(timer);
						nativeCommands.delete(nonce);
						resolve(value);
					};
					nativeCommands.set(nonce, {
						cancel: () => finish({ ...base, ok: false, code: "stale-runtime" }),
						run: async (commandContext) => {
							if (!current() || commandContext.sessionManager.getSessionId() !== target.sessionId)
								return finish({ ...base, ok: false, code: "stale-runtime" });
							if (compacting || !commandContext.isIdle() || commandContext.hasPendingMessages())
								return finish({ ...base, ok: false, code: "busy" });
							const own = editor;
							if (!ownEditorIsCurrent() || !own) return finish({ ...base, ok: false, code: "editor-unavailable" });
							const before = own.checkpoint();
							try {
								// 公开导航不可取消；超时只结束等待，不放开另一笔修改。
								navigationPending = true;
								let navigated: { cancelled: boolean };
								try {
									navigated = await commandContext.navigateTree(request.entryId, { summarize: false });
								} finally {
									navigationPending = false;
								}
								if (!current()) return finish({ ...base, ok: false, code: "stale-runtime" });
								if (navigated.cancelled) return finish({ ...base, ok: false, code: "navigation-cancelled" });
								if (ownEditorIsCurrent() && editor === own && editorText) own.restoreNavigationFill(before, editorText);
								finish({
									...base,
									ok: true,
									status: "settled",
									entryId: request.entryId,
									alreadyAt: oldLeaf === active.sessionManager.getLeafId(),
									...(editorText !== undefined ? { editorText } : {}),
									leafId: active.sessionManager.getLeafId(),
									snapshot: snapshot(),
								});
							} catch {
								finish({ ...base, ok: false, code: "navigation-failed" });
							}
						},
					});
					try {
						pi.sendUserMessage(`/${commandName} ${nonce}`, { expandPromptTemplates: true });
					} catch {
						finish({ ...base, ok: false, code: "navigation-failed" });
					}
				});
			} catch {
				return { ...base, ok: false, code: "navigation-failed" };
			}
		})();
		treeWrites.set(request.operationId, { digest, result });
		try {
			const value = await result;
			if (current()) rememberOperation(operations, request.operationId, { digest, reply: value });
			sendFrame(socket, value);
		} finally {
			if (treeWrites.get(request.operationId)?.result === result) treeWrites.delete(request.operationId);
		}
	}

	async function handle(request: BridgeRequest, socket: Socket): Promise<void> {
		if (request.instanceId !== instanceId || request.epoch !== epoch || request.sessionId !== currentSessionId()) {
			return reject(socket, request, "stale-runtime");
		}
		if (["tree", "entry-copy", "label-put", "name", "switch-branch"].includes(request.op))
			return treeControl(
				request as Extract<BridgeRequest, { op: "tree" | "entry-copy" | "label-put" | "name" | "switch-branch" }>,
				socket,
			);
		if (
			(treeWrites.size || navigationPending) &&
			request.op !== "operation-status" &&
			request.op !== "snapshot" &&
			request.op !== "history" &&
			request.op !== "models" &&
			request.op !== "input-resources"
		)
			return reject(socket, request, "busy");
		if (request.op === "snapshot") return reply(socket, request, { snapshot: snapshot() });
		if (request.op === "input-resources") {
			const all = pi.getCommands(),
				enabled = pi.getSettings().enableSkillCommands ?? true;
			const extensions = new Set(all.filter((c) => c.source === "extension").map((c) => c.name));
			const skills = new Set(all.filter((c) => c.source === "skill").map((c) => c.name));
			const shadowed: NonNullable<BridgeReply["shadowed"]> = [];
			const commands: NonNullable<BridgeReply["commands"]> = [];
			for (const command of all) {
				if (command.source !== "skill" && command.source !== "prompt") continue;
				if (command.source === "skill" && !enabled) continue;
				const by = extensions.has(command.name)
					? "extension"
					: command.source === "prompt" && skills.has(command.name)
						? "skill"
						: undefined;
				if (by) {
					shadowed.push({ name: command.name, source: command.source, by });
					continue;
				}
				commands.push({
					name: command.name,
					source: command.source,
					...(command.description === undefined ? {} : { description: command.description }),
					...(command.sourceInfo?.scope ? { scope: command.sourceInfo.scope } : {}),
				});
			}
			return reply(socket, request, { commands, shadowed, skillCommandsEnabled: enabled });
		}
		if (request.op === "models") {
			if (!ctx) return reject(socket, request, "runtime-offline");
			return reply(socket, request, { groups: modelGroups(ctx) });
		}
		if (request.op === "worktree-fork") {
			const active = ctx;
			if (!active) return reject(socket, request, "runtime-offline");
			if (!owner) return reject(socket, request, "session-owned");
			if (modelWrites.size || compacting || manualCompact) return reject(socket, request, "worktree-busy");
			try {
				return reply(socket, request, forkNativeWorkspace(pi, active, root, request));
			} catch (error) {
				return reject(socket, request, error instanceof NativeWorkspaceError ? error.code : "worktree-continue-failed");
			}
		}
		if (request.op === "refresh-model") {
			const model = ctx?.model;
			if (!model) return reject(socket, request, "model-not-found");
			return setModel(
				{
					...request,
					op: "set-model",
					provider: model.provider,
					modelId: model.id,
					thinkingLevel: pi.getThinkingLevel(),
				},
				socket,
				true,
			);
		}
		if (request.op === "set-model") return setModel(request, socket);
		if (request.op === "compact") return startCompact(request, socket);
		if (request.op === "history") return reply(socket, request, readHistory(request));
		if (
			(request.op === "send" || request.op === "abort" || request.op === "dequeue") &&
			modelWrites.has(request.operationId)
		) {
			return reject(socket, request, "operation-id-conflict");
		}
		if (request.op === "operation-status") {
			if (
				typeof request.operationId !== "string" ||
				request.operationId.length === 0 ||
				request.operationId.length > 128
			) {
				return reject(socket, request, "invalid-request");
			}
			const previous = operations.get(request.operationId);
			// 淘汰后返回 unknown；不能把“查不到”当成“没执行”。
			return reply(socket, request, {
				status: previous?.reply.status ?? (previous ? (previous.reply.ok ? "submitted" : "failed") : "unknown"),
				...(previous && (!previous.reply.ok || previous.reply.status === "failed") && previous.reply.code
					? { code: previous.reply.code }
					: {}),
			});
		}
		if (
			request.op === "dequeue" &&
			(typeof request.operationId !== "string" || request.operationId.length === 0 || request.operationId.length > 128)
		) {
			return reject(socket, request, "invalid-request");
		}
		if (request.op === "dequeue") {
			if (!owner) return reject(socket, request, "session-owned");
			const digest = operationDigest(request, "", []);
			const previous = operations.get(request.operationId);
			if (previous) {
				if (previous.digest !== digest) return reject(socket, request, "operation-id-conflict");
				return sendFrame(socket, { ...previous.reply, id: request.id, duplicate: true });
			}
			if (!editorAvailable() || !editor) return reject(socket, request, "editor-unavailable");
			const text = editor.takeQueuedText();
			if (text === null) return reject(socket, request, "editor-unavailable");
			const result: BridgeReply = {
				kind: "reply",
				id: request.id,
				ok: true,
				...identity(),
				queuedText: text,
				pending: ctx?.hasPendingMessages() ?? false,
				busy: snapshot().busy,
				snapshot: snapshot(),
			};
			// 取队列是破坏性操作：先落回执，迟到重试直接回放，不能再次取。
			rememberOperation(operations, request.operationId, { digest, reply: result });
			return sendFrame(socket, { ...result, duplicate: false });
		}
		if (request.op !== "send" && request.op !== "abort") return reject(socket, request, "unsupported");
		if (!owner) return reject(socket, request, "session-owned");
		if (
			typeof request.operationId !== "string" ||
			request.operationId.length === 0 ||
			request.operationId.length > 128
		) {
			return reject(socket, request, "invalid-request");
		}

		const images = request.op === "send" ? validImages(request.images) : [];
		if (request.op === "send" && images === null) return reject(socket, request, "image-invalid");
		const text = request.op === "send" ? request.text : "";
		if (request.op === "send") {
			// 公开sendUserMessage不能进入TUI的手动压缩队列；拒绝并让手机保留原稿，不能假报submitted。
			if (compacting) return reject(socket, request, "compaction-busy");
			if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) return reject(socket, request, "invalid-text");
			if (text.trim().length === 0 && (images?.length ?? 0) === 0) return reject(socket, request, "invalid-text");
			if (request.deliverAs !== undefined && request.deliverAs !== "steer" && request.deliverAs !== "followUp") {
				return reject(socket, request, "invalid-delivery");
			}
			if (ctx && (compacting || !ctx.isIdle()) && request.deliverAs === undefined)
				return reject(socket, request, "busy");
		}

		const active = ctx;
		if (!active) return reject(socket, request, "runtime-offline");
		const digest = operationDigest(request, text, images ?? []);
		const previous = operations.get(request.operationId);
		if (previous) {
			if (previous.digest !== digest) return reject(socket, request, "operation-id-conflict");
			return sendFrame(socket, { ...previous.reply, id: request.id, duplicate: true });
		}
		if (request.op === "send") {
			const ahead = { kind: "reply" as const, id: request.id, ok: true, ...identity(), status: "submitted" as const };
			rememberOperation(operations, request.operationId, { digest, reply: ahead });
			// 扩展命令先于模板匹配；仅把当前原生 Skill/Prompt 交给 Pi 展开。
			// enableSkillCommands 只控制候选，不禁止显式 /skill: 调用。
			const name = text.startsWith("/") ? text.slice(1, text.indexOf(" ") < 0 ? undefined : text.indexOf(" ")) : null;
			const commands = name === null ? [] : pi.getCommands();
			if (commands.some((c) => c.name === name && c.source === "extension")) {
				const failure = { kind: "reply" as const, id: request.id, ok: false, code: "unsupported", ...identity() };
				rememberOperation(operations, request.operationId, { digest, reply: failure });
				return sendFrame(socket, failure);
			}
			// Pi 的扩展/Skill 命令按半角空格拆分，Prompt 模板单独支持 Unicode 空白。
			const promptName = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)?.[1];
			const expandPromptTemplates = commands.some(
				(c) => (c.source === "skill" && c.name === name) || (c.source === "prompt" && c.name === promptName),
			);
			try {
				const content =
					images && images.length > 0
						? [...(text.trim().length > 0 ? [{ type: "text" as const, text }] : []), ...images]
						: text;
				pi.sendUserMessage(content, { deliverAs: request.deliverAs, expandPromptTemplates });
				reply(socket, request, { status: "submitted" });
			} catch {
				const failure = { kind: "reply" as const, id: request.id, ok: false, code: "submission-failed", ...identity() };
				rememberOperation(operations, request.operationId, { digest, reply: failure });
				sendFrame(socket, failure);
			}
			return;
		}

		// abort：restoreQueued 时先取回队列再中止，取回文本不回电脑编辑器；
		// 否则沿用 Pi 原生 Esc 语义（abort 会把队列文字还给电脑编辑器）。
		// 先在等待 settle 前落一条 in-flight 回执：断线重试同一 operationId 时
		// 只能回放“处理中”，不能再次执行 abort/取队列。
		const ahead: BridgeReply = {
			kind: "reply",
			id: request.id,
			ok: true,
			...identity(),
			status: "submitted",
			busy: ctx ? !ctx.isIdle() : false,
		};
		rememberOperation(operations, request.operationId, { digest, reply: ahead });
		const hadPending = ctx?.hasPendingMessages() ?? false;
		let queuedText: string | null = null;
		if (request.restoreQueued === true) {
			// 与 dequeue 同口径：其他 custom editor 接管后不能再借用旧 editor 的
			// dequeue 动作；宁可拒绝，也不能取不到队列却仍执行 abort。
			if (!editorAvailable() || !editor) {
				return reject(socket, request, "editor-unavailable");
			}
			queuedText = editor.takeQueuedText();
			if (queuedText === null) return reject(socket, request, "editor-unavailable");
		}
		try {
			if (compacting) nativeCompactAborted = true;
			ctx?.abort();
		} catch {
			// abort 抛错时队列已从编辑器取出；把已取文本随失败回执带出，
			// 客户端仍能恢复草稿，不让文本凭空消失。
			const failure = {
				kind: "reply" as const,
				id: request.id,
				ok: false,
				code: "submission-failed",
				...identity(),
				...(queuedText !== null ? { queuedText } : {}),
			};
			rememberOperation(operations, request.operationId, { digest, reply: failure });
			return sendFrame(socket, failure);
		}
		const settled = await waitForSettle();
		const result: BridgeReply = {
			kind: "reply",
			id: request.id,
			ok: true,
			...identity(),
			status: settled ? "settled" : "timeout",
			busy: snapshot().busy,
			snapshot: snapshot(),
			queuedText,
		};
		if (request.restoreQueued !== true) result.queuedRestoredToDesktop = hadPending;
		rememberOperation(operations, request.operationId, { digest, reply: result });
		sendFrame(socket, { ...result, duplicate: false });
	}

	function onFrame(socket: Socket, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			sendFrame(socket, { kind: "reply", id: "", ok: false, code: "invalid-request" });
			return;
		}
		const request = parsed as BridgeRequest;
		if (request === null || typeof request !== "object" || typeof request.id !== "string" || request.id.length > 128) {
			sendFrame(socket, { kind: "reply", id: "", ok: false, code: "invalid-request" });
			return;
		}
		if (!running || !ctx) {
			reject(socket, request, "runtime-offline");
			return;
		}
		void handle(request, socket).catch(() => reject(socket, request, "submission-failed"));
	}

	async function stop(reason: string): Promise<void> {
		for (const command of nativeCommands.values()) command.cancel();
		nativeCommands.clear();
		treeWrites.clear();
		if (!running) return;
		flushPendingEvents(true);
		pendingEvents.length = 0;
		clearOwnEditor();
		// 先发离线事件再关 running：emit 内部以 running 作为存活判断。
		emit({ type: "runtime-offline", reason });
		running = false;
		if (nativeCompactEnd) clearImmediate(nativeCompactEnd);
		nativeCompactEnd = undefined;
		manualCompact = undefined;
		compacting = false;
		settleWaiters(false);
		for (const peer of peers) peer.destroy();
		peers.clear();
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
			server = undefined;
		}
		const descriptorState = { sessionId: currentSessionId() ?? "", instanceId, owner };
		try {
			if (descriptorState.sessionId) releaseSessionOwner(root, descriptorState.sessionId, instanceId);
		} catch {
			// 清理失败不阻塞 Pi 退出；陈旧锁会在下次启动按 pid 存活判定回收。
		}
		try {
			removeDescriptor(root, descriptorState);
		} catch {
			// 同上。
		}
		try {
			unlinkSync(socketPath);
		} catch {
			// socket 可能已被系统回收。
		}
		ctx = undefined;
		editor = undefined;
		editorFactory = undefined;
	}

	async function start(reason: string): Promise<void> {
		const active = ctx;
		if (!active) return;
		if (active.mode !== "tui") return;
		await stop("restart");
		ctx = active;
		epoch = randomUUID();
		seq = 0;
		assistantStreamId = 0;
		pendingEvents.length = 0;
		partial = null;
		partialStreamId = undefined;
		tools.clear();
		operations.clear();
		modelWrites.clear();
		try {
			const existing = active.ui.getEditorComponent();
			if (existing !== undefined && existing !== editorFactory) {
				// 别的扩展已经装了 custom editor：保留它的组件，桥接只报告
				// editor-unavailable；后装我们也按同一规则识别，不抢回来。
				editor = undefined;
				editorFactory = undefined;
			} else {
				const factory: EditorFactory = (tui, theme, keybindings) => {
					editor = new BridgeEditor(tui, theme, keybindings);
					return editor;
				};
				active.ui.setEditorComponent(factory);
				editorFactory = factory;
			}
		} catch {
			editor = undefined;
			editorFactory = undefined;
		}
		ensureBridgeDirs(root);
		const sessionId = currentSessionId();
		if (!sessionId) return;
		socketPath = join(root, "sockets", `${instanceId}.sock`);
		server = createServer((socket) => {
			peers.add(socket);
			sendFrame(socket, { kind: "hello", snapshot: snapshot() });
			socket.on("error", () => socket.destroy());
			socket.on("close", () => peers.delete(socket));
			let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
				if (buffer.length > BRIDGE_MAX_FRAME_BYTES) {
					// 字节超限与协议解析都拿不到请求 id；回稳定错误后关闭，
					// 由调用方按“请求过大”处理，不伪装成原生进程离线。
					sendFrame(socket, { kind: "reply", id: "", ok: false, code: "frame-too-large" });
					socket.destroy();
					return;
				}
				for (;;) {
					const newline = buffer.indexOf(0x0a);
					if (newline < 0) break;
					const line = buffer.subarray(0, newline);
					buffer = buffer.subarray(newline + 1);
					// 完整一行后再按 UTF-8 解码：中文字符跨 chunk 不会插替代符。
					if (line.length > 0) onFrame(socket, line.toString("utf8"));
				}
			});
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(socketPath, resolve);
			});
			chmodSync(socketPath, 0o600);
		} catch {
			server = undefined;
			editor = undefined;
			clearOwnEditor();
			editorFactory = undefined;
			return;
		}
		owner = claimSessionOwner(root, {
			schema: BRIDGE_SCHEMA,
			instanceId,
			epoch,
			sessionId,
			pid: process.pid,
			socketPath,
			claimedAt: Date.now(),
		});
		writeDescriptor(
			root,
			buildDescriptor({
				instanceId,
				epoch,
				sessionId,
				socketPath,
				sessionFile: active.sessionManager.getSessionFile() ?? null,
				cwd: active.cwd,
				startedAt,
				owner,
				extensionVersion: BRIDGE_EXTENSION_VERSION,
			}),
		);
		running = true;
		emit({ type: "bridge_ready", reason });
	}

	pi.on("session_start", async (value, context) => {
		ctx = context;
		await start(value.reason);
	});
	pi.on("session_shutdown", async (value) => {
		await stop(value.reason);
	});

	pi.on("agent_start", observe);
	pi.on("agent_end", observe);
	pi.on("agent_settled", observe);
	pi.on("turn_end", observe);
	pi.on("message_start", observe);
	pi.on("message_update", observe);
	pi.on("message_end", observe);
	pi.on("tool_execution_start", observe);
	pi.on("tool_execution_update", observe);
	pi.on("tool_execution_end", observe);
	pi.on("session_info_changed", observe);
	pi.on("session_before_compact", (event) => {
		if (!running) return;
		compactCycle += 1;
		compactReason = event.reason;
		compactWillRetry = event.willRetry;
		nativeCompactAborted = false;
		if (!compacting) {
			compacting = true;
			emit({ type: "compaction_start", reason: compactReason });
		}
	});
	// 由手机发起时以compact回调为真正终态；原CLI/自动压缩从公开生命周期取状态。
	// 延到本轮原生hook返回后再发终态，不能在session_compact里提前伪报isIdle。
	const nativeEnd = (failed: boolean, aborted: boolean) => {
		if (!running) return;
		nativeCompactAborted = aborted;
		if (manualCompact) return;
		const generation = epoch;
		const cycle = compactCycle;
		if (nativeCompactEnd) clearImmediate(nativeCompactEnd);
		nativeCompactEnd = setImmediate(() => {
			nativeCompactEnd = undefined;
			if (running && epoch === generation && compactCycle === cycle) compactEnd(aborted, failed);
		});
	};
	pi.on("session_compact", (event) => {
		compactReason = event.reason;
		compactWillRetry = event.willRetry;
		const entry = event.compactionEntry;
		// 只发送用于压缩标记的公开最小字段，不转发扩展details或整段准备上下文。
		emit(
			{ type: "entry_appended", entry: { type: "compaction", id: entry.id, tokensBefore: entry.tokensBefore } },
			entry.id,
		);
		nativeEnd(false, false);
	});
	pi.on("session_compact_failed", (event) => {
		compactReason = event.reason;
		compactWillRetry = event.willRetry;
		nativeEnd(true, event.aborted);
	});
	// 原始 model_select 携带完整 Model（含 headers），不能直接转发给客户端。
	pi.on("model_select", () =>
		emit({ type: "model_select", model: snapshot().model, thinkingLevel: pi.getThinkingLevel() }),
	);
	pi.on("thinking_level_select", () => emit({ type: "thinking_level_select", thinkingLevel: pi.getThinkingLevel() }));
}

/** 供网关一致性测试核对的版本号（不参与运行时逻辑）。 */
export const BRIDGE_VERSION = { schema: BRIDGE_SCHEMA, extensionVersion: BRIDGE_EXTENSION_VERSION };
