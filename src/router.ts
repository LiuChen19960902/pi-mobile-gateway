import { HistoryCursorError, HistoryTurnPageTooLargeError } from "./history-turns.ts";
import { createInputAssist } from "./input-assist.ts";
import { LABEL_MAX_CHARS, normalizeLabelValue, readTreeView } from "./tree-view.ts";
// Business-frame router: one instance per authenticated client connection.
//
// The transport plane (server.ts) hands every post-handshake JSON frame here
// (ping/pong stays in the transport). The router keeps the connection's
// per-session event subscriptions, drives the PiRuntime, and answers with
// `{kind: <type>, ...}` frames or the uniform `{kind: "error", ...}` frame.
//
// `message` auto-subscribes the requesting connection to the target session
// before prompting, so no early streaming event is ever missed.

import { homedir } from "node:os";
import { join } from "node:path";
import { classifyDirectoryError, createDirectory, createWorkspaceAt, listDirectories } from "./host-fs.ts";
import {
	AttachmentInvalidError,
	AttachmentNotFoundError,
	AttachmentTooLargeError,
	EntryCopyEmptyError,
	EntryNotFoundError,
	type ImageAttachment,
	MAXIMUM_MESSAGE_IMAGES,
	ModelChangeError,
	ModelScopeError,
	type PiRuntime,
	type SessionHandle,
	SessionNameError,
	SessionNotFoundError,
	SessionRestartError,
	THINKING_LEVELS,
	validateCwd,
} from "./pi-runtime.ts";
import { PiProviderStore, ProviderConfigError, type ProviderUpsert } from "./pi-store.ts";
import { fetchProviderModels, ProviderStatusStore, testProvider } from "./provider-test.ts";
import { errorFrame } from "./wire.ts";

export interface ClientConnection {
	/** Handle one client frame; never rejects. */
	handleMessage(frame: Record<string, unknown>): Promise<void>;
	/** Detach every subscription (connection closed). */
	close(): void;
}

function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() === "" ? undefined : value;
}

/**
 * Validate a message frame's optional `model` pre-selection
 * (`{provider, modelId, thinkingLevel?}`). Returns null on protocol violation.
 */
function readModelSelection(value: unknown): { provider: string; modelId: string; thinkingLevel?: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider : "";
	const modelId = typeof record.modelId === "string" ? record.modelId : "";
	if (provider === "" || modelId === "") return null;
	let thinkingLevel: string | undefined;
	if (record.thinkingLevel !== undefined) {
		if (
			typeof record.thinkingLevel !== "string" ||
			!THINKING_LEVELS.includes(record.thinkingLevel as (typeof THINKING_LEVELS)[number])
		) {
			return null;
		}
		thinkingLevel = record.thinkingLevel;
	}
	return { provider, modelId, thinkingLevel };
}

/**
 * Validate a message frame's image attachments: each entry must be a pi
 * `ImageContent` (`{type:"image", data, mimeType}`). Returns null on any
 * protocol violation so the caller can answer with a bad-request frame.
 * Count is capped even though the client is stricter, so a hostile frame
 * cannot stream unbounded memory into the prompt.
 */
function readImageAttachments(value: unknown): ImageAttachment[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	if (value.length > MAXIMUM_MESSAGE_IMAGES) return null;
	const images: ImageAttachment[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		const record = item as Record<string, unknown>;
		if (record.type !== "image") return null;
		if (typeof record.data !== "string" || record.data.length === 0) return null;
		if (typeof record.mimeType !== "string" || !record.mimeType.startsWith("image/")) return null;
		// attachmentId（可选，≤128 字符）：随 image 块传给 pi 并落盘，回显/历史
		// 全链路靠它命中手机本地附件缓存渲染真图（实测 pi 与 provider 均透传
		// 接受）。除该字段外不得放行其它字段进 pi 请求。
		const attachmentId = record.attachmentId;
		const idOk =
			attachmentId === undefined ||
			(typeof attachmentId === "string" && attachmentId.trim() !== "" && attachmentId.length <= 128);
		if (!idOk) return null;
		images.push({
			type: "image",
			data: record.data,
			mimeType: record.mimeType,
			...(attachmentId !== undefined ? { attachmentId } : {}),
		} as ImageAttachment);
	}
	return images;
}

function asString(frame: Record<string, unknown>, field: string): string | undefined {
	const value = frame[field];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** attachment 请求的输入三元校验：非空有界字符串 + 非负安全整数。
 * 返回 null 表示协议违规（caller 回 bad-request）。 */
function readAttachmentRequest(
	frame: Record<string, unknown>,
): { sessionId: string; entryId: string; imageIndex: number } | null {
	const sessionId = asString(frame, "sessionId");
	const entryId = asString(frame, "entryId");
	if (!sessionId || !entryId || sessionId.length > 256 || entryId.length > 256) return null;
	const index = frame.imageIndex;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
	return { sessionId, entryId, imageIndex: index };
}

/** attachment 错误帧：统一 error 骨架 + 完整三元关联（§4.22）。 */
function attachmentError(
	code: string,
	message: string,
	sessionId: string,
	entryId: string,
	imageIndex: number,
): Record<string, unknown> {
	return { kind: "error", code, message, requestType: "attachment", sessionId, entryId, imageIndex };
}

/** tree 动作（entry-copy / label-put）的错误帧：统一 error 骨架 + entryId 关联，
 * 与 attachment 同口径（§4.26/§4.27）；未知异常的细节只进日志。 */
function treeActionError(
	code: string,
	message: string,
	requestType: string,
	sessionId: string | undefined,
	entryId: string | undefined,
): Record<string, unknown> {
	return {
		...errorFrame(code, message, requestType, sessionId),
		...(entryId !== undefined ? { entryId } : {}),
	};
}

/** Validation failures from host-fs carry client-safe messages; anything else
 * is logged with detail and answered with the fixed generic frame. */
function directoryErrorFrame(error: unknown, requestType: string): Record<string, unknown> {
	const classified = classifyDirectoryError(error);
	if (classified) return errorFrame(classified.code, classified.message, requestType);
	throw error;
}

/** Same contract for models.json management failures: client-actionable
 * validation/IO messages echo back, everything else stays internal. */
function providerErrorFrame(error: unknown, requestType: string): Record<string, unknown> {
	if (error instanceof ProviderConfigError) {
		return errorFrame(error.code, error.message, requestType);
	}
	throw error;
}

/** 内部比较连接配置，不落盘/回显凭据；改名称或数值元数据不使测试状态失效。
 * 有意比较原始连接字段：即使公共值被模型覆盖，改动也使旧诊断失效，避免借用旧结论。 */
function providerConnectionShape(provider: Record<string, unknown> | undefined): unknown {
	if (!provider) return undefined;
	const models = Array.isArray(provider.models) ? (provider.models as Array<Record<string, unknown>>) : [];
	return {
		baseUrl: provider.baseUrl,
		api: provider.api,
		apiKey: provider.apiKey,
		headers: provider.headers,
		models: models
			.map((model) => ({
				id: model.id,
				api: model.api,
				baseUrl: model.baseUrl,
				headers: model.headers,
			}))
			.sort((a, b) => String(a.id).localeCompare(String(b.id))),
	};
}

/** 默认 provider 测试状态文件：与设备注册表同目录（main 显式传入；此处只做兜底）。 */
function defaultProviderStatusStore(): ProviderStatusStore {
	return new ProviderStatusStore(join(homedir(), ".config", "pi-mobile-gateway", "provider-status.json"));
}

/** Options for {@link connectClient}: `log` receives internal failure
 * details that must NOT be echoed to the client in error frames. */
export interface ConnectClientOptions {
	log?: (message: string) => void;
	/** Optional provider-store override (tests inject a temp models.json). */
	providerStore?: PiProviderStore;
	/** provider 测试状态（provider-test 结果与菜单激活判定）；测试注入临时路径。 */
	providerStatusStore?: ProviderStatusStore;
}

export function connectClient(
	runtime: PiRuntime,
	rawSend: (frame: Record<string, unknown>) => void,
	options: ConnectClientOptions = {},
): ClientConnection {
	// 该连接已订阅的 sessionId 集合。摘除走 runtime.unsubscribe（session 级摘当前
	// handle）：attach 返回的 detach 闭包绑旧 handle，restart 后对非发起方连接失效。
	const subscriptions = new Set<string>();
	const log = options.log ?? (() => {});
	const providerStore = options.providerStore ?? new PiProviderStore();
	const providerStatusStore = options.providerStatusStore ?? defaultProviderStatusStore();
	/**
	 * provider 表单值优先，缺省回退 models.json 里已存的值——手机是**凭证盲**的，
	 * 保存过的 provider 其 apiKey 只存在宿主，编辑时表单里没有 key，不能要求用户
	 * 为"测试连接"/"拉取模型"重新输入一次。provider-test 与 provider-models 共用。
	 */
	const resolveProviderFormFields = async (
		frame: Record<string, unknown>,
	): Promise<{ id?: string; baseUrl?: string; apiKey?: string; api?: string; modelId?: string }> => {
		// id 保持 undefined（缺席）：调用侧用 `id ?? null` 回喂应答、用 `if (id)` 判落盘。
		const id = asString(frame, "id");
		const stored = id ? await providerStore.raw(id) : undefined;
		const storedModels = Array.isArray(stored?.models) ? (stored?.models as Array<Record<string, unknown>>) : [];
		const requestedModel = frame.type === "provider-test" ? asString(frame, "model") : undefined;
		const requestedApi = asString(frame, "api");
		// 手机列表会排序，不能用宿主数组首项替代所测模型。仅按模型ID测试
		// 才使用其baseUrl覆盖；provider级/models始终使用表单公共地址。
		const storedModel = requestedModel
			? storedModels.find((model) => model.id === requestedModel)
			: requestedApi
				? storedModels.find((model) => (model.api ?? stored?.api) === requestedApi)
				: storedModels[0];
		const draftModelUrl = requestedModel !== undefined && Object.hasOwn(frame, "modelBaseUrl");
		if (
			draftModelUrl &&
			frame.modelBaseUrl !== null &&
			(typeof frame.modelBaseUrl !== "string" || !/^https?:\/\//.test(frame.modelBaseUrl.trim()))
		) {
			throw new ProviderConfigError("模型Base URL必须是http(s)地址或null（继承）");
		}
		const baseUrl =
			(draftModelUrl
				? typeof frame.modelBaseUrl === "string"
					? frame.modelBaseUrl.trim()
					: undefined
				: requestedModel && typeof storedModel?.baseUrl === "string"
					? storedModel.baseUrl
					: undefined) ??
			asString(frame, "baseUrl") ??
			(typeof stored?.baseUrl === "string" ? stored.baseUrl : undefined);
		const apiKey = asString(frame, "apiKey") ?? (typeof stored?.apiKey === "string" ? stored.apiKey : undefined);
		const api =
			requestedApi ??
			(typeof storedModel?.api === "string" ? storedModel.api : undefined) ??
			(typeof stored?.api === "string" ? stored.api : undefined);
		const modelId = requestedModel ?? (typeof storedModel?.id === "string" ? storedModel.id : undefined);
		return { id, baseUrl, apiKey, api, modelId };
	};
	// 出站帧统一走这里：全帧记 kind/bytes，error 帧另记 code/文案（与入站帧日志配对）。
	const send = (frame: Record<string, unknown>) => {
		const size = Buffer.byteLength(JSON.stringify(frame), "utf8");
		log(`out frame: kind=${String(frame.kind)} request=${String(frame.requestType ?? "-")} bytes=${size}`);
		if (frame.kind === "error") {
			log(
				`error frame: code=${String(frame.code)} request=${String(frame.requestType ?? "-")} ` +
					`sessionId=${String(frame.sessionId ?? "-")} message=${String(frame.message)}`,
			);
		}
		rawSend(frame);
	};

	const subscribe = (sessionId: string, handle: SessionHandle) => {
		if (!subscriptions.has(sessionId)) {
			subscriptions.add(sessionId);
			handle.attach(send);
		}
	};
	const inputAssist = createInputAssist(runtime, send, log);

	const handleMessage = async (frame: Record<string, unknown>): Promise<void> => {
		const requestType = typeof frame.type === "string" ? frame.type : "query";
		try {
			switch (frame.type) {
				case "input-resources":
				case "input-completions":
					await inputAssist.handle(frame);
					return;
				case "sessions": {
					const items = await runtime.listSessions();
					send({ kind: "sessions", items });
					return;
				}

				case "subscribe": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "subscribe requires a sessionId", "subscribe"));
						return;
					}
					const handle = await runtime.openSession(sessionId);
					subscribe(sessionId, handle);
					send({ kind: "subscribed", sessionId });
					return;
				}

				case "unsubscribe": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "unsubscribe requires a sessionId", "unsubscribe"));
						return;
					}
					subscriptions.delete(sessionId);
					runtime.unsubscribe(sessionId, send);
					send({ kind: "unsubscribed", sessionId });
					return;
				}

				case "message": {
					const sessionId = asString(frame, "sessionId");
					const cwd = asString(frame, "cwd");
					const rawText = frame.text;
					const text = typeof rawText === "string" ? rawText : "";
					const imageAttachments = readImageAttachments(frame.images);
					if (imageAttachments === null) {
						send(
							errorFrame(
								"bad-request",
								`message images must be at most ${MAXIMUM_MESSAGE_IMAGES} {type:"image", data, mimeType} entries`,
								"message",
								sessionId,
							),
						);
						return;
					}
					// 纯图消息合法：text 可为空，但 text 与 images 不能全空。
					if (text.trim() === "" && imageAttachments.length === 0) {
						send(
							errorFrame("bad-request", "message requires non-empty text or at least one image", "message", sessionId),
						);
						return;
					}
					if (sessionId && cwd) {
						send(errorFrame("bad-request", "message requires sessionId or cwd, not both", "message"));
						return;
					}
					if (!sessionId && !cwd) {
						send(errorFrame("bad-request", "message requires a sessionId (existing) or cwd (new session)", "message"));
						return;
					}
					const mode = frame.mode === undefined ? "prompt" : frame.mode;
					if (mode !== "prompt" && mode !== "steer" && mode !== "followUp") {
						send(
							errorFrame("bad-request", 'message mode must be "prompt", "steer" or "followUp"', "message", sessionId),
						);
						return;
					}
					// 模型预选预校验（对标 pi CLI：resolveCliModel 的 error 在
					// createAgentSession 之前导致 process.exit(1)，不建会话文件）。
					// 结构与"定义存在性"在这里拒绝；auth 等深层校验仍在建会话后
					// 的 setModel（CLI 同类：--model 有效但无 auth → 会话已建、
					// prompt 失败）。
					let preselection: { provider: string; modelId: string; thinkingLevel?: string } | undefined;
					if (frame.model !== undefined) {
						const selection = readModelSelection(frame.model);
						if (selection === null) {
							send(
								errorFrame(
									"bad-request",
									"message model must be {provider, modelId, thinkingLevel?}",
									"message",
									sessionId,
								),
							);
							return;
						}
						if (!(await runtime.modelDefinitionExists(selection.provider, selection.modelId))) {
							send(
								errorFrame(
									"bad-request",
									`unknown model: ${selection.provider}/${selection.modelId}`,
									"message",
									sessionId,
								),
							);
							return;
						}
						preselection = selection;
					}
					let handle: SessionHandle;
					if (sessionId) {
						log(`message: openSession(sessionId=${sessionId.slice(0, 8)}) entering`);
						handle = await runtime.openSession(sessionId);
						log(`message: openSession resolved`);
					} else {
						// asString guarantees non-empty here; cwd problems
						// (relative/missing/non-directory) are client errors.
						try {
							handle = await runtime.createSession(validateCwd(cwd as string));
						} catch (error) {
							send(directoryErrorFrame(error, "message"));
							return;
						}
					}
					const resolvedId = handle.session.sessionId;
					// Subscribe before prompting so the run's first events
					// cannot race past the subscription.
					subscribe(resolvedId, handle);
					// 模型预选（新会话/连接恢复）：先切模型再跑首轮，避免第一轮用
					// pi 默认模型开跑（客户端"先选模型后发消息"的顺序由此保证）。
					// 结构/存在性已在建会话前预校验；这里只处理 setModel 的深层
					// 失败（无 API key 等）——会话已建，与 prompt-rejected 同类。
					if (preselection) {
						try {
							await runtime.setModel(
								resolvedId,
								preselection.provider,
								preselection.modelId,
								preselection.thinkingLevel,
							);
						} catch (error) {
							send(
								errorFrame(
									"bad-request",
									error instanceof Error ? error.message : String(error),
									"message",
									resolvedId,
								),
							);
							return;
						}
					}
					try {
						log(`message: prompt entering (bytes=text:${text.length}, images:${imageAttachments.length})`);
						await runtime.prompt(handle, text, mode, imageAttachments, (acceptance) => {
							log(`message: sending sent`);
							send({ kind: "sent", mode, disposition: acceptance.disposition, ...acceptance.state });
						});
						log(`message: prompt resolved`);
					} catch (error) {
						// Prompt-level failures are validation/preflight
						// rejections (no model, streaming without a queue
						// mode, extension preflight) — client-facing, unlike
						// post-acceptance failures which arrive as events.
						send(
							errorFrame(
								"prompt-rejected",
								error instanceof Error ? error.message : String(error),
								"message",
								resolvedId,
							),
						);
						return;
					}
					return;
				}

				case "dequeue": {
					const sessionId = asString(frame, "sessionId");
					const queueRequestId = asString(frame, "queueRequestId");
					if (!sessionId || !queueRequestId || queueRequestId.length > 128) {
						send({
							...errorFrame("bad-request", "dequeue requires sessionId and queueRequestId", "dequeue", sessionId),
							...(queueRequestId && queueRequestId.length <= 128 ? { queueRequestId } : {}),
						});
						return;
					}
					try {
						await runtime.dequeue(sessionId, (queued, state) => {
							send({ kind: "dequeued", ...state, queued, queueRequestId });
						});
					} catch (error) {
						log(`internal error handling dequeue frame: ${String(error)}`);
						send({ ...errorFrame("internal", "internal error", "dequeue", sessionId), queueRequestId });
					}
					return;
				}

				case "abort": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "abort requires a sessionId", "abort"));
						return;
					}
					if (frame.restoreQueued !== undefined && typeof frame.restoreQueued !== "boolean") {
						send(errorFrame("bad-request", "restoreQueued must be boolean", "abort", sessionId));
						return;
					}
					const result = await runtime.abort(sessionId, frame.restoreQueued === true);
					send({
						kind: "aborted",
						...result.state,
						...(frame.restoreQueued === true ? { queued: result.queued } : {}),
					});
					return;
				}

				case "history": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "history requires a sessionId", "history"));
						return;
					}
					const beforeEntryId = asOptionalString(frame.beforeEntryId);
					if (frame.beforeEntryId !== undefined && beforeEntryId === undefined) {
						send(errorFrame("bad-request", "beforeEntryId must be a non-empty string", "history", sessionId));
						return;
					}
					let limit: number | undefined;
					if (frame.limit !== undefined) {
						if (typeof frame.limit !== "number" || !Number.isInteger(frame.limit) || frame.limit < 1) {
							send(errorFrame("bad-request", "limit must be a positive integer", "history", sessionId));
							return;
						}
						limit = frame.limit;
					}
					// resetLeaf：重连 catch-up 用（pi TUI 重开语义——回文件尾），
					// 释放手动叶子后再切片；翻页路径绝不带。
					const resetLeaf = frame.resetLeaf === true;
					let turnLimit: number | undefined;
					if (frame.turnLimit !== undefined) {
						if (
							typeof frame.turnLimit !== "number" ||
							!Number.isInteger(frame.turnLimit) ||
							frame.turnLimit < 1 ||
							frame.turnLimit > 10
						) {
							send(errorFrame("bad-request", "turnLimit must be an integer from 1 to 10", "history", sessionId));
							return;
						}
						turnLimit = frame.turnLimit;
					}
					const page = await runtime.history(sessionId, beforeEntryId, limit, resetLeaf, turnLimit);
					send({
						kind: "history",
						sessionId,
						messages: page.messages,
						entryIds: page.entryIds,
						hasMore: page.hasMore,
						oldestEntryId: page.oldestEntryId,
						latestEntryId: page.latestEntryId,
						bytes: page.bytes,
						isStreaming: page.state.isStreaming,
						isCompacting: page.state.isCompacting,
						model: page.state.model,
						thinkingLevel: page.state.thinkingLevel,
						queuedMessages: page.state.queuedMessages,
						contextUsage: page.state.contextUsage,
					});
					return;
				}

				case "state": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "state requires a sessionId", "state"));
						return;
					}
					const state = await runtime.state(sessionId);
					send({ kind: "state", ...state });
					return;
				}

				// -- session tree / branch switching --------------------------

				case "commands": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "commands requires a sessionId", "commands"));
						return;
					}
					const commands = await runtime.listCommands(sessionId);
					send({ kind: "commands", sessionId, commands });
					return;
				}

				case "tree": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "tree requires a sessionId", "tree"));
						return;
					}
					const view = frame.view === undefined ? undefined : readTreeView(frame.view);
					if (view === null) {
						send(errorFrame("bad-request", "invalid tree view", "tree"));
						return;
					}
					const result = await runtime.tree(sessionId, view);
					send({ kind: "tree", sessionId, ...result, ...(view ? { view } : {}) });
					return;
				}

				case "switch-branch": {
					const sessionId = asString(frame, "sessionId");
					const entryId = asString(frame, "entryId");
					if (!sessionId || !entryId) {
						send(errorFrame("bad-request", "switch-branch requires sessionId and entryId", "switch-branch"));
						return;
					}
					const result = await runtime.switchBranch(sessionId, entryId);
					const { state, ...rest } = result;
					send({ kind: "branch-switched", ...rest, ...state, sessionId });
					return;
				}

				// -- tree 动作：整条 entry 复制 / 标签写（§4.26–§4.27）----------

				case "entry-copy": {
					const sessionId = asString(frame, "sessionId");
					const entryId = asString(frame, "entryId");
					if (!sessionId || !entryId || sessionId.length > 256 || entryId.length > 256) {
						send(
							treeActionError(
								"bad-request",
								"entry-copy requires bounded sessionId and entryId",
								"entry-copy",
								sessionId,
								entryId,
							),
						);
						return;
					}
					try {
						const result = await runtime.entryCopy(sessionId, entryId);
						send({ kind: "entry-copy", ...result });
					} catch (error) {
						if (error instanceof SessionNotFoundError) {
							send(treeActionError("session-not-found", error.message, "entry-copy", sessionId, entryId));
						} else if (error instanceof EntryNotFoundError) {
							send(treeActionError("entry-not-found", "条目不存在，请刷新会话树", "entry-copy", sessionId, entryId));
						} else if (error instanceof EntryCopyEmptyError) {
							send(treeActionError("entry-copy-empty", "该条目没有可复制的文本", "entry-copy", sessionId, entryId));
						} else {
							log(`internal error handling entry-copy frame: ${String(error)}`);
							send(treeActionError("internal", "internal error", "entry-copy", sessionId, entryId));
						}
					}
					return;
				}

				case "label-put": {
					const sessionId = asString(frame, "sessionId");
					const entryId = asString(frame, "entryId");
					if (!sessionId || !entryId || sessionId.length > 256 || entryId.length > 256) {
						send(
							treeActionError(
								"bad-request",
								"label-put requires bounded sessionId and entryId",
								"label-put",
								sessionId,
								entryId,
							),
						);
						return;
					}
					// label 缺席 / null / 空白串 = 清除（Pi LabelInput 语义）；非字符串或超长是协议违规。
					const normalized = normalizeLabelValue(frame.label);
					if (normalized === null) {
						send(
							treeActionError(
								"bad-request",
								`label must be a string of at most ${LABEL_MAX_CHARS} chars, null or omitted`,
								"label-put",
								sessionId,
								entryId,
							),
						);
						return;
					}
					try {
						const result = await runtime.putLabel(sessionId, entryId, normalized.label);
						send({ kind: "label-put", ...result });
					} catch (error) {
						if (error instanceof SessionNotFoundError) {
							send(treeActionError("session-not-found", error.message, "label-put", sessionId, entryId));
						} else if (error instanceof EntryNotFoundError) {
							send(treeActionError("entry-not-found", "条目不存在，请刷新会话树", "label-put", sessionId, entryId));
						} else {
							log(`internal error handling label-put frame: ${String(error)}`);
							send(treeActionError("internal", "internal error", "label-put", sessionId, entryId));
						}
					}
					return;
				}

				// -- attachment：历史图片按需读取（§4.22）----------------------

				case "attachment": {
					const request = readAttachmentRequest(frame);
					if (request === null) {
						send(
							errorFrame(
								"bad-request",
								"attachment requires bounded sessionId/entryId strings and a non-negative safe integer imageIndex",
								"attachment",
							),
						);
						return;
					}
					const { sessionId, entryId, imageIndex } = request;
					// 已知错误与未知内部错误都在本 case 内收口：错误帧永远带完整三元
					// 关联；未知异常的细节（可能含文件系统路径）只进网关日志，客户端
					// 只收到固定通用文案。
					try {
						const attachment = await runtime.attachment(sessionId, entryId, imageIndex);
						send({ kind: "attachment", ...attachment });
					} catch (error) {
						if (error instanceof SessionNotFoundError) {
							send(attachmentError("session-not-found", error.message, sessionId, entryId, imageIndex));
						} else if (error instanceof AttachmentNotFoundError) {
							send(
								attachmentError(
									"attachment-not-found",
									"attachment entry/index not found in this session",
									sessionId,
									entryId,
									imageIndex,
								),
							);
						} else if (error instanceof AttachmentTooLargeError) {
							send(
								attachmentError(
									"attachment-too-large",
									"image exceeds the 4 MiB raw-byte attachment budget",
									sessionId,
									entryId,
									imageIndex,
								),
							);
						} else if (error instanceof AttachmentInvalidError) {
							send(attachmentError("attachment-invalid", error.message, sessionId, entryId, imageIndex));
						} else {
							log(`internal error handling attachment frame: ${String(error)}`);
							send(attachmentError("internal", "internal error", sessionId, entryId, imageIndex));
						}
					}
					return;
				}

				// -- model catalog / switching --------------------------------

				case "models": {
					send({ kind: "models", groups: await runtime.listModels() });
					return;
				}

				case "set-model": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "set-model requires a sessionId", "set-model"));
						return;
					}
					const provider = asString(frame, "provider");
					const modelId = asString(frame, "modelId");
					if (!provider || !modelId) {
						send(errorFrame("bad-request", "set-model requires provider and modelId", "set-model", sessionId));
						return;
					}
					let thinkingLevel: string | undefined;
					if (frame.thinkingLevel !== undefined) {
						if (
							typeof frame.thinkingLevel !== "string" ||
							!THINKING_LEVELS.includes(frame.thinkingLevel as (typeof THINKING_LEVELS)[number])
						) {
							send(
								errorFrame(
									"bad-request",
									`thinkingLevel must be one of ${THINKING_LEVELS.join("|")}`,
									"set-model",
									sessionId,
								),
							);
							return;
						}
						thinkingLevel = frame.thinkingLevel;
					}
					const state = await runtime.setModel(sessionId, provider, modelId, thinkingLevel);
					send({ kind: "model-set", ...state });
					return;
				}

				case "name": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "name requires a sessionId", "name"));
						return;
					}
					const name = asString(frame, "name");
					if (!name || name.length > 200) {
						send(errorFrame("bad-request", "name must be a non-empty string of at most 200 chars", "name", sessionId));
						return;
					}
					const state = await runtime.setSessionName(sessionId, name);
					// 带 name：客户端以单一数据流刷新会话列表与顶栏标题。
					send({ kind: "session-named", name, ...state, sessionId });
					return;
				}

				case "restart-session": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "restart-session requires a sessionId", "restart-session"));
						return;
					}
					const state = await runtime.restartSession(sessionId);
					// 应答按 state 快照形状下发；客户端随后以 resetLeaf 重拉 history
					// 完成会话视图重建（与重连 catch-up 同通道）。摘除走 session 级
					//（unsubscribe/close 经 runtime.unsubscribe），此处无需刷新。
					send({ kind: "session-restarted", ...state, sessionId });
					return;
				}

				case "compact": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "compact requires a sessionId", "compact"));
						return;
					}
					const state = await runtime.beginCompact(sessionId);
					send({ kind: "compact-started", ...state, sessionId });
					return;
				}

				// -- workspace picker (host filesystem services) --------------

				case "directories": {
					try {
						send({ kind: "directories", ...listDirectories(asOptionalString(frame.path)) });
					} catch (error) {
						send(directoryErrorFrame(error, "directories"));
					}
					return;
				}

				case "directory-create": {
					const parentPath = asString(frame, "path");
					const name = asString(frame, "name");
					if (!parentPath || !name) {
						send(errorFrame("bad-request", "directory-create requires path and name", "directory-create"));
						return;
					}
					try {
						const result = createDirectory(parentPath, name);
						send({ kind: "directory-create", path: result.path, created: result.created });
					} catch (error) {
						send(directoryErrorFrame(error, "directory-create"));
					}
					return;
				}

				case "workspace-create": {
					const path = asString(frame, "path");
					if (!path) {
						send(errorFrame("bad-request", "workspace-create requires path", "workspace-create"));
						return;
					}
					try {
						const workspace = createWorkspaceAt(path);
						send({ kind: "workspace-create", workspace });
					} catch (error) {
						send(directoryErrorFrame(error, "workspace-create"));
					}
					return;
				}
				case "model-scope":
				case "model-scope-put": {
					const requestType = frame.type as string;
					const scopeRequestId = asString(frame, "scopeRequestId");
					try {
						if (requestType === "model-scope") {
							send({ kind: "model-scope", scope: await runtime.modelScope() });
							return;
						}
						if (
							!scopeRequestId ||
							scopeRequestId.length > 128 ||
							!Array.isArray(frame.expectedPatterns) ||
							frame.expectedPatterns.length > 2048 ||
							!frame.expectedPatterns.every((item) => typeof item === "string" && item.length <= 1024) ||
							!Array.isArray(frame.models) ||
							frame.models.length > 2048 ||
							typeof frame.preserveUnmatched !== "boolean" ||
							typeof frame.reset !== "boolean"
						) {
							throw new ModelScopeError("bad-request", "模型范围保存参数无效");
						}
						const models = frame.models.map(readModelSelection);
						if (models.some((item) => item === null)) throw new ModelScopeError("bad-request", "模型范围条目无效");
						const scope = await runtime.saveModelScope(
							frame.expectedPatterns as string[],
							models.filter((item): item is NonNullable<typeof item> => item !== null),
							frame.preserveUnmatched,
							frame.reset,
						);
						send({ kind: "model-scope-saved", scope, scopeRequestId });
					} catch (error) {
						const failure =
							error instanceof ModelScopeError
								? error
								: new ModelScopeError(
										requestType === "model-scope" ? "scope-read-failed" : "scope-save-failed",
										"模型范围操作失败，请重新加载后重试",
									);
						send({ ...errorFrame(failure.code, failure.message, requestType), scopeRequestId });
					}
					return;
				}

				// -- provider management (pi models.json) -----------------------

				case "providers": {
					try {
						// 读前门控：外部手改 models.json 后，provider 列表即最新。
						await runtime.ensureConfigFresh();
						const providers = await providerStore.list();
						let catalogError: string | undefined;
						const catalogProviders = await providerStore.listCatalog().catch(() => {
							catalogError = "models-store.json 读取失败，请稍后重试";
							return [];
						});
						// 测试状态仅供提示；模型菜单由 Pi getAvailable + enabledModels 决定。
						send({
							kind: "providers",
							catalogProviders,
							...(catalogError ? { catalogError } : {}),
							providers: providers.map((provider) => ({
								...provider,
								active: providerStatusStore.isActive(provider.id),
								status: providerStatusStore.get(provider.id) ?? null,
							})),
						});
					} catch (error) {
						send(providerErrorFrame(error, "providers"));
					}
					return;
				}

				case "provider-models": {
					// 拉取上游 `/models` 清单。**走网关**而不是客户端直连：手机是凭证盲的，
					// 保存过的 provider 其 apiKey 只在宿主 models.json 里，编辑时表单为空——
					// 直连必然 401（用户实测："测试连接"能过、"拉取模型"报 401，因为前者
					// 走网关、后者直连）。这里与 provider-test 同口径：表单值优先、缺省回退
					// 已存值，用户不必为拉一次列表重新输入 Key。
					try {
						const { id, baseUrl, apiKey, api } = await resolveProviderFormFields(frame);
						if (!baseUrl) {
							send(errorFrame("bad-request", "provider-models requires baseUrl", "provider-models"));
							return;
						}
						const result = await fetchProviderModels({ baseUrl, apiKey, api });
						send({ kind: "provider-models-result", id: id ?? null, ...result });
					} catch (error) {
						send(providerErrorFrame(error, "provider-models"));
					}
					return;
				}

				case "provider-test": {
					// 用表单当前值测试；编辑场景缺失的字段回退到 models.json 里已存的值
					// （手机凭证盲，不要求用户重填 apiKey）。
					try {
						const { id, baseUrl, apiKey, api, modelId } = await resolveProviderFormFields(frame);
						if (!baseUrl || !modelId) {
							send(errorFrame("bad-request", "provider-test requires baseUrl and a model", "provider-test"));
							return;
						}
						const result = await testProvider({ baseUrl, apiKey, api, modelId });
						// 草稿探测不证明盘上旧配置可用。请求期间电脑端也可能改配置，
						// 所以回执落诊断状态前重读，只认当前已存模型的有效配置。
						const current = id ? await providerStore.raw(id) : undefined;
						const currentModels = Array.isArray(current?.models)
							? (current.models as Array<Record<string, unknown>>)
							: [];
						const currentModel = currentModels.find((model) => model.id === modelId);
						const currentBaseUrl = currentModel?.baseUrl ?? current?.baseUrl;
						const currentApi = currentModel?.api ?? current?.api ?? "openai-completions";
						const testsSavedConfig =
							currentModel !== undefined &&
							currentBaseUrl === baseUrl &&
							currentApi === (api ?? "openai-completions") &&
							current?.apiKey === apiKey;
						// 结果落盘：
						//  - 成功 / config 失败（需用户改配置）→ 写入（决定灰显与菜单可见性）
						//  - transient 失败（超时/5xx/429）→ 保留旧成功；只清除旧失败，
						//    避免配置已修正但上游抖动仍沿用过期的config-fail禁用。
						if (id && testsSavedConfig) {
							if (result.failureKind === "transient") {
								if (providerStatusStore.get(id)?.ok === false) providerStatusStore.remove(id);
							} else {
								providerStatusStore.set(id, {
									ok: result.ok,
									testedAt: new Date().toISOString(),
									...(result.error ? { error: result.error } : {}),
									...(result.failureKind ? { failureKind: result.failureKind } : {}),
								});
							}
						}
						send({ kind: "provider-test-result", id: id ?? null, ...result });
					} catch (error) {
						send(providerErrorFrame(error, "provider-test"));
					}
					return;
				}

				case "provider-put": {
					const id = asString(frame, "id");
					if (!id) {
						send(errorFrame("bad-request", "provider-put requires an id", "provider-put"));
						return;
					}
					const baseUrl = asString(frame, "baseUrl");
					const apiKey = asString(frame, "apiKey");
					// 协议属模型级：provider 级 api 仅在客户端显式发送时透传（缺省不清底）。
					const api = asString(frame, "api");
					if (!baseUrl && !apiKey) {
						send(errorFrame("bad-request", "provider-put requires baseUrl or apiKey", "provider-put"));
						return;
					}
					if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
						send(errorFrame("bad-request", "baseUrl 必须是 http(s) 地址", "provider-put"));
						return;
					}
					if (frame.models !== undefined && !Array.isArray(frame.models)) {
						send(errorFrame("bad-request", "models 必须是数组", "provider-put"));
						return;
					}
					try {
						const previous = providerConnectionShape(await providerStore.raw(id));
						const { provider, removedModelIds } = await providerStore.put({
							id,
							name: asString(frame, "name"),
							baseUrl,
							apiKey,
							api,
							models: frame.models as ProviderUpsert["models"],
						});
						const current = providerConnectionShape(await providerStore.raw(id));
						// 新草稿测通只归发起卡片。配置改变后清过期诊断，不能仍灰显或
						// 借旧成功放行另一份配置；名称/元数据未动连接配置时保留。
						if (JSON.stringify(previous) !== JSON.stringify(current)) providerStatusStore.remove(id);
						// 模型定义编辑不等于scope编辑：不能自动追加provider/*扩大
						// settings.enabledModels。范围仍由Pi/scoped-models管理。
						// 这次编辑里被删掉的模型行：它们在 models.json 里已消失，settings 里
						// 的具体 pattern 也就成了死条目——此前只 append 不清理，会永久残留
						//（实测残留过 relayA/<模型名>）。
						if (removedModelIds.length > 0) {
							await runtime.removeEnabledModelPatterns(id, removedModelIds);
						}
						// 触发 pi 原地重读 models.json：所有存活会话共享同一 ModelRuntime
						// 实例，刷新后新 provider 对模型菜单与会话切模型同时可见
						// （refreshModelRuntime 注释）。
						const refreshed = await runtime.refreshModelRuntime();
						send({ kind: "provider-saved", provider, refreshed });
					} catch (error) {
						send(providerErrorFrame(error, "provider-put"));
					}
					return;
				}

				case "provider-delete": {
					const id = asString(frame, "id");
					if (!id) {
						send(errorFrame("bad-request", "provider-delete requires an id", "provider-delete"));
						return;
					}
					try {
						await providerStore.remove(id);
						// 删除Provider时清理该provider的所有已失效scope条目：
						// pattern（`providerId/*` 与 `providerId/<模型id>`）一并移除，避免死
						// pattern 越积越多（旧实现只删通配符形态，具体模型条目清不掉）；
						// 失败不影响删除应答（菜单口径可手工修正）。
						await runtime.removeEnabledModelPatternsForProvider(id);
						// 删除 provider 时一并清掉它的测试状态，避免残留记录影响同名重建的判定。
						providerStatusStore.remove(id);
						// 删除同样要刷新运行时目录，否则已删 provider 的模型仍留在菜单里。
						const refreshed = await runtime.refreshModelRuntime();
						send({ kind: "provider-deleted", id, refreshed });
					} catch (error) {
						send(providerErrorFrame(error, "provider-delete"));
					}
					return;
				}

				default:
					send(errorFrame("unknown-command", `unknown frame type: ${String(frame.type)}`, requestType));
			}
		} catch (error) {
			if (error instanceof HistoryCursorError) {
				log("history cursor invalid");
				send(errorFrame("history-cursor-invalid", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			if (error instanceof HistoryTurnPageTooLargeError) {
				send(errorFrame("history-turn-too-large", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			if (error instanceof SessionNotFoundError) {
				send(errorFrame("session-not-found", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			if (error instanceof ModelChangeError) {
				send(errorFrame("bad-request", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			if (error instanceof SessionNameError) {
				send(errorFrame("bad-request", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			if (error instanceof SessionRestartError) {
				send(errorFrame("session-restart-busy", error.message, requestType, asString(frame, "sessionId")));
				return;
			}
			// Runtime failures (file unreadable, unknown history cursor, …)
			// are logged with detail; the client gets a fixed generic message
			// — underlying messages can carry filesystem paths and must not
			// leak, and no stack trace ever leaves the process.
			log(`internal error handling ${requestType} frame: ${String(error)}`);
			send(errorFrame("internal", "internal error", requestType, asString(frame, "sessionId")));
		}
	};

	return {
		handleMessage: (frame) =>
			handleMessage(frame).catch((error) => {
				log(`unhandled error after frame handling: ${String(error)}`);
				send(errorFrame("internal", "internal error", "query"));
			}),
		close: () => {
			inputAssist.close();
			for (const sessionId of subscriptions) runtime.unsubscribe(sessionId, send);
			subscriptions.clear();
		},
	};
}
