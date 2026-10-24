import type { BridgeWorkspaces } from "./bridge-workspaces.ts";
import { HistoryCursorError, HistoryTurnPageTooLargeError } from "./history-turns.ts";
import { createInputAssist, InputAssistError } from "./input-assist.ts";
import { LABEL_MAX_CHARS, normalizeLabelValue, readTreeView } from "./tree-view.ts";
import { listWorktrees, WorktreeError } from "./worktrees.ts";
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
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BridgeDescriptor, BridgeSnapshot } from "../bridge-extension/src/protocol.ts";
import { type BridgeHub, BridgeRequestError, BridgeUnavailableError } from "./bridge.ts";
import { BridgeLaunchError, type BridgeLauncher } from "./bridge-launch.ts";
import { classifyDirectoryError, createDirectory, createWorkspaceAt, listDirectories } from "./host-fs.ts";
import type { HostMode, HostModeStore } from "./host-mode.ts";
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
import {
	capHistoryPage,
	entryToWireMessage,
	errorFrame,
	oversizedEventStub,
	type PiTreeNode,
	sanitizeHistoryMessage,
	shrinkForWire,
	toWireTreeNodes,
	trimTreeNodes,
	WIRE_EVENT_MAX_BYTES,
	type WireMessage,
} from "./wire.ts";

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

function bridgeStartError(
	code: string,
	message: string,
	sessionId: string | undefined,
	operationId: string | undefined,
): Record<string, unknown> {
	return {
		...errorFrame(code, message, "bridge-start", sessionId),
		...(operationId !== undefined ? { operationId } : {}),
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

/** 需要网关 SDK 句柄或直接改写会话文件的帧；桥接模式一律拒绝。 */
const BRIDGE_UNSUPPORTED_FRAMES = new Set(["restart-session"]);

/** 桥接协议稳定错误码 → 网关错误码；未知错误不泄露原始报文。 */
function bridgeErrorCode(code: string | undefined): string {
	switch (code) {
		case "entry-not-found":
		case "entry-copy-empty":
		case "navigation-failed":
		case "navigation-cancelled":
		case "navigation-unconfirmed":
		case "busy":
		case "session-owned":
		case "operation-id-conflict":
		case "operation-capacity":
		case "bridge-offline":
		case "bridge-unavailable":
		case "frame-too-large":
		case "model-not-found":
		case "model-auth-missing":
		case "model-change-failed":
		case "model-change-unconfirmed":
		case "model-refresh-busy":
		case "model-config-refresh-failed":
		case "model-change-pending":
		case "compaction-busy":
		case "compaction-failed":
		case "compaction-cancelled":
		case "compaction-unconfirmed":
			return code;
		case "unsupported":
			return "bridge-unavailable";
		case "stale-runtime":
			return "bridge-stale-runtime";
		// 取回队列依赖当前 editor 的 dequeue 动作；被其他 custom editor 占用时
		// 回独立稳定码，手机据此给“无法取回排队消息”而不是“模式不支持”。
		case "editor-unavailable":
			return "editor-unavailable";
		// 取回动作已执行却没捕获到文字：队列可能已被清空，不能按"不可用"或
		// 通用失败呈现，必须有独立稳定码让手机如实说"去向未确认"。
		case "dequeue-unconfirmed":
			return "dequeue-unconfirmed";
		case "invalid-text":
		case "invalid-delivery":
		case "image-invalid":
		case "invalid-request":
			return "bad-request";
		case "runtime-offline":
		case "submission-failed":
			return "bridge-offline";
		default:
			return "internal";
	}
}

/** 手机只看稳定短文案，不透出扩展端原因。 */
function bridgeErrorMessage(code: string | undefined): string {
	switch (code) {
		case "busy":
			return "会话正在运行，请用 steer 或 follow-up 追加";
		case "session-owned":
			return "会话已被另一个 Pi 实例持有";
		case "operation-id-conflict":
			return "桥接请求无法执行";
		case "editor-unavailable":
			return "输入框被其他扩展占用，暂时无法取回排队消息";
		case "dequeue-unconfirmed":
			return "排队消息去向未确认，请在电脑查看";
		case "frame-too-large":
			return "消息或附件超过桥接单帧上限";
		case "stale-runtime":
			return "原生 Pi 实例已更换，请刷新后重试";
		case "runtime-offline":
		case "submission-failed":
			return "原生 Pi 实例不在线";
		default:
			return "桥接请求失败";
	}
}

interface HostModeConnectionControl {
	stopBridgeSubscriptions: () => void;
	releaseSdkSubscriptions: () => void;
}

interface HostModeCoordinator {
	readonly inFlight: Map<string, number>;
	sdkInFlight: number;
	launchInFlight: number;
	switching: boolean;
	readonly connections: Set<HostModeConnectionControl>;
}

const hostModeCoordinators = new WeakMap<HostModeStore, HostModeCoordinator>();

/** 同一 host-mode 文件的所有连接共享在途写与切换状态；进程内只有一个网关实例。 */
function hostModeCoordinator(store: HostModeStore): HostModeCoordinator {
	const existing = hostModeCoordinators.get(store);
	if (existing) return existing;
	const created: HostModeCoordinator = {
		inFlight: new Map(),
		sdkInFlight: 0,
		launchInFlight: 0,
		switching: false,
		connections: new Set(),
	};
	hostModeCoordinators.set(store, created);
	return created;
}

/** Options for {@link connectClient}: `log` receives internal failure
 * details that must NOT be echoed to the client in error frames. */
export interface ConnectClientOptions {
	log?: (message: string) => void;
	/** Optional provider-store override (tests inject a temp models.json). */
	providerStore?: PiProviderStore;
	/** provider 测试状态（provider-test 结果与菜单激活判定）；测试注入临时路径。 */
	providerStatusStore?: ProviderStatusStore;
	/** 宿主连接模式（sdk / bridge）；缺省时保持纯 SDK 行为。 */
	hostModeStore?: HostModeStore;
	/** 桥接实例发现与 IPC；缺省时不提供桥接能力。 */
	bridge?: BridgeHub;
	/** 后台启动原生 Pi；缺省时不暴露 bridge-start。 */
	bridgeLauncher?: BridgeLauncher;
	bridgeWorkspaces?: BridgeWorkspaces;
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
	const inputAssist = createInputAssist(runtime, send, log, {
		resolveContext: async (context, frame, signal) => {
			const native = bridgeMode();
			if (!native || context.sessionId === undefined) {
				const cwd = await runtime.inputCwd(context);
				return {
					cwd,
					readResources: () => runtime.inputResources(context, cwd),
					validate: () => {
						if (native !== bridgeMode()) throw new InputAssistError("mode-switch-blocked", "mode changed");
					},
				};
			}
			const sessionId = context.sessionId;
			const bad = (code: string): never => {
				throw new InputAssistError(code, "native input unavailable");
			};
			if (typeof frame.instanceId !== "string" || !frame.instanceId || typeof frame.epoch !== "string" || !frame.epoch)
				bad("bad-request");
			if (modeSwitchInFlight()) bad("mode-switch-blocked");
			if (!bridge) return bad("bridge-unavailable");
			const descriptor = bridge.descriptor(sessionId);
			if (!descriptor) return bad("bridge-offline");
			if (descriptor.instanceId !== frame.instanceId || descriptor.epoch !== frame.epoch) bad("bridge-stale-runtime");
			const validate = () => {
				if (!bridgeMode() || modeSwitchInFlight()) bad("mode-switch-blocked");
				const current = bridge.descriptor(sessionId);
				if (!current) return bad("bridge-offline");
				if (current.instanceId !== descriptor.instanceId || current.epoch !== descriptor.epoch)
					bad("bridge-stale-runtime");
			};
			return {
				cwd: descriptor.cwd,
				validate,
				readResources: async () => {
					try {
						validate();
						const result = await bridge.inputResources(descriptor, signal);
						validate();
						if (!Array.isArray(result.commands) || typeof result.skillCommandsEnabled !== "boolean")
							return bad("bridge-unavailable");
						return {
							cwd: descriptor.cwd,
							mode: "session" as const,
							complete: true,
							commands: result.commands,
							skillCommandsEnabled: result.skillCommandsEnabled,
							shadowed: result.shadowed ?? [],
							omitted: [],
						};
					} catch (error) {
						if (error instanceof InputAssistError) throw error;
						return bad(error instanceof BridgeRequestError ? bridgeErrorCode(error.code) : "bridge-offline");
					}
				},
			};
		},
	});
	const hostModeStore = options.hostModeStore;
	const bridge = options.bridge;
	const bridgeMode = () => hostModeStore?.read() === "bridge";
	/** 同一 host-mode 文件的所有连接共享在途写与切换状态。 */
	const coordinator = hostModeStore ? hostModeCoordinator(hostModeStore) : null;
	const bridgeInFlight = coordinator?.inFlight ?? new Map<string, number>();
	const beginBridgeWrite = (sessionId: string) => {
		bridgeInFlight.set(sessionId, (bridgeInFlight.get(sessionId) ?? 0) + 1);
	};
	const endBridgeWrite = (sessionId: string) => {
		const next = (bridgeInFlight.get(sessionId) ?? 1) - 1;
		if (next <= 0) bridgeInFlight.delete(sessionId);
		else bridgeInFlight.set(sessionId, next);
	};
	const sdkWrite = async <T>(block: () => Promise<T>): Promise<T> => {
		if (coordinator) coordinator.sdkInFlight += 1;
		try {
			return await block();
		} finally {
			if (coordinator) coordinator.sdkInFlight -= 1;
		}
	};
	let localModeSwitchInFlight = false;
	const modeSwitchInFlight = () => coordinator?.switching ?? localModeSwitchInFlight;
	const bridgeSubscriptions = new Map<string, { stop: () => void }>();
	const stopBridgeSubscription = (sessionId: string) => {
		bridgeSubscriptions.get(sessionId)?.stop();
		bridgeSubscriptions.delete(sessionId);
	};
	const releaseSdkSubscriptions = () => {
		for (const sessionId of [...subscriptions]) {
			runtime.unsubscribe(sessionId, send);
			subscriptions.delete(sessionId);
			send({ kind: "unsubscribed", sessionId, reason: "host-mode-changed" });
		}
	};
	const connectionControl: HostModeConnectionControl = {
		stopBridgeSubscriptions: () => {
			for (const sessionId of [...bridgeSubscriptions.keys()]) {
				stopBridgeSubscription(sessionId);
				send({ kind: "unsubscribed", sessionId, reason: "host-mode-changed" });
			}
		},
		releaseSdkSubscriptions,
	};
	coordinator?.connections.add(connectionControl);
	const bridgeSnapshotFrame = (sessionId: string, snapshot: BridgeSnapshot): Record<string, unknown> => ({
		kind: "bridge-snapshot",
		sessionId,
		schema: snapshot.schema,
		extensionVersion: snapshot.extensionVersion,
		instanceId: snapshot.instanceId,
		epoch: snapshot.epoch,
		pid: snapshot.pid,
		bridgeSeq: snapshot.seq,
		busy: snapshot.busy,
		...(snapshot.isCompacting !== undefined
			? {
					isCompacting: snapshot.isCompacting,
					isStreaming: snapshot.busy && !snapshot.isCompacting,
					contextUsage: snapshot.contextUsage ?? null,
				}
			: {}),
		pending: snapshot.pending,
		leafId: snapshot.leafId,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		editor: snapshot.editor,
		partial: snapshot.partial ?? null,
		tools: snapshot.tools,
	});
	/** 桥接实时事件与 SDK 线格式同一套单帧预算：图片 base64 换成占位、超长文本截断，
	 * 仍超预算才换成 stub。风险是条件性的：若超大帧把 8 MiB 出站背压推到断线，
	 * 紧随其后的 agent_settled 可能到不了手机（Working 只能等重连才清）。这是
	 * 按背压机理推得的候选解释，尚未在真机现场抓到证据，不作为已证根因。 */
	const budgetedBridgeEvent = (event: unknown): unknown => {
		const budget = shrinkForWire(event, WIRE_EVENT_MAX_BYTES);
		if (budget.bytes <= WIRE_EVENT_MAX_BYTES) return budget.value;
		return oversizedEventStub((event as { type?: unknown } | null | undefined)?.type, budget.bytes);
	};
	const bridgeIdentityMismatch = (frame: Record<string, unknown>, descriptor: BridgeDescriptor): boolean => {
		const instanceId = asString(frame, "instanceId");
		const epoch = asString(frame, "epoch");
		// 旧客户端不带身份时仍可写入；带了就必须与当前实例/代际一致，
		// 不能把旧界面的迟到写请求悄悄投给新实例。
		return (
			(instanceId !== undefined && instanceId !== descriptor.instanceId) ||
			(epoch !== undefined && epoch !== descriptor.epoch)
		);
	};
	const handleBridgeModels = async (frame: Record<string, unknown>, write: boolean) => {
		const sessionId = asString(frame, "sessionId");
		const requestType = write ? String(frame.type) : "models";
		const token = asString(frame, write ? "operationId" : "queryId");
		const binding = {
			sessionId,
			...(write ? { operationId: token } : { queryId: token }),
			instanceId: frame.nativeRead === true || frame.nativeResume === true ? undefined : asString(frame, "instanceId"),
			epoch: frame.nativeRead === true || frame.nativeResume === true ? undefined : asString(frame, "epoch"),
		};
		const fail = (code: string) =>
			send({
				...errorFrame(code, "模型操作未完成", requestType, sessionId),
				...binding,
				...(frame.nativeRead === true ? { nativeRead: true } : {}),
			});
		if (!write && frame.nativeRead === true) {
			if (
				!token ||
				token.length > 128 ||
				frame.instanceId !== undefined ||
				frame.epoch !== undefined ||
				frame.nativeResume === true
			) {
				fail("bad-request");
				return;
			}
			if (modeSwitchInFlight()) {
				fail("mode-switch-blocked");
				return;
			}
			try {
				// 首次订阅尚未建立手机身份时，在线CLI仍必须使用自己的scope。
				const live = sessionId ? bridge?.descriptor(sessionId) : undefined;
				const groups = live ? (await bridge?.models(live))?.groups : await runtime.listModels();
				if (!Array.isArray(groups)) {
					fail("bridge-unavailable");
					return;
				}
				const latest = sessionId ? bridge?.descriptor(sessionId) : undefined;
				if (latest?.instanceId !== live?.instanceId || latest?.epoch !== live?.epoch) {
					fail("bridge-stale-runtime");
					return;
				}
				if (!bridgeMode() || modeSwitchInFlight()) {
					fail("mode-switch-blocked");
					return;
				}
				send({ kind: "models", sessionId, queryId: token, nativeRead: true, groups });
			} catch {
				fail("bridge-unavailable");
			}
			return;
		}
		const resume = write && requestType === "set-model" && frame.nativeResume === true;
		if (
			!sessionId ||
			!token ||
			token.length > 128 ||
			(resume
				? frame.instanceId !== undefined || frame.epoch !== undefined || !readModelSelection(frame)
				: !binding.instanceId || !binding.epoch)
		) {
			fail("bad-request");
			return;
		}
		if (modeSwitchInFlight()) {
			fail("mode-switch-blocked");
			return;
		}
		if (!bridge) {
			fail("bridge-unavailable");
			return;
		}
		let descriptor = bridge.descriptor(sessionId);
		if (!resume && !descriptor) {
			fail("bridge-offline");
			return;
		}
		if (!resume && descriptor && bridgeIdentityMismatch(frame, descriptor)) {
			fail("bridge-stale-runtime");
			return;
		}
		beginBridgeWrite(sessionId);
		try {
			if (resume) {
				descriptor = await resumeBridgeControl(frame);
				binding.instanceId = descriptor.instanceId;
				binding.epoch = descriptor.epoch;
			}
			if (!descriptor) {
				fail("bridge-offline");
				return;
			}
			if (!write) {
				const result = await bridge.models(descriptor);
				if (!Array.isArray(result.groups)) {
					fail("bridge-unavailable");
					return;
				}
				send({ kind: "models", ...binding, groups: result.groups });
			} else if (requestType === "refresh-model") {
				const result = await bridge.refreshModel(descriptor, token);
				const state = result.snapshot ?? (await bridge.snapshot(descriptor));
				send({
					kind: "model-refreshed",
					...binding,
					model: result.model,
					thinkingLevel: result.thinkingLevel,
					isStreaming: state.busy && state.isCompacting !== true,
					isCompacting: state.isCompacting === true,
					pendingMessages: state.pending,
					contextUsage: state.contextUsage ?? null,
					queuedMessages: { steering: [], followUp: [] },
				});
			} else {
				const provider = asString(frame, "provider");
				const modelId = asString(frame, "modelId");
				if (
					!provider ||
					!modelId ||
					(frame.thinkingLevel !== undefined &&
						(typeof frame.thinkingLevel !== "string" ||
							!THINKING_LEVELS.includes(frame.thinkingLevel as (typeof THINKING_LEVELS)[number])))
				) {
					fail("bad-request");
					return;
				}
				const result = await bridge.setModel(descriptor, {
					operationId: token,
					provider,
					modelId,
					...(typeof frame.thinkingLevel === "string" ? { thinkingLevel: frame.thinkingLevel } : {}),
				});
				send({
					kind: "model-set",
					...binding,
					model: result.model,
					thinkingLevel: result.thinkingLevel,
					isStreaming: result.busy === true && result.snapshot?.isCompacting !== true,
					isCompacting: result.snapshot?.isCompacting === true,
					pendingMessages: result.pending === true,
					contextUsage: result.snapshot?.contextUsage ?? null,
					queuedMessages: { steering: [], followUp: [] },
				});
			}
		} catch (error) {
			fail(
				error instanceof WorktreeError
					? error.code
					: error instanceof BridgeRequestError
						? bridgeErrorCode(error.code)
						: write
							? "model-change-unconfirmed"
							: "bridge-unavailable",
			);
		} finally {
			endBridgeWrite(sessionId);
		}
	};

	const requireNativeWorkspaces = () => {
		if (modeSwitchInFlight()) throw new WorktreeError("mode-switch-blocked");
		if (!options.bridgeWorkspaces) throw new WorktreeError("bridge-unavailable");
		return options.bridgeWorkspaces;
	};
	// 明确的会话写意图复用原SID的启动日志与信任门槛；读查询不走这里。
	const resumeBridgeControl = async (frame: Record<string, unknown>): Promise<BridgeDescriptor> => {
		const sessionId = asString(frame, "sessionId"),
			operationId = asString(frame, "operationId");
		if (!sessionId || !operationId || frame.instanceId !== undefined || frame.epoch !== undefined)
			throw new WorktreeError("bad-request");
		if (coordinator) coordinator.launchInFlight += 1;
		try {
			const item = (await runtime.listSessions()).find((item) => item.id === sessionId);
			if (!item?.path || !item.cwd) throw new WorktreeError("session-not-found");
			const resumed = await requireNativeWorkspaces().resume(operationId, {
				id: sessionId,
				path: item.path,
				cwd: item.cwd,
			});
			if (!bridgeMode() || modeSwitchInFlight()) throw new WorktreeError("mode-switch-blocked");
			if (!(await startBridgeSubscription(sessionId, resumed))) throw new WorktreeError("native-start-unconfirmed");
			return resumed;
		} finally {
			if (coordinator) coordinator.launchInFlight -= 1;
		}
	};
	const requireBridgeWorkspace = (frame: Record<string, unknown>) => {
		requireNativeWorkspaces();
		const id = asString(frame, "sessionId");
		if (!id || !asString(frame, "instanceId") || !asString(frame, "epoch")) throw new WorktreeError("bad-request");
		const descriptor = bridge?.descriptor(id);
		if (!descriptor) throw new WorktreeError("bridge-offline");
		if (bridgeIdentityMismatch(frame, descriptor)) throw new WorktreeError("bridge-stale-runtime");
		return descriptor;
	};
	const nativeWorkspaceFork = async (frame: Record<string, unknown>, op: string, id: string, target: string) => {
		const descriptor = requireBridgeWorkspace(frame);
		beginBridgeWrite(id);
		if (coordinator) coordinator.launchInFlight += 1;
		try {
			return await requireNativeWorkspaces().fork(
				op,
				descriptor,
				target,
				frame.trustProject === true,
				frame.retry === true,
			);
		} finally {
			endBridgeWrite(id);
			if (coordinator) coordinator.launchInFlight -= 1;
		}
	};
	const handleBridgeTree = async (frame: Record<string, unknown>) => {
		const type = String(frame.type) as "tree" | "entry-copy" | "label-put" | "name" | "switch-branch";
		const sessionId = asString(frame, "sessionId"),
			operationId = asString(frame, "operationId");
		const entryId = asString(frame, "entryId");
		const binding = {
			sessionId,
			operationId,
			instanceId: frame.nativeRead === true || frame.nativeResume === true ? undefined : asString(frame, "instanceId"),
			epoch: frame.nativeRead === true || frame.nativeResume === true ? undefined : asString(frame, "epoch"),
			...(entryId ? { entryId } : {}),
		};
		const fileRead = frame.nativeRead === true && (type === "tree" || type === "entry-copy");
		const resume = frame.nativeResume === true && ["label-put", "switch-branch", "name"].includes(type);
		const fail = (code: string) =>
			send({
				...errorFrame(code, "会话操作未完成", type, sessionId),
				...binding,
				...(fileRead ? { nativeRead: true } : {}),
			});
		if (
			!sessionId ||
			!operationId ||
			operationId.length > 128 ||
			(fileRead || resume
				? frame.instanceId !== undefined || frame.epoch !== undefined
				: !binding.instanceId || !binding.epoch) ||
			(frame.nativeRead === true && !fileRead) ||
			(frame.nativeResume === true && !resume) ||
			(["entry-copy", "label-put", "switch-branch"].includes(type) && (!entryId || entryId.length > 256))
		) {
			fail("bad-request");
			return;
		}
		if (modeSwitchInFlight()) {
			fail("mode-switch-blocked");
			return;
		}
		if (!bridge) {
			fail("bridge-unavailable");
			return;
		}
		let descriptor = bridge.descriptor(sessionId);
		if (!fileRead && !resume && !descriptor) {
			fail("bridge-offline");
			return;
		}
		if (!fileRead && !resume && descriptor && bridgeIdentityMismatch(frame, descriptor)) {
			fail("bridge-stale-runtime");
			return;
		}
		const view = type === "tree" && frame.view !== undefined ? readTreeView(frame.view) : undefined;
		if (view === null) {
			fail("bad-request");
			return;
		}
		const normalized = type === "label-put" ? normalizeLabelValue(frame.label) : undefined;
		if (normalized === null) {
			fail("bad-request");
			return;
		}
		const name = asString(frame, "name");
		if (type === "name" && (!name?.trim() || name.length > 200)) {
			fail("bad-request");
			return;
		}
		beginBridgeWrite(sessionId);
		try {
			if (fileRead) {
				const result =
					type === "tree"
						? await runtime.tree(sessionId, view, true)
						: await runtime.entryCopy(sessionId, entryId ?? "", true);
				send({ kind: type, ...binding, ...result, nativeRead: true, ...(view ? { view } : {}) });
				return;
			}
			if (resume) {
				descriptor = await resumeBridgeControl(frame);
				binding.instanceId = descriptor.instanceId;
				binding.epoch = descriptor.epoch;
			}
			if (!descriptor) {
				fail("bridge-offline");
				return;
			}
			const result = await bridge.treeControl(descriptor, type, {
				operationId,
				...(entryId ? { entryId } : {}),
				...(type === "label-put" ? { label: normalized?.label ?? null } : {}),
				...(type === "name" ? { name } : {}),
			});
			if (type === "tree") {
				if (!Array.isArray(result.tree)) {
					fail("bridge-unavailable");
					return;
				}
				const byId = new Map<string, PiTreeNode>();
				for (const item of result.tree) {
					const entry = item.entry as unknown as SessionEntry;
					if (!entry || typeof entry.id !== "string") {
						fail("bridge-unavailable");
						return;
					}
					byId.set(entry.id, {
						entry,
						children: [],
						...(item.label !== undefined ? { label: item.label, labelTimestamp: item.labelTimestamp } : {}),
					});
				}
				const roots: PiTreeNode[] = [];
				for (const node of byId.values()) {
					const parent = node.entry.parentId ? byId.get(node.entry.parentId) : undefined;
					if (parent) parent.children.push(node);
					else roots.push(node);
				}
				const leafId = result.leafId ?? null,
					projected = toWireTreeNodes(roots, leafId, view);
				const nodes = view ? projected : trimTreeNodes(projected, 400),
					visible = new Set(nodes.map((node) => node.id));
				let selectedId = leafId;
				while (selectedId !== null && !visible.has(selectedId))
					selectedId = byId.get(selectedId)?.entry.parentId ?? null;
				selectedId ??= nodes.at(-1)?.id ?? null;
				send({ kind: "tree", ...binding, leafId, nodes, ...(view ? { view, selectedId } : {}) });
				return;
			}
			const state = result.snapshot;
			const stateFields = state
				? {
						isStreaming: state.busy && !state.isCompacting,
						isCompacting: state.isCompacting === true,
						pendingMessages: state.pending,
						contextUsage: state.contextUsage ?? null,
						leafId: state.leafId,
						model: state.model,
						thinkingLevel: state.thinkingLevel,
						queuedMessages: { steering: [], followUp: [] },
					}
				: {};
			if (type === "entry-copy")
				send({ kind: "entry-copy", ...binding, text: result.text, bytes: result.bytes, oversized: result.oversized });
			else if (type === "label-put")
				send({
					kind: "label-put",
					...binding,
					label: result.label,
					labelEntryId: result.labelEntryId,
					leafId: result.leafId,
				});
			else if (type === "name") send({ kind: "session-named", ...binding, name: result.name });
			else
				send({
					kind: "branch-switched",
					...binding,
					...stateFields,
					entryId: result.entryId,
					editorText: result.editorText,
					alreadyAt: result.alreadyAt,
					queued: [],
				});
		} catch (error) {
			fail(
				error instanceof WorktreeError
					? error.code
					: error instanceof SessionNotFoundError
						? "session-not-found"
						: error instanceof EntryNotFoundError
							? "entry-not-found"
							: error instanceof EntryCopyEmptyError
								? "entry-copy-empty"
								: error instanceof BridgeRequestError
									? bridgeErrorCode(error.code)
									: "bridge-offline",
			);
		} finally {
			endBridgeWrite(sessionId);
		}
	};

	/**
	 * 桥接订阅：一次连接接收 snapshot + 事件；reload 由扩展关闭旧 socket 后，
	 * 用注册表里的新 epoch 直接重连。进程退出时有限重试后下发 bridge-offline，
	 * 不用 socket 不可达推断死亡。
	 */
	const startBridgeSubscription = (sessionId: string, initial: BridgeDescriptor) => {
		stopBridgeSubscription(sessionId);
		let complete = (_ok: boolean) => {};
		const ready = new Promise<boolean>((resolve) => {
			complete = resolve;
		});
		const readyTimer = setTimeout(() => complete(false), 8_000);
		readyTimer.unref();
		const state = { closed: false, detach: null as (() => void) | null, seq: 0 };
		const stop = () => {
			state.closed = true;
			clearTimeout(readyTimer);
			complete(false);
			state.detach?.();
			state.detach = null;
		};
		bridgeSubscriptions.set(sessionId, { stop });
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const run = async (start: BridgeDescriptor) => {
			let current = start;
			let missing = 0;
			while (!state.closed) {
				let closeResolve: (() => void) | null = null;
				const closed = new Promise<void>((resolve) => {
					closeResolve = resolve;
				});
				try {
					const detach = await bridge?.subscribe(current, {
						onSnapshot: (snapshot) => {
							if (state.closed) return;
							missing = 0;
							state.seq = 0;
							send(bridgeSnapshotFrame(sessionId, snapshot));
							clearTimeout(readyTimer);
							complete(true);
						},
						onEvent: (frame) => {
							if (state.closed) return;
							state.seq += 1;
							send({
								kind: "event",
								sessionId,
								seq: state.seq,
								time: Date.now() / 1000,
								instanceId: frame.instanceId,
								epoch: frame.epoch,
								bridgeSeq: frame.seq,
								...(typeof frame.entryId === "string" ? { entryId: frame.entryId } : {}),
								...(frame.isCompacting !== undefined
									? {
											isCompacting: frame.isCompacting,
											isStreaming: frame.isStreaming,
											contextUsage: frame.contextUsage ?? null,
										}
									: {}),
								event: budgetedBridgeEvent(frame.event),
							});
						},
						onClose: () => closeResolve?.(),
					});
					if (!detach) throw new BridgeUnavailableError("bridge unavailable");
					// unsubscribe/断连可能发生在建连窗口内：此时 stop() 还没看到 detach，
					// 这里必须自己关掉，避免 socket 与监听泄漏。
					if (state.closed) {
						detach();
						return;
					}
					state.detach = detach;
					await closed;
					state.detach = null;
				} catch {
					// socket 建立失败与中途关闭都按一次断链处理。
				}
				if (state.closed) return;
				const next = bridge?.descriptor(sessionId);
				if (next && next.epoch !== current.epoch) {
					current = next;
					missing = 0;
					continue;
				}
				missing += 1;
				if (missing > 20) {
					send({
						kind: "bridge-offline",
						sessionId,
						instanceId: current.instanceId,
						epoch: current.epoch,
						reason: "process-exited",
					});
					return;
				}
				await sleep(250);
				const retry = bridge?.descriptor(sessionId);
				if (retry) current = retry;
			}
		};
		void run(initial);
		return ready;
	};
	const bridgeSwitchBlockers = async (): Promise<string[]> => {
		const reasons: string[] = [];
		try {
			const items = await runtime.listSessions();
			if (items.some((item) => item.running)) reasons.push("running");
		} catch {
			// 读不到索引就无法证明没有 SDK 运行；按未知处理，不能放行切换。
			reasons.push("owner-unknown");
		}
		// 在途写不依赖描述符仍存在：实例刚退出时也要阻止切换，等失败结算。
		for (const sessionId of bridgeInFlight.keys()) {
			if ((bridgeInFlight.get(sessionId) ?? 0) > 0) reasons.push("in-flight");
		}
		// SDK openSession/prompt 在 running 索引更新前也可能尚未反映；同一宿主范围
		// 内任何连接有在途 SDK 写都不能切到 bridge。
		if ((coordinator?.sdkInFlight ?? 0) > 0) reasons.push("in-flight");
		// bridge-start 在描述符注册前有最长 20s 窗口；期间切到 sdk 会与随后
		// claim owner 的原生实例形成双写者，必须按在途处理。
		if ((coordinator?.launchInFlight ?? 0) > 0) reasons.push("in-flight");
		for (const descriptor of bridge?.descriptors() ?? []) {
			try {
				const snapshot = await bridge?.snapshot(descriptor);
				if (snapshot?.busy) reasons.push("running");
				if (snapshot?.pending) reasons.push("pending");
				if (snapshot?.controlPending) reasons.push("in-flight");
			} catch {
				// 快照失败只说明“状态未知”，不能当作离线/空闲放行切换。
				reasons.push("owner-unknown");
			}
		}
		return [...new Set(reasons)];
	};

	const handleMessage = async (frame: Record<string, unknown>): Promise<void> => {
		const requestType = typeof frame.type === "string" ? frame.type : "query";
		try {
			if (
				(frame.nativeRead !== undefined && typeof frame.nativeRead !== "boolean") ||
				(frame.nativeResume === true &&
					!["message", "set-model", "label-put", "switch-branch", "name"].includes(requestType)) ||
				(frame.nativeRead === true && !["models", "tree", "entry-copy"].includes(requestType))
			)
				throw new WorktreeError("bad-request");
			if (!bridgeMode() && (frame.nativeRead === true || frame.nativeResume === true))
				throw new WorktreeError("mode-switch-blocked");
			// 桥接模式下网关不为原生会话创建 SDK 句柄，也不改写其会话文件；
			// 需要句柄的写/读操作统一拒绝，安全边界不交给客户端隐藏入口。
			if (bridgeMode() && ["tree", "entry-copy", "label-put", "name", "switch-branch"].includes(requestType)) {
				await handleBridgeTree(frame);
				return;
			}
			if (bridgeMode() && BRIDGE_UNSUPPORTED_FRAMES.has(requestType)) {
				send(
					errorFrame(
						"bridge-unavailable",
						"operation is not available in bridge mode",
						requestType,
						asString(frame, "sessionId"),
					),
				);
				return;
			}
			if (
				!bridgeMode() &&
				(frame.nativeNew === true ||
					frame.nativeResume === true ||
					(["worktree-list", "worktree-continue"].includes(requestType) &&
						(frame.instanceId !== undefined || frame.epoch !== undefined)))
			)
				throw new WorktreeError("mode-switch-blocked");
			switch (frame.type) {
				case "input-resources":
				case "input-completions":
					await inputAssist.handle(frame);
					return;
				case "worktree-list": {
					const native = bridgeMode();
					const queryId = asString(frame, "queryId");
					const cwd = asString(frame, "cwd");
					const sessionId = asString(frame, "sessionId");
					if (!queryId || queryId.length > 128 || !!cwd === !!sessionId)
						throw new WorktreeError("worktree-path-invalid");
					send({
						kind: "worktree-list",
						queryId,
						...(sessionId ? { sessionId } : {}),
						...(native && sessionId
							? await listWorktrees(requireBridgeWorkspace(frame).cwd)
							: await runtime.worktreeList(cwd, sessionId)),
						...(native && sessionId ? { instanceId: frame.instanceId, epoch: frame.epoch } : {}),
					});
					return;
				}
				case "worktree-create": {
					const operationId = asString(frame, "operationId");
					const cwd = asString(frame, "cwd");
					const branch = asString(frame, "branch");
					const base = asString(frame, "base");
					const targetPath = asString(frame, "targetPath");
					if (!operationId || !cwd || !branch || !base || !targetPath) throw new WorktreeError("worktree-path-invalid");
					send({
						kind: "worktree-operation",
						...(await (bridgeMode()
							? requireNativeWorkspaces().create(operationId, cwd, branch, base, targetPath)
							: runtime.worktreeCreate(operationId, cwd, branch, base, targetPath))),
					});
					return;
				}
				case "worktree-continue": {
					const native = bridgeMode();
					const operationId = asString(frame, "operationId");
					const sessionId = asString(frame, "sessionId");
					const targetPath = asString(frame, "targetPath");
					if (!operationId || !sessionId || !targetPath) throw new WorktreeError("worktree-path-invalid");
					send({
						kind: "worktree-operation",
						...(await (bridgeMode()
							? nativeWorkspaceFork(frame, operationId, sessionId, targetPath)
							: runtime.continueWorkspace(
									operationId,
									sessionId,
									targetPath,
									frame.trustProject === true,
									frame.retry === true,
								))),
						...(native ? { instanceId: frame.instanceId, epoch: frame.epoch } : {}),
					});
					return;
				}
				case "worktree-trust": {
					const operationId = asString(frame, "operationId");
					const targetPath = asString(frame, "targetPath");
					if (!operationId || operationId.length > 128 || !targetPath) throw new WorktreeError("worktree-path-invalid");
					send({
						kind: "worktree-trust",
						operationId,
						cwd: runtime.worktreeTrust(targetPath, frame.trustProject === true),
					});
					return;
				}
				case "worktree-status": {
					const operationId = asString(frame, "operationId");
					if (!operationId) throw new WorktreeError("worktree-operation-invalid");
					send({
						kind: "worktree-operation",
						...(await (bridgeMode()
							? requireNativeWorkspaces().status(operationId)
							: runtime.worktreeStatus(operationId))),
					});
					return;
				}
				case "sessions": {
					const items = await runtime.listSessions();
					if (!bridgeMode() || !bridge) {
						send({ kind: "sessions", items });
						return;
					}
					// 磁盘历史与在线实例按真实 sessionId 合并成一个条目；在线实例的
					// busy 用快照判定，不只依赖网关自己的 SDK handle。
					const descriptors = bridge.descriptors();
					const states = await Promise.all(
						descriptors.map(async (descriptor) => {
							try {
								return [descriptor.sessionId, await bridge.snapshot(descriptor)] as const;
							} catch {
								return [descriptor.sessionId, null] as const;
							}
						}),
					);
					const stateById = new Map(states);
					// 首载或重连时也要明确离线；缺字段会让客户端保留 unknown 并隐藏启动入口。
					const merged: Array<Record<string, unknown>> = items.map((item) => ({ ...item, online: false }));
					for (const descriptor of descriptors) {
						const snapshot = stateById.get(descriptor.sessionId);
						const runtimeRef = { instanceId: descriptor.instanceId, epoch: descriptor.epoch, pid: descriptor.pid };
						const existing = merged.find((item) => item.id === descriptor.sessionId);
						if (existing) {
							existing.source = "bridge";
							existing.online = true;
							existing.runtime = runtimeRef;
							existing.running = snapshot?.busy === true;
							continue;
						}
						// 描述符由扩展写入，时间字段可能被手工或旧版本写坏；
						// 无效时间退回当前时刻，不让整帧 sessions 失败。
						const started = new Date(descriptor.startedAt);
						const startedIso = Number.isNaN(started.getTime()) ? new Date().toISOString() : started.toISOString();
						merged.unshift({
							id: descriptor.sessionId,
							// 只有在线实例、没有磁盘索引的条目不给手机回宿主绝对路径；
							// 该会话本来就没有可浏览的文件位置。
							path: "",
							cwd: descriptor.cwd,
							name: null,
							created: startedIso,
							modified: startedIso,
							messageCount: 0,
							firstMessage: "",
							running: snapshot?.busy === true,
							source: "bridge",
							online: true,
							runtime: runtimeRef,
						});
					}
					send({ kind: "sessions", items: merged, mode: "bridge" });
					return;
				}

				case "host-mode": {
					send({ kind: "host-mode", mode: hostModeStore?.read() ?? "sdk", switchable: true });
					return;
				}

				case "host-mode-put": {
					const target = frame.mode;
					if (target !== "sdk" && target !== "bridge") {
						send(errorFrame("bad-request", 'host mode must be "sdk" or "bridge"', "host-mode-put"));
						return;
					}
					const current: HostMode = hostModeStore?.read() ?? "sdk";
					if (!hostModeStore) {
						send(errorFrame("bridge-unavailable", "host mode is not configurable", "host-mode-put"));
						return;
					}
					if (modeSwitchInFlight()) {
						send({
							...errorFrame("mode-switch-blocked", "mode switch already in progress", "host-mode-put"),
							reasons: ["switching"],
						});
						return;
					}
					if (target !== current) {
						if (coordinator) coordinator.switching = true;
						else localModeSwitchInFlight = true;
						try {
							const blockers = await bridgeSwitchBlockers();
							if (blockers.length > 0) {
								send({
									...errorFrame("mode-switch-blocked", `mode switch blocked: ${blockers.join(",")}`, "host-mode-put"),
									reasons: blockers,
								});
								return;
							}
							hostModeStore.write(target);
							// 切换后旧模式订阅必须在所有连接上释放：否则旧桥接事件会混进
							// 新 SDK 模式，或旧 SDK handle 继续占用原生会话。
							if (coordinator) {
								for (const connection of coordinator.connections) {
									if (target === "sdk") connection.stopBridgeSubscriptions();
									else connection.releaseSdkSubscriptions();
								}
							} else if (target === "sdk") {
								for (const sessionId of [...bridgeSubscriptions.keys()]) {
									stopBridgeSubscription(sessionId);
									send({ kind: "unsubscribed", sessionId, reason: "host-mode-changed" });
								}
							} else {
								for (const sessionId of [...subscriptions]) {
									runtime.unsubscribe(sessionId, send);
									subscriptions.delete(sessionId);
									send({ kind: "unsubscribed", sessionId, reason: "host-mode-changed" });
								}
							}
						} finally {
							if (coordinator) coordinator.switching = false;
							else localModeSwitchInFlight = false;
						}
					}
					send({ kind: "host-mode", mode: target, switchable: true, changed: target !== current });
					return;
				}

				case "bridge-start": {
					const sessionId = asString(frame, "sessionId");
					const operationId = asString(frame, "operationId");
					if (!sessionId || !operationId || operationId.length > 128) {
						send(
							errorFrame("bad-request", "bridge-start requires sessionId and operationId", "bridge-start", sessionId),
						);
						return;
					}
					if (!bridgeMode() || !options.bridgeLauncher) {
						send(errorFrame("bridge-unavailable", "bridge start is not available", "bridge-start", sessionId));
						return;
					}
					if (modeSwitchInFlight()) {
						send(errorFrame("mode-switch-blocked", "mode switch is in progress", "bridge-start", sessionId));
						return;
					}
					// 从读取会话列表起就有启动意图；否则 listSessions 的 await 窗口仍可被
					// 切换穿插，随后在 sdk 模式下启动原生实例形成双写者。
					if (coordinator) coordinator.launchInFlight += 1;
					try {
						const item = (await runtime.listSessions()).find((session) => session.id === sessionId);
						if (!item?.path || !item.cwd) {
							send(bridgeStartError("session-not-found", "session is not readable", sessionId, operationId));
							return;
						}
						if (modeSwitchInFlight() || !bridgeMode()) {
							send(errorFrame("mode-switch-blocked", "mode switch is in progress", "bridge-start", sessionId));
							return;
						}
						const result = await options.bridgeLauncher.launch({
							operationId,
							sessionId,
							sessionFile: item.path,
							cwd: item.cwd,
						});
						send({
							kind: "bridge-started",
							operationId,
							...result,
							requestType: "bridge-start",
						});
					} catch (error) {
						if (error instanceof BridgeLaunchError) {
							send(bridgeStartError(error.code, error.message, sessionId, operationId));
							return;
						}
						log(`bridge start failed: ${error instanceof Error ? error.message : String(error)}`);
						send(bridgeStartError("bridge-start-failed", "无法启动后台 pi", sessionId, operationId));
					} finally {
						if (coordinator) coordinator.launchInFlight -= 1;
					}
					return;
				}

				case "subscribe": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "subscribe requires a sessionId", "subscribe"));
						return;
					}
					if (bridgeMode()) {
						if (!bridge) {
							send(errorFrame("bridge-unavailable", "bridge hub is not configured", "subscribe", sessionId));
							return;
						}
						if (modeSwitchInFlight()) {
							send(errorFrame("mode-switch-blocked", "mode switch is in progress", "subscribe", sessionId));
							return;
						}
						const descriptor = bridge.descriptor(sessionId);
						send({ kind: "subscribed", sessionId, bridge: true });
						if (!descriptor) {
							send({ kind: "bridge-offline", sessionId, reason: "no-instance" });
							return;
						}
						startBridgeSubscription(sessionId, descriptor);
						return;
					}
					// openSession 也要计入 SDK 在途：它可能打开会话句柄，且在 await 期间
					// 若发生模式切换，订阅会在 releaseSdkSubscriptions 之后才挂上。
					if (modeSwitchInFlight()) {
						send(errorFrame("mode-switch-blocked", "mode switch is in progress", "subscribe", sessionId));
						return;
					}
					const handle = await sdkWrite(() => runtime.openSession(sessionId));
					subscribe(sessionId, handle);
					// 订阅确认同时下发扩展状态快照（PROTOCOL §4.29）：重连后不必
					// 等下一次 setStatus 才恢复“有 agent 在跑”的提示。
					send({ kind: "subscribed", sessionId, statuses: runtime.extensionStatuses(sessionId) });
					return;
				}

				case "unsubscribe": {
					const sessionId = asString(frame, "sessionId");
					if (!sessionId) {
						send(errorFrame("bad-request", "unsubscribe requires a sessionId", "unsubscribe"));
						return;
					}
					subscriptions.delete(sessionId);
					stopBridgeSubscription(sessionId);
					runtime.unsubscribe(sessionId, send);
					send({ kind: "unsubscribed", sessionId });
					return;
				}

				case "operation-status": {
					const sessionId = asString(frame, "sessionId");
					const operationId = asString(frame, "operationId");
					if (!sessionId || !operationId || operationId.length > 128) {
						send({
							...errorFrame(
								"bad-request",
								"operation-status requires sessionId and operationId",
								"operation-status",
								sessionId,
							),
							...(operationId ? { operationId } : {}),
						});
						return;
					}
					if (!bridgeMode() || !bridge) {
						send({
							...errorFrame(
								"bridge-unavailable",
								"operation status is only available in bridge mode",
								"operation-status",
								sessionId,
							),
							operationId,
						});
						return;
					}
					const descriptor = bridge.descriptor(sessionId);
					if (!descriptor) {
						send({
							...errorFrame("bridge-offline", "native pi instance is offline", "operation-status", sessionId),
							operationId,
						});
						return;
					}
					// 收据属于原 instance/epoch；旧界面迟到的对账不能查新实例的
					// 操作表，否则会把同名 operationId 的旧记录当成当前提交。
					if (bridgeIdentityMismatch(frame, descriptor)) {
						send({
							...errorFrame("bridge-stale-runtime", "native pi instance changed", "operation-status", sessionId),
							operationId,
						});
						return;
					}
					try {
						const reply = await bridge.operationStatus(descriptor, operationId);
						send({
							kind: "operation-status",
							sessionId,
							operationId,
							status: reply.status ?? "unknown",
							...(reply.code ? { code: bridgeErrorCode(reply.code) } : {}),
						});
					} catch (error) {
						send({
							...(error instanceof BridgeRequestError
								? errorFrame(bridgeErrorCode(error.code), bridgeErrorMessage(error.code), "operation-status", sessionId)
								: errorFrame("bridge-offline", "native pi instance is offline", "operation-status", sessionId)),
							operationId,
						});
					}
					return;
				}

				case "message": {
					let sessionId = asString(frame, "sessionId");
					const requestedOperationId = asOptionalString(frame.operationId);
					let requestedIdentity = {
						...(requestedOperationId ? { operationId: requestedOperationId } : {}),
						...(asOptionalString(frame.instanceId) ? { instanceId: asOptionalString(frame.instanceId) } : {}),
						...(asOptionalString(frame.epoch) ? { epoch: asOptionalString(frame.epoch) } : {}),
					};
					const cwd = asString(frame, "cwd");
					const rawText = frame.text;
					const text = typeof rawText === "string" ? rawText : "";
					const imageAttachments = readImageAttachments(frame.images);
					if (imageAttachments === null) {
						send({
							...errorFrame(
								"bad-request",
								`message images must be at most ${MAXIMUM_MESSAGE_IMAGES} {type:"image", data, mimeType} entries`,
								"message",
								sessionId,
							),
							...requestedIdentity,
						});
						return;
					}
					// 纯图消息合法：text 可为空，但 text 与 images 不能全空。
					if (text.trim() === "" && imageAttachments.length === 0) {
						send({
							...errorFrame(
								"bad-request",
								"message requires non-empty text or at least one image",
								"message",
								sessionId,
							),
							...requestedIdentity,
						});
						return;
					}
					if (sessionId && cwd) {
						send({
							...errorFrame("bad-request", "message requires sessionId or cwd, not both", "message", sessionId),
							...requestedIdentity,
						});
						return;
					}
					if (!sessionId && !cwd) {
						send({
							...errorFrame("bad-request", "message requires a sessionId (existing) or cwd (new session)", "message"),
							...requestedIdentity,
						});
						return;
					}
					const mode = frame.mode === undefined ? "prompt" : frame.mode;
					if (mode !== "prompt" && mode !== "steer" && mode !== "followUp") {
						send({
							...errorFrame(
								"bad-request",
								'message mode must be "prompt", "steer" or "followUp"',
								"message",
								sessionId,
							),
							...requestedIdentity,
						});
						return;
					}
					if (frame.nativeResume !== undefined && typeof frame.nativeResume !== "boolean")
						throw new WorktreeError("bad-request");
					if (bridgeMode()) {
						if (frame.nativeResume === true) {
							if (
								!sessionId ||
								!requestedOperationId ||
								cwd ||
								frame.nativeNew === true ||
								frame.model !== undefined ||
								frame.instanceId !== undefined ||
								frame.epoch !== undefined
							)
								throw new WorktreeError("bad-request");
							if (modeSwitchInFlight()) throw new WorktreeError("mode-switch-blocked");
							if (coordinator) coordinator.launchInFlight += 1;
							try {
								const live = bridge?.descriptor(sessionId);
								const item = live?.sessionFile
									? { id: sessionId, path: live.sessionFile, cwd: live.cwd }
									: (await runtime.listSessions()).find((item) => item.id === sessionId);
								if (!item?.path || !item.cwd) throw new WorktreeError("session-not-found");
								const resumed = await requireNativeWorkspaces().resume(requestedOperationId, {
									id: sessionId,
									path: item.path,
									cwd: item.cwd,
								});
								if (!bridgeMode() || modeSwitchInFlight()) throw new WorktreeError("mode-switch-blocked");
								if (!(await startBridgeSubscription(sessionId, resumed)))
									throw new WorktreeError("native-start-unconfirmed");
								frame.instanceId = resumed.instanceId;
								frame.epoch = resumed.epoch;
								requestedIdentity = {
									operationId: requestedOperationId,
									instanceId: resumed.instanceId,
									epoch: resumed.epoch,
								};
							} finally {
								if (coordinator) coordinator.launchInFlight -= 1;
							}
						}
						if (!sessionId) {
							if (!requestedOperationId || frame.nativeNew !== true || !cwd) throw new WorktreeError("bad-request");
							const workspaces = requireNativeWorkspaces();
							if (coordinator) coordinator.launchInFlight += 1;
							try {
								const created = await workspaces.newSession(requestedOperationId, cwd);
								if (frame.model !== undefined) {
									const selection = readModelSelection(frame.model);
									if (!selection || !bridge) throw new WorktreeError("bad-request");
									await bridge.setModel(created, { operationId: `preset-${created.sessionId}`, ...selection });
								}
								if (!(await startBridgeSubscription(created.sessionId, created))) {
									stopBridgeSubscription(created.sessionId);
									throw new WorktreeError("worktree-result-unknown");
								}
								sessionId = created.sessionId;
								frame.instanceId = created.instanceId;
								frame.epoch = created.epoch;
								requestedIdentity = {
									operationId: requestedOperationId,
									instanceId: created.instanceId,
									epoch: created.epoch,
								};
								delete frame.model;
							} catch (error) {
								if (error instanceof BridgeRequestError) throw new WorktreeError(bridgeErrorCode(error.code));
								throw error;
							} finally {
								if (coordinator) coordinator.launchInFlight -= 1;
							}
						}
						if (frame.model !== undefined) {
							send({
								...errorFrame(
									"bridge-unavailable",
									"bridge mode does not support model preselection",
									"message",
									sessionId,
								),
								...requestedIdentity,
							});
							return;
						}
						if (modeSwitchInFlight()) {
							send({
								...errorFrame("bridge-unavailable", "mode switch is in progress", "message", sessionId),
								...requestedIdentity,
							});
							return;
						}
						const descriptor = bridge?.descriptor(sessionId);
						if (!descriptor) {
							send({
								...errorFrame("bridge-offline", "native pi instance is offline", "message", sessionId),
								...requestedIdentity,
							});
							return;
						}
						const identity = { instanceId: descriptor.instanceId, epoch: descriptor.epoch };
						if (bridgeIdentityMismatch(frame, descriptor)) {
							send({
								...errorFrame("bridge-stale-runtime", "native pi instance changed", "message", sessionId),
								...identity,
								...(requestedOperationId ? { operationId: requestedOperationId } : {}),
							});
							return;
						}
						const operationId = requestedOperationId ?? `gw-${Math.random().toString(36).slice(2)}`;
						if (operationId.length > 128) {
							send({
								...errorFrame("bad-request", "operationId must be at most 128 characters", "message", sessionId),
								...identity,
							});
							return;
						}
						if (!bridgeSubscriptions.has(sessionId)) startBridgeSubscription(sessionId, descriptor);
						beginBridgeWrite(sessionId);
						try {
							const input = {
								text,
								...(imageAttachments.length > 0 ? { images: imageAttachments } : {}),
								...(mode === "prompt" ? {} : { deliverAs: mode as "steer" | "followUp" }),
							};
							const reply =
								frame.nativeResume === true
									? await requireNativeWorkspaces().submitResumed(operationId, descriptor, input)
									: await bridge?.send(descriptor, { operationId, ...input });
							if (!reply) throw new BridgeUnavailableError("bridge unavailable");
							if (!reply.ok) {
								send({
									...errorFrame(bridgeErrorCode(reply.code), bridgeErrorMessage(reply.code), "message", sessionId),
									operationId,
									...identity,
								});
								return;
							}
							// sendUserMessage 返回 void：这里只到“已提交到运行实例”，
							// 不伪造 disposition started/queued 或完成。附带当前快照，
							// 让客户端按 prompt-disposition-v1 收掉乐观等待。
							const after = await bridge?.snapshot(descriptor).catch(() => null);
							send({
								kind: "sent",
								sessionId,
								mode,
								disposition: "submitted",
								status: "submitted",
								...(frame.nativeResume === true ? { nativeResume: true } : {}),
								// 状态补拉失败不等于压缩结束；提交确认与活动快照分别报告。
								...(after
									? {
											isStreaming: after.busy && after.isCompacting !== true,
											isCompacting: after.isCompacting === true,
											pendingMessages: after.pending,
											bridgeSeq: after.seq,
											contextUsage: after.contextUsage ?? null,
										}
									: {}),
								queuedMessages: { steering: [], followUp: [] },
								operationId,
								instanceId: descriptor.instanceId,
								epoch: descriptor.epoch,
								...(reply.duplicate === true ? { duplicate: true } : {}),
							});
						} catch (error) {
							if (error instanceof WorktreeError) throw error;
							if (error instanceof BridgeRequestError) {
								send({
									...errorFrame(bridgeErrorCode(error.code), bridgeErrorMessage(error.code), "message", sessionId),
									operationId,
									...identity,
								});
								return;
							}
							log(`bridge message failure: ${error instanceof Error ? error.name : "unknown"}`);
							send({
								...errorFrame("bridge-offline", "native pi instance is offline", "message", sessionId),
								operationId,
								...identity,
							});
						} finally {
							endBridgeWrite(sessionId);
						}
						return;
					}
					// 模型预选预校验（对标 pi CLI：resolveCliModel 的 error 在
					// createAgentSession 之前导致 process.exit(1)，不建会话文件）。
					// 结构与"定义存在性"在这里拒绝；auth 等深层校验仍在建会话后
					// 的 setModel（CLI 同类：--model 有效但无 auth → 会话已建、
					// prompt 失败）。
					if (modeSwitchInFlight() || bridgeMode()) {
						send(errorFrame("mode-switch-blocked", "mode switch is in progress", "message", sessionId));
						return;
					}
					await sdkWrite(async () => {
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
					});
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
					if (bridgeMode()) {
						if (modeSwitchInFlight()) {
							send({
								...errorFrame("bridge-unavailable", "mode switch is in progress", "dequeue", sessionId),
								queueRequestId,
							});
							return;
						}
						const descriptor = bridge?.descriptor(sessionId);
						if (!descriptor) {
							send({
								...errorFrame("bridge-offline", "native pi instance is offline", "dequeue", sessionId),
								queueRequestId,
							});
							return;
						}
						if (bridgeIdentityMismatch(frame, descriptor)) {
							send({
								...errorFrame("bridge-stale-runtime", "native pi instance changed", "dequeue", sessionId),
								queueRequestId,
							});
							return;
						}
						beginBridgeWrite(sessionId);
						try {
							const reply = await bridge?.dequeue(descriptor, { operationId: queueRequestId });
							if (!reply) throw new BridgeUnavailableError("bridge unavailable");
							// 与 abort 同型：`src/bridge.ts requireOk()` 会在 `ok:false` 时抛
							// `BridgeRequestError`，实际走下面的 catch；保留本分支只为将来
							// 绕过 requireOk 直连 socket 时两种路径给出一致字段。
							if (!reply.ok) {
								send({
									...errorFrame(bridgeErrorCode(reply.code), bridgeErrorMessage(reply.code), "dequeue", sessionId),
									queueRequestId,
								});
								return;
							}
							// 原生动作整批返回文本，不伪造逐条/图片恢复；客户端整体并入草稿。
							const queuedText = typeof reply.queuedText === "string" ? reply.queuedText : "";
							send({
								kind: "dequeued",
								sessionId,
								queueRequestId,
								queuedText,
								// 兼容 SDK 队列形状：整批文本作为单元素，客户端按整体并入草稿。
								queued: queuedText === "" ? [] : [queuedText],
								queuedMessages: { steering: [], followUp: [] },
								pending: reply.pending === true,
								isStreaming: reply.busy === true && reply.snapshot?.isCompacting !== true,
								isCompacting: reply.snapshot?.isCompacting === true,
							});
						} catch (error) {
							send({
								...errorFrame(
									error instanceof BridgeRequestError ? bridgeErrorCode(error.code) : "bridge-offline",
									error instanceof BridgeRequestError
										? bridgeErrorMessage(error.code)
										: "native pi instance is offline",
									"dequeue",
									sessionId,
								),
								queueRequestId,
							});
						} finally {
							endBridgeWrite(sessionId);
						}
						return;
					}
					if (modeSwitchInFlight()) {
						send(errorFrame("mode-switch-blocked", "mode switch is in progress", "dequeue", sessionId));
						return;
					}
					try {
						await sdkWrite(() =>
							runtime.dequeue(sessionId, (queued, state) => {
								send({ kind: "dequeued", ...state, queued, queueRequestId });
							}),
						);
					} catch (error) {
						log(`internal error handling dequeue frame: ${String(error)}`);
						send({ ...errorFrame("internal", "internal error", "dequeue", sessionId), queueRequestId });
					}
					return;
				}

				case "abort": {
					const sessionId = asString(frame, "sessionId");
					const requestedOperationId = asOptionalString(frame.operationId);
					const requestedIdentity = {
						...(requestedOperationId ? { operationId: requestedOperationId } : {}),
						...(asOptionalString(frame.instanceId) ? { instanceId: asOptionalString(frame.instanceId) } : {}),
						...(asOptionalString(frame.epoch) ? { epoch: asOptionalString(frame.epoch) } : {}),
					};
					if (!sessionId) {
						send({ ...errorFrame("bad-request", "abort requires a sessionId", "abort"), ...requestedIdentity });
						return;
					}
					if (frame.restoreQueued !== undefined && typeof frame.restoreQueued !== "boolean") {
						send({
							...errorFrame("bad-request", "restoreQueued must be boolean", "abort", sessionId),
							...requestedIdentity,
						});
						return;
					}
					if (bridgeMode()) {
						const descriptor = bridge?.descriptor(sessionId);
						const identity = descriptor
							? { instanceId: descriptor.instanceId, epoch: descriptor.epoch }
							: requestedIdentity;
						if (modeSwitchInFlight()) {
							send({
								...errorFrame("bridge-unavailable", "mode switch is in progress", "abort", sessionId),
								...requestedIdentity,
							});
							return;
						}
						if (!descriptor) {
							send({
								...errorFrame("bridge-offline", "native pi instance is offline", "abort", sessionId),
								...requestedIdentity,
							});
							return;
						}
						if (bridgeIdentityMismatch(frame, descriptor)) {
							send({
								...errorFrame("bridge-stale-runtime", "native pi instance changed", "abort", sessionId),
								...identity,
								...(requestedOperationId ? { operationId: requestedOperationId } : {}),
							});
							return;
						}
						const operationId = requestedOperationId ?? `gw-${Math.random().toString(36).slice(2)}`;
						if (operationId.length > 128) {
							send({
								...errorFrame("bad-request", "operationId must be at most 128 characters", "abort", sessionId),
								...identity,
							});
							return;
						}
						beginBridgeWrite(sessionId);
						try {
							const reply = await bridge?.abort(descriptor, {
								operationId,
								...(frame.restoreQueued === true ? { restoreQueued: true } : {}),
							});
							if (!reply) throw new BridgeUnavailableError("bridge unavailable");
							if (!reply.ok) {
								send({
									...errorFrame(bridgeErrorCode(reply.code), bridgeErrorMessage(reply.code), "abort", sessionId),
									operationId,
									...identity,
									...(typeof reply.queuedText === "string"
										? { queuedText: reply.queuedText, queued: reply.queuedText === "" ? [] : [reply.queuedText] }
										: {}),
									// 失败回执同样要能区分"没执行/已捕获/结果不明"。
									// 注意：BridgeHub.abort 经 requireOk 包装，ok:false 会先抛
									// BridgeRequestError 走 catch 分支，本分支当前不可达；
									// 保留它与 catch 分支字段一致，防止将来改回直连时漏字段。
									...(reply.queuedDisposition ? { queuedDisposition: reply.queuedDisposition } : {}),
								});
								return;
							}
							// ACK 不等于任务结束：status=timeout 时仍按真实 busy 报告。
							send({
								kind: "aborted",
								sessionId,
								isStreaming: reply.busy === true && reply.snapshot?.isCompacting !== true,
								isCompacting: reply.snapshot?.isCompacting === true,
								model: reply.snapshot?.model ?? null,
								thinkingLevel: reply.snapshot?.thinkingLevel ?? null,
								contextUsage: reply.snapshot?.contextUsage ?? null,
								queuedMessages: { steering: [], followUp: [] },
								operationId,
								...identity,
								...(reply.status ? { status: reply.status } : {}),
								...(reply.queuedDisposition ? { queuedDisposition: reply.queuedDisposition } : {}),
								...(frame.restoreQueued === true && typeof reply.queuedText === "string"
									? {
											queuedText: reply.queuedText,
											queued: reply.queuedText === "" ? [] : [reply.queuedText],
										}
									: {}),
								...(reply.queuedRestoredToDesktop === true ? { queuedRestoredToDesktop: true } : {}),
							});
						} catch (error) {
							send({
								...(error instanceof BridgeRequestError
									? errorFrame(bridgeErrorCode(error.code), bridgeErrorMessage(error.code), "abort", sessionId)
									: errorFrame("bridge-offline", "native pi instance is offline", "abort", sessionId)),
								operationId,
								...identity,
								...(error instanceof BridgeRequestError && typeof error.queuedText === "string"
									? { queuedText: error.queuedText, queued: error.queuedText === "" ? [] : [error.queuedText] }
									: {}),
								...(error instanceof BridgeRequestError && error.queuedDisposition
									? { queuedDisposition: error.queuedDisposition }
									: {}),
							});
						} finally {
							endBridgeWrite(sessionId);
						}
						return;
					}
					if (modeSwitchInFlight()) {
						send(errorFrame("mode-switch-blocked", "mode switch is in progress", "abort", sessionId));
						return;
					}
					const result = await sdkWrite(() => runtime.abort(sessionId, frame.restoreQueued === true));
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
					if (bridgeMode() && bridge) {
						const descriptor = bridge.descriptor(sessionId);
						const snapshotState = descriptor ? await bridge.snapshot(descriptor).catch(() => null) : null;
						if (descriptor && snapshotState) {
							try {
								const page = await bridge.history(descriptor, beforeEntryId, Math.min(Math.max(limit ?? 100, 1), 400));
								const messages: WireMessage[] = [];
								const entryIds: string[] = [];
								for (const raw of page.entries) {
									const wire = entryToWireMessage(raw as SessionEntry);
									if (!wire) continue;
									messages.push(sanitizeHistoryMessage(wire));
									entryIds.push((raw as { id: string }).id);
								}
								const capped = capHistoryPage(messages, entryIds, 2 * 1024 * 1024, page.hasMore);
								send({
									kind: "history",
									sessionId,
									// 拉式快照必须带来源身份与事件水位：客户端用它排定"这次补拉"和
									// 已消费的终态事件先后，否则迟到的 busy 快照会把已结束的 Working 复活。
									instanceId: snapshotState.instanceId,
									epoch: snapshotState.epoch,
									bridgeSeq: snapshotState.seq,
									messages: capped.messages,
									entryIds: capped.entryIds,
									hasMore: capped.hasMore,
									oldestEntryId: capped.oldestEntryId,
									latestEntryId: snapshotState.leafId,
									bytes: capped.bytes,
									isStreaming: snapshotState.busy && snapshotState.isCompacting !== true,
									isCompacting: snapshotState.isCompacting === true,
									model: snapshotState.model,
									thinkingLevel: snapshotState.thinkingLevel,
									queuedMessages: { steering: [], followUp: [] },
									pendingMessages: snapshotState.pending,
									contextUsage: snapshotState.contextUsage ?? null,
								});
							} catch (error) {
								if (error instanceof BridgeRequestError && error.code === "history-cursor-invalid") {
									send(
										errorFrame(
											"history-cursor-invalid",
											"history cursor is not on the active branch",
											"history",
											sessionId,
										),
									);
									return;
								}
								send(
									error instanceof BridgeRequestError
										? errorFrame(bridgeErrorCode(error.code), bridgeErrorMessage(error.code), "history", sessionId)
										: errorFrame("bridge-offline", "native pi instance is offline", "history", sessionId),
								);
							}
							return;
						}
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
					if (bridgeMode() && bridge) {
						const descriptor = bridge.descriptor(sessionId);
						if (descriptor) {
							try {
								const snapshot = await bridge.snapshot(descriptor);
								send({
									kind: "state",
									sessionId,
									// 同 history：前台对账的 state 是拉式快照，必须可判定新旧与代际。
									instanceId: snapshot.instanceId,
									epoch: snapshot.epoch,
									bridgeSeq: snapshot.seq,
									isStreaming: snapshot.busy && snapshot.isCompacting !== true,
									isCompacting: snapshot.isCompacting === true,
									model: snapshot.model,
									thinkingLevel: snapshot.thinkingLevel,
									queuedMessages: { steering: [], followUp: [] },
									pendingMessages: snapshot.pending,
									contextUsage: snapshot.contextUsage ?? null,
								});
								return;
							} catch {
								// 实例不可达时回退文件状态，客户端仍可浏览历史。
							}
						}
					}
					const state = await runtime.state(sessionId);
					send({ kind: "state", ...state });
					return;
				}

				// -- session tree / branch switching --------------------------

				case "commands": {
					if (bridgeMode()) {
						await inputAssist.handle(frame);
						return;
					}
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
						if (error instanceof WorktreeError) {
							send(treeActionError(error.code, "正在切换工作区，请稍后重试", "label-put", sessionId, entryId));
							return;
						}
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
						// Native CLI may use --session-dir outside the SDK index. This path
						// comes only from the locally registered owner, never from frame.
						const sourceFile = bridgeMode() ? (bridge?.descriptor(sessionId)?.sessionFile ?? undefined) : undefined;
						const attachment = await runtime.attachment(sessionId, entryId, imageIndex, sourceFile);
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
					if (bridgeMode()) {
						await handleBridgeModels(frame, false);
						return;
					}
					send({ kind: "models", groups: await runtime.listModels() });
					return;
				}

				case "refresh-model": {
					if (bridgeMode()) await handleBridgeModels(frame, true);
					else
						send({
							...errorFrame(
								"bridge-unavailable",
								"当前模式不支持原生模型刷新",
								"refresh-model",
								asString(frame, "sessionId"),
							),
							operationId: frame.operationId,
							instanceId: frame.instanceId,
							epoch: frame.epoch,
						});
					return;
				}
				case "set-model": {
					if (bridgeMode()) {
						await handleBridgeModels(frame, true);
						return;
					}
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
					send({
						kind: "session-restarted",
						...state,
						sessionId,
						// 重建后的会话从空状态开始；随应答清空旧状态行（其他订阅者由 runtime 广播同一快照）。
						statuses: runtime.extensionStatuses(sessionId),
					});
					return;
				}

				case "compact": {
					if (bridgeMode()) {
						const sessionId = asString(frame, "sessionId");
						const operationId = asString(frame, "operationId");
						const binding = {
							sessionId,
							operationId,
							instanceId: asString(frame, "instanceId"),
							epoch: asString(frame, "epoch"),
						};
						const fail = (code: string) =>
							send({ ...errorFrame(code, "压缩未完成", "compact", sessionId), ...binding });
						if (!sessionId || !operationId || operationId.length > 128 || !binding.instanceId || !binding.epoch) {
							fail("bad-request");
							return;
						}
						if (modeSwitchInFlight()) {
							fail("mode-switch-blocked");
							return;
						}
						if (!bridge) {
							fail("bridge-unavailable");
							return;
						}
						const descriptor = bridge.descriptor(sessionId);
						if (!descriptor) {
							fail("bridge-offline");
							return;
						}
						if (bridgeIdentityMismatch(frame, descriptor)) {
							fail("bridge-stale-runtime");
							return;
						}
						beginBridgeWrite(sessionId);
						try {
							const result = await bridge.compact(descriptor, { operationId });
							const state = result.snapshot ?? (await bridge.snapshot(descriptor));
							send({
								kind: "compact-started",
								...binding,
								status: result.status,
								isStreaming: state.busy && state.isCompacting !== true,
								isCompacting: state.isCompacting === true,
								model: state.model,
								thinkingLevel: state.thinkingLevel,
								contextUsage: state.contextUsage ?? null,
								pendingMessages: state.pending,
								queuedMessages: { steering: [], followUp: [] },
							});
						} catch (error) {
							fail(error instanceof BridgeRequestError ? bridgeErrorCode(error.code) : "compaction-unconfirmed");
						} finally {
							endBridgeWrite(sessionId);
						}
						return;
					}
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
					const providerTestId = asString(frame, "providerTestId");
					if (Object.hasOwn(frame, "providerTestId") && (!providerTestId || providerTestId.length > 128)) {
						send(errorFrame("bad-request", "invalid providerTestId", "provider-test"));
						return;
					}
					const correlation = providerTestId ? { providerTestId } : {};
					try {
						const { id, baseUrl, apiKey, api, modelId } = await resolveProviderFormFields(frame);
						if (!baseUrl || !modelId) {
							send({
								...errorFrame("bad-request", "provider-test requires baseUrl and a model", "provider-test"),
								...correlation,
							});
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
						//  - 成功 / config 失败（需用户改配置）→ 写入诊断（不控制 Pi 模型菜单）
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
						send({ kind: "provider-test-result", id: id ?? null, ...result, ...correlation });
					} catch (error) {
						send({ ...providerErrorFrame(error, "provider-test"), ...correlation });
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
			if (error instanceof WorktreeError) {
				send({
					...errorFrame(error.code, "工作区操作未完成", requestType, asString(frame, "sessionId")),
					...(asString(frame, "queryId") ? { queryId: asString(frame, "queryId") } : {}),
					...(asString(frame, "operationId") ? { operationId: asString(frame, "operationId") } : {}),
					...(asString(frame, "instanceId") ? { instanceId: frame.instanceId, epoch: frame.epoch } : {}),
				});
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
			coordinator?.connections.delete(connectionControl);
			inputAssist.close();
			for (const sessionId of subscriptions) runtime.unsubscribe(sessionId, send);
			for (const sessionId of [...bridgeSubscriptions.keys()]) stopBridgeSubscription(sessionId);
			subscriptions.clear();
		},
	};
}
