import { historyTurnPage } from "./history-turns.ts";
import {
	InputAssistError,
	type InputContext,
	type InputResources,
	previewInputResources,
	sessionInputResources,
} from "./input-assist.ts";
import type { TreeViewOptions } from "./tree-view.ts";
// Pi runtime: drives pi agent sessions in-process through the public SDK.
//
// This module owns everything session-shaped on the gateway side:
//   - one shared `ModelRuntime` (created lazily; only the real session
//     factory needs it — injected test factories never touch `~/.pi`),
//   - a sessionId -> file path index over the sessions directory
//     (`SessionManager.listAll()`, short TTL cache),
//   - live session handles: the SDK `AgentSession` plus this gateway's
//     per-session event `seq` counter, subscriber sinks, prompt admission
//     serialization, and an idle-dispose sweeper,
//   - file-backed history paging over the session's active branch.
//
// Lifecycle rules:
//   - a handle stays loaded while any subscriber is attached or the session
//     is streaming/compacting, plus an idle grace period after the last
//     activity (sweeper disposes handles with no subscribers and no run);
//   - the sweeper only ever disposes *idle, subscriber-less* handles, so a
//     prompt keeps running to completion even if the phone disconnects
//     mid-run ("pi runs on the machine, the phone is just a remote").

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	initTheme,
	ModelRuntime,
	type PromptOptions,
	resolveModelScopeWithDiagnostics,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	ATTACHMENT_MAX_BASE64_CHARS,
	ATTACHMENT_MAX_RAW_BYTES,
	capHistoryPage,
	deriveSettingsFromEntries,
	entryToWireMessage,
	type HistoryPage,
	isRecord,
	isValidImageMediaType,
	oversizedEventStub,
	sanitizeHistoryMessage,
	shrinkForWire,
	sliceActiveBranchTail,
	toWireEvent,
	toWireSlashCommands,
	toWireTreeNodes,
	trimTreeNodes,
	WIRE_EVENT_MAX_BYTES,
	type WireMessage,
	type WireSlashCommand,
	type WireTreeNode,
} from "./wire.ts";

/** Everything the runtime needs from an SDK AgentSession (structural, so
 * tests can inject scripted fakes without loading real pi resources). */
export interface PiSessionLike {
	sessionId: string;
	sessionFile: string | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	model: { id: string; provider: string } | undefined;
	thinkingLevel: string;
	setScopedModels?(models: Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>["scopedModels"]): void;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	dispose(): void;
	prompt(
		text: string,
		options?: {
			streamingBehavior?: "steer" | "followUp";
			images?: ImageAttachment[];
			preflightResult?: PromptOptions["preflightResult"];
		},
	): Promise<void>;
	abort(): Promise<void>;
	setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
	setThinkingLevel(level: string): void;
	setSessionName(name: string): void;
	compact(customInstructions?: string): Promise<unknown>;
	/** pi 公开 API：切换分支（targetId 为叶子）。summarize 由调用方固定。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string },
	): Promise<{ editorText?: string; cancelled?: boolean }>;
	getSteeringMessages(): readonly string[];
	getFollowUpMessages(): readonly string[];
	getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined;
	bindExtensions?(bindings: Record<string, unknown>): Promise<void>;
	/** 三源清单 getter（pi SDK 公开，fake 会话可缺省逐源降级）。 */
	readonly promptTemplates?: ReadonlyArray<{
		name: string;
		description: string;
		argumentHint?: string;
		sourceInfo?: { scope?: string; origin?: string };
	}>;
	readonly settingsManager?: { getEnableSkillCommands(): boolean };
	resourceLoader?: {
		getSkills(): {
			skills: Array<{
				name: string;
				description: string;
				disableModelInvocation: boolean;
				sourceInfo?: { scope?: string; origin?: string };
			}>;
		};
	};
	extensionRunner?: {
		getRegisteredCommands(): Array<{
			invocationName: string;
			description?: string;
			sourceInfo?: { scope?: string; origin?: string };
		}>;
	};
}

/** pi `ImageContent` 的结构子集：base64 图片附件，随 message 帧透传给 pi。 */
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

export type SessionFactory = (options: { sessionManager: SessionManager }) => Promise<PiSessionLike>;

export interface WireSessionItem {
	id: string;
	path: string;
	cwd: string;
	name: string | null;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** True when a live handle is streaming or compacting right now. */
	running: boolean;
}

export interface WireSessionState {
	sessionId: string;
	isStreaming: boolean;
	isCompacting: boolean;
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	queuedMessages: { steering: string[]; followUp: string[] };
	contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}

export interface SessionHandle {
	session: PiSessionLike;
	attach(sink: (frame: Record<string, unknown>) => void): () => void;
}

/** pi thinking levels, in pi's own order (pi-ai EXTENDED_THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** message 帧图片附件条数上限；与客户端 4 张预算一致（18 MiB 帧上限对齐）。 */
export const MAXIMUM_MESSAGE_IMAGES = 4;

/** One selectable model, projected from pi's `Model` (only the fields a
 * mobile picker needs — no api/baseUrl/cost/headers). */
export interface WireModelInfo {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** `["text"]` or `["text","image"]`. */
	input: string[];
	/** Levels this model actually accepts (pi `getSupportedThinkingLevels`). */
	thinkingLevels: string[];
}

/** Models grouped by provider, as advertised by a `models` request. */
export interface WireModelGroup {
	provider: string;
	models: WireModelInfo[];
}

export interface ModelScopeSelection {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

export interface WireModelScope {
	patterns: string[];
	groups: WireModelGroup[];
	selected: ModelScopeSelection[];
	unmatchedPatterns: string[];
}

export class ModelScopeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Everything the runtime needs from a pi model registry (structural, so tests
 * inject a scripted catalog instead of loading the real `~/.pi` setup). */
export interface ModelRegistryLike {
	getAvailable(): Promise<readonly unknown[]>;
	getModel(provider: string, modelId: string): unknown;
	/** pi `ModelRuntime.refresh()` 的可选投影（原地重读 models.json）。测试注入的
	 * scripted catalog 没有这个能力，provider 保存路径会跳过刷新。 */
	refresh?(options?: { allowNetwork?: boolean }): Promise<unknown>;
	/** models.json 加载/组合错误（pi 对坏文件不抛错、只记 error）。 */
	getError?(): string | undefined;
}

/** Per-connection event sink: the router installs one per subscribed session. */
export type EventSink = (frame: Record<string, unknown>) => void;

/** 出站队列元素：wire 投影在入队那刻做深快照并定格 `time`，此后 pi
 * 再改事件对象也不影响已排定的下发内容；`sourceMessage` 单独保留
 * message_end 的原始消息引用（不快照、不下发），仅供 flush 时按引
 * 用精确匹配新追加条目的 id。 */
interface PendingFrame {
	finalEvent: Record<string, unknown>;
	time: number;
	sourceMessage?: unknown;
}

interface LiveHandle {
	session: PiSessionLike;
	/** pi SessionManager（getTree 的数据源）；与 session 同生命周期。 */
	sessionManager: SessionManager;
	subscribers: Set<EventSink>;
	seq: number;
	lastActivity: number;
	unsubscribe: () => void;
	admissionTail: Promise<void>;
	disposed: boolean;
	/** 统一出站 FIFO：所有 wire 事件先入队，在微任务里批量 flush。 */
	pendingFrames: PendingFrame[];
	/** 防止同一 tick 重复排 flush。 */
	flushScheduled: boolean;
}

export interface PiRuntimeOptions {
	/**
	 * Sessions directory override, passed to SessionManager.open/create and
	 * the listAll index. This is pi's *project-level* session dir (the one
	 * that directly contains the .jsonl files); tests inject a temp dir so
	 * nothing ever touches `~/.pi`.
	 */
	sessionDir?: string;
	/** Session factory override (tests inject scripted fakes). */
	sessionFactory?: SessionFactory;
	/** Idle grace before a subscriber-less, idle handle is disposed. */
	idleDisposeMs?: number;
	/** Sweeper period. */
	sweepIntervalMs?: number;
	/** sessions index TTL. */
	indexTtlMs?: number;
	/** history: default and max page sizes (entries). */
	historyDefaultLimit?: number;
	historyMaxLimit?: number;
	/** 无view旧客户端的树窗口上限；tree-view-v1返回完整筛选结果。 */
	treeMaxLimit?: number;
	/** history: serialized byte budget per page. */
	historyMaxBytes?: number;
	/** Cap on concurrently loaded session handles (evicts oldest idle ones). */
	maxLoadedSessions?: number;
	/** Model registry override (tests inject a scripted catalog). */
	modelRegistry?: ModelRegistryLike;
	/**
	 * `enabledModels` 读取器（pi 全局 settings 的模型过滤配置，TUI scope配置
	 * 口径）。返回 undefined/空数组表示不过滤；抛错也视为不过滤。生产默认读
	 * `~/.pi/agent/settings.json`，不借用网关工程自身的项目scope；测试使用临时目录。
	 */
	enabledModelsLoader?: () => string[] | undefined;
	/**
	 * `enabledModels` 追加器（provider-put 的新 provider 收录）。生产默认通过
	 * pi `SettingsManager.setEnabledModels` 写全局 settings.json；测试注入
	 * no-op 以免触碰真实用户目录。
	 */
	enabledModelsAppender?: (pattern: string) => void;
	/**
	 * `enabledModels` 移除器（provider-delete 的对称清理）。生产默认通过
	 * pi `SettingsManager.setEnabledModels` 写回去掉该 pattern 的全量；测试注入
	 * no-op 以免触碰真实用户目录。
	 */
	enabledModelsRemover?: (pattern: string) => void;
	/** Whole-scope setter for isolated tests; production uses public SettingsManager. */
	enabledModelsSetter?: (patterns: string[]) => void | Promise<void>;
	/**
	 * pi 的全局 agent 目录（SettingsManager 的第二参数）。生产默认 undefined
	 * = pi 自己的默认（~/.pi/agent）；测试注入临时目录做结构性隔离——启用后
	 * enabledModels/defaultModel 的读写全部落在临时目录，无论测试是否配齐
	 * appender/remover 注入都不会触碰真实用户配置（与 pi fixture 重定向 HOME
	 * 的隔离思路一致）。
	 */
	agentDir?: string;
	/** Legacy injection retained for callers; testing status no longer filters Pi models. */
	providerActive?: (providerId: string) => boolean;
	/** Injected clock (ms epoch). */
	now?: () => number;
	log?: (message: string) => void;
}

const DEFAULT_IDLE_DISPOSE_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;
const DEFAULT_INDEX_TTL_MS = 15 * 1000;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 400;
const DEFAULT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOADED_SESSIONS = 16;

/**
 * 去掉 enabledModels 条目的 `:<thinkingLevel>` 后缀（如 `provider/model:high`）。
 * 规则对齐 pi 的 model-resolver：取最后一个 `:`，且必须落在 `/` 之后才算后缀
 * （model id 本身可能含 `:`）。
 */
function stripThinkingLevelSuffix(pattern: string): string {
	const colon = pattern.lastIndexOf(":");
	return colon > pattern.lastIndexOf("/") ? pattern.slice(0, colon) : pattern;
}

export class PiRuntime {
	private readonly sessionDir?: string;
	private readonly sessionFactoryOverride?: SessionFactory;
	private readonly idleDisposeMs: number;
	private readonly indexTtlMs: number;
	private readonly historyDefaultLimit: number;
	private readonly historyMaxLimit: number;
	private readonly treeMaxLimit: number;
	private readonly historyMaxBytes: number;
	private readonly maxLoadedSessions: number;
	private readonly modelRegistryOverride?: ModelRegistryLike;
	private readonly enabledModelsLoaderOverride?: () => string[] | undefined;
	private readonly enabledModelsAppenderOverride?: ((pattern: string) => void) | undefined;
	private readonly enabledModelsRemoverOverride?: ((pattern: string) => void) | undefined;
	private readonly enabledModelsSetterOverride?: (patterns: string[]) => void | Promise<void>;
	private readonly agentDir: string | undefined;
	private settingsManager: SettingsManager | undefined;

	/**
	 * 外部可编辑配置文件的 (mtime, size) 门控：文件变了才重读。
	 *
	 * 刻意不用 `fs.watch`：它在各平台静默失败——Windows 的 ReadDirectoryChangesW
	 * 缓冲区溢出丢事件、映射/网络驱动器不工作、编辑器原子保存（tmp+rename）
	 * 使文件句柄失效；macOS 的 fs.watch 走 kqueue、递归支持差；Linux 的 inotify
	 * 有 watch 上限且 NFS/CIFS 不触发；WSL 跨 Windows↔Linux 边界编辑不触发；
	 * 容器 bind mount 传播不一致。本项目要开源，使用者可能在纯 Linux /
	 * Windows / 容器中运行，正确性不能依赖平台相关的通知机制。
	 *
	 * statSync 跨平台一致、无状态、微秒级；先例是同文件的 projectionCache
	 * （会话 jsonl 的 (mtime,size) 门控）。
	 */
	private readonly configFileGates = new Map<string, { mtimeMs: number; size: number }>();

	/**
	 * settings 读-改-写串行链：异步门控把原本同步原子的 read-modify-write
	 * 切成多步（`ensureSettingsFresh` 里还有 reload），而数据面帧处理是
	 * fire-and-forget（`server.ts` 的 `void handleMessage(frame)`），两个
	 * provider-put（或多设备并发保存）会交错：后者的写会被前者的 reload
	 * 覆盖掉，enabledModels 丢条目。与 `PiProviderStore.enqueue` 同构。
	 */
	private settingsWriteTail: Promise<unknown> = Promise.resolve();

	private enqueueSettingsWrite<T>(work: () => Promise<T>): Promise<T> {
		const run = this.settingsWriteTail.then(work, work);
		this.settingsWriteTail = run.catch(() => undefined);
		return run;
	}
	private readonly now: () => number;
	private readonly log: (message: string) => void;

	private modelRuntimePromise: Promise<ModelRuntime> | undefined;
	private realFactoryThemeInitialized = false;
	private index: { at: number; infos: SessionInfo[] } | undefined;
	private indexLoad: { generation: number; promise: Promise<SessionInfo[]> } | undefined;
	private indexGeneration = 0;
	private readonly handles = new Map<string, LiveHandle>();
	/** (mtime,size) 门控的 SessionManager 投影缓存：文件没变就不重读整个
	 *  jsonl（实测 29MB 文件 open+解析 ~124ms，同步阻塞事件循环）。b6061c8
	 *  修的是 live 句柄内存快照的陈旧；这里的缓存键是文件自身状态，
	 *  桌面端并发写入改变 mtime/size 即失效，语义仍是"读当前文件"。
	 *  jsonl 只会追加/原子重写，size 校验兜住 mtime 粒度内的追加。 */
	private readonly projectionCache = new Map<string, { mtimeMs: number; size: number; manager: SessionManager }>();
	/** 分支切换后的手动叶子（pi navigateTree 只改运行时 leafId 不落盘）：
	 *  history/tree 的活跃链以此起点构建，否则切分支后网关投影仍从 file 尾
	 *  取链，对话流不会截断（实测切到中间节点 history 帧仍 44KB 全量）。 */
	private readonly manualLeafIds = new Map<string, string>();
	/** In-flight open/create builders, so concurrent requests share one build
	 * instead of racing into duplicate AgentSessions (pi-web startLocks). */
	private readonly openingLocks = new Map<string, Promise<SessionHandle>>();
	private readonly creatingLocks = new Map<string, Promise<SessionHandle>>();
	private sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: PiRuntimeOptions = {}) {
		this.sessionDir = options.sessionDir;
		this.sessionFactoryOverride = options.sessionFactory;
		this.idleDisposeMs = options.idleDisposeMs ?? DEFAULT_IDLE_DISPOSE_MS;
		this.indexTtlMs = options.indexTtlMs ?? DEFAULT_INDEX_TTL_MS;
		this.historyDefaultLimit = options.historyDefaultLimit ?? DEFAULT_HISTORY_LIMIT;
		this.historyMaxLimit = options.historyMaxLimit ?? MAX_HISTORY_LIMIT;
		this.treeMaxLimit = options.treeMaxLimit ?? 400;
		this.historyMaxBytes = options.historyMaxBytes ?? DEFAULT_HISTORY_MAX_BYTES;
		this.maxLoadedSessions = options.maxLoadedSessions ?? DEFAULT_MAX_LOADED_SESSIONS;
		this.modelRegistryOverride = options.modelRegistry;
		this.enabledModelsLoaderOverride = options.enabledModelsLoader;
		this.enabledModelsAppenderOverride = options.enabledModelsAppender;
		this.enabledModelsRemoverOverride = options.enabledModelsRemover;
		this.enabledModelsSetterOverride = options.enabledModelsSetter;
		this.agentDir = options.agentDir;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
		// The sweeper must never keep the process alive on its own and must
		// never surface an exception.
		this.sweepTimer.unref?.();
	}

	// -- session index ------------------------------------------------------

	private async loadIndex(force = false): Promise<SessionInfo[]> {
		if (!force && this.index && this.now() - this.index.at < this.indexTtlMs) return this.index.infos;
		const generation = this.indexGeneration;
		if (this.indexLoad?.generation === generation) return this.indexLoad.promise;
		const promise = SessionManager.listAll(this.sessionDir).then((infos) => {
			if (this.indexGeneration === generation) this.index = { at: this.now(), infos };
			return infos;
		});
		this.indexLoad = { generation, promise };
		try {
			return await promise;
		} finally {
			if (this.indexLoad?.promise === promise) this.indexLoad = undefined;
		}
	}

	private invalidateIndex(): void {
		this.index = undefined;
		this.indexGeneration++;
	}

	/** List all sessions, newest first, with live running flags. */
	async listSessions(): Promise<WireSessionItem[]> {
		const infos = await this.loadIndex();
		return infos.map((info) => ({
			id: info.id,
			path: info.path,
			cwd: info.cwd,
			name: info.name ?? null,
			created: info.created.toISOString(),
			modified: info.modified.toISOString(),
			messageCount: info.messageCount,
			// 纯图消息的首条：网关注入的占位空格不能让会话看起来是空的
			// （pi 的 extractTextContent 不 trim，会原样给出 " "）。
			firstMessage: info.firstMessage?.trim() || "(no messages)",
			running: this.isHandleRunning(info.id),
		}));
	}

	private isHandleRunning(sessionId: string): boolean {
		const handle = this.handles.get(sessionId);
		return handle !== undefined && (handle.session.isStreaming || handle.session.isCompacting);
	}

	private async resolveSessionPath(sessionId: string): Promise<string | null> {
		const handle = this.handles.get(sessionId);
		if (handle?.session.sessionFile) return handle.session.sessionFile;
		// 会话ID对应的文件路径稳定；TTL仅用于列表元数据刷新。选择已列出的
		// 会话不用重扫其他目录。文件消失时回到索引刷新，不借缓存假成功。
		const known = this.index?.infos.find((info) => info.id === sessionId);
		if (known && this.sessionPathMatches(known.path, sessionId)) {
			return known.path;
		}
		if (known) this.invalidateIndex();
		const infos = await this.loadIndex();
		const info = infos.find((item) => item.id === sessionId);
		if (!info) return null;
		if (this.sessionPathMatches(info.path, sessionId)) return info.path;
		// 扫描后文件也可能删除或换头；只重查一次，不返回空会话假成功。
		this.invalidateIndex();
		const refreshed = await this.loadIndex();
		const next = refreshed.find((item) => item.id === sessionId);
		return next && this.sessionPathMatches(next.path, sessionId) ? next.path : null;
	}

	private sessionPathMatches(path: string, sessionId: string): boolean {
		try {
			if (existsSync(path) && this.openSessionManager(path).getSessionId() === sessionId) return true;
		} catch {
			// 回查失败后丢弃该路径投影，再由索引确认会话是否仍存在。
		}
		this.projectionCache.delete(path);
		return false;
	}

	// -- session factory ------------------------------------------------------

	private async createRealSession(sessionManager: SessionManager): Promise<PiSessionLike> {
		if (!this.realFactoryThemeInitialized) {
			// Extensions loaded from the user's setup may touch the global
			// theme even outside a terminal UI (pi-web does the same).
			initTheme();
			this.realFactoryThemeInitialized = true;
		}
		// pi 每次创建会话都会读当前设置；长驻网关也要在选择初始模型前重读外部修改。
		await this.ensureSettingsFresh();
		const modelRuntime = await this.sharedModelRuntime();
		// 新会话初始模型与 pi CLI 的 buildSessionOptions 对齐：settings 的
		// `enabledModels` 范围内解析，settings 的 defaultProvider/defaultModel
		// 在范围内则优先它，否则用范围第一项。不干预时 pi 内部 findInitialModel
		// 会跳出范围兜底到内置 provider 默认表（曾导致默认命中范围外的
		// relayF/model-x，与 CLI 的“settings.json 才是实际可见范围”不一致）。
		// 已有会话不传 model：pi 按会话记录恢复模型。
		const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;
		const selection = await selectInitialScopedModel(
			hasExistingSession,
			this.enabledModelPatterns(),
			async (patterns) => {
				// 与 pi CLI 调用点同参：15s 超时（main.js resolveModelScope）。
				// 失败面只有 getAvailable 抛错——CLI 原生不降级（异常冒泡启动失败），
				// 服务侧对等的 fail loud 是拒绝本次会话创建，这里不做 try/catch 吞错。
				const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, {
					signal: AbortSignal.timeout(15_000),
				});
				for (const diagnostic of diagnostics) {
					this.log(`enabledModels scope: ${diagnostic.message}`);
				}
				return scopedModels;
			},
			this.savedDefaultModelRef(),
		);
		const { session } = await createAgentSession({
			cwd: sessionManager.getCwd(),
			sessionManager,
			modelRuntime,
			...(selection.entry ? { model: selection.entry.model } : {}),
			// pattern 的 ":level" 后缀随初始模型生效（与 CLI buildSessionOptions 的
			// options.thinkingLevel = savedInScope.thinkingLevel 对齐）。
			...(selection.entry?.thinkingLevel ? { thinkingLevel: selection.entry.thinkingLevel } : {}),
			...(selection.scopedModels.length > 0 ? { scopedModels: selection.scopedModels } : {}),
		});
		if (typeof session.bindExtensions === "function") {
			try {
				await session.bindExtensions({ mode: "rpc" });
			} catch (error) {
				// A failing extension must not take the session down; pi-web
				// logs and continues with the rest of the session.
				this.log(`bindExtensions failed for ${session.sessionId}: ${String(error)}`);
			}
		}
		return session;
	}

	private async buildSession(sessionManager: SessionManager): Promise<LiveHandle> {
		const factory = this.sessionFactoryOverride ?? ((options) => this.createRealSession(options.sessionManager));
		const session = await factory({ sessionManager });
		// Idempotency guard: a live handle for this id may have appeared while
		// the factory ran (concurrent build, duplicate file headers). Drop the
		// fresh AgentSession — an orphaned one would leak forever — and reuse
		// the registered handle.
		const existing = this.handles.get(session.sessionId);
		if (existing && !existing.disposed) {
			try {
				session.dispose();
			} catch (error) {
				this.log(`dispose of duplicate session ${session.sessionId} failed: ${String(error)}`);
			}
			return existing;
		}
		const handle: LiveHandle = {
			session,
			sessionManager,
			subscribers: new Set(),
			seq: 0,
			lastActivity: this.now(),
			unsubscribe: () => {},
			admissionTail: Promise.resolve(),
			disposed: false,
			pendingFrames: [],
			flushScheduled: false,
		};
		handle.unsubscribe = session.subscribe((event) => this.onSessionEvent(handle, event));
		this.handles.set(session.sessionId, handle);
		this.enforceHandleCap();
		return handle;
	}

	/** Keep the number of live handles bounded: evict the least recently
	 * active handles that hold nothing (no subscribers, no run in flight). */
	private enforceHandleCap(): void {
		let excess = this.handles.size - this.maxLoadedSessions;
		if (excess <= 0) return;
		const evictable = [...this.handles.values()]
			.filter((handle) => handle.subscribers.size === 0 && !handle.session.isStreaming && !handle.session.isCompacting)
			.sort((a, b) => a.lastActivity - b.lastActivity);
		for (const victim of evictable) {
			if (excess <= 0) break;
			this.log(`evicting loaded session ${victim.session.sessionId} (handle cap ${this.maxLoadedSessions})`);
			this.disposeHandle(victim);
			excess -= 1;
		}
	}

	private onSessionEvent(handle: LiveHandle, event: AgentSessionEvent): void {
		// The SDK calls this listener synchronously inside its run loop; a
		// throw here would break the whole event pump, so nothing in here is
		// allowed to escape.
		try {
			if (handle.disposed) return;
			const wire = toWireEvent(event);
			if (wire === null) return;
			// Outbound budget: oversized payloads (image base64, giant tool
			// output) are shrunk; what still cannot fit becomes a stub so a
			// single event can never wedge a phone connection.
			// 预算内 shrinkForWire 原样返回 wire（含对事件内部对象的别名引
			// 用），超限 stub 本身是新对象。入队前对最终下发物做 JSON 深快照
			// ——与真实下发序列化同语义，此后 pi 改事件对象不影响已排定帧。
			const projected = shrinkForWire(wire, WIRE_EVENT_MAX_BYTES);
			const deliveredEvent =
				projected.bytes > WIRE_EVENT_MAX_BYTES
					? oversizedEventStub(wire.type, projected.bytes)
					: (projected.value as Record<string, unknown>);
			const finalEvent = JSON.parse(JSON.stringify(deliveredEvent)) as Record<string, unknown>;
			// 入队而非直接下发：pi 在 message_end 的 emit 之后才同步
			// appendMessage，直接转发会错过刚持久化条目的 id。统一走
			// pendingFrames FIFO，微任务里按原序 flush（不只是延迟
			// message_end——所有 wire 事件保持原有相对顺序与帧形状不变）。
			// time 在入队时捕获，保留事件原发生时刻。
			const rawMessage = (event as { message?: { role?: string } }).message;
			const matchableRole =
				wire.type === "message_end" &&
				(rawMessage?.role === "user" || rawMessage?.role === "assistant" || rawMessage?.role === "toolResult");
			handle.pendingFrames.push({
				finalEvent,
				time: Math.round(this.now()) / 1000,
				sourceMessage: matchableRole ? rawMessage : undefined,
			});
			this.scheduleFlush(handle);
		} catch (error) {
			this.log(`event handling failed for ${handle.session.sessionId}: ${String(error)}`);
		}
	}

	/** 调度一次 microtask flush；同一批次内后续事件只复用这一个任务。 */
	private scheduleFlush(handle: LiveHandle): void {
		if (handle.flushScheduled) return;
		handle.flushScheduled = true;
		queueMicrotask(() => {
			handle.flushScheduled = false;
			this.flushPendingFrames(handle);
		});
	}

	/** 下发一批排好的帧。pi 的 `_handleAgentEvent` 先 `_emit(message_end)`
	 * 再同步 appendMessage，二者在同一异步续体里执行完才轮到这里的微任务
	 * ——于是能在不乱序的前提下拿到刚持久化条目的 id，补到**帧顶层**。
	 * 逐帧异常隔离：单帧处理失败只丢该帧的 entryId/下发，不影响后续
	 * 队列；dispose 会置 disposed 并清队列，旧句柄残留的 flush 不会发帧。 */
	private flushPendingFrames(handle: LiveHandle): void {
		while (!handle.disposed && handle.pendingFrames.length > 0) {
			const item = handle.pendingFrames.shift() as PendingFrame;
			try {
				// 身份补全：按原 message 引用精确匹配 pi 刚 append 的条目。
				// 匹配不到/条目读取失败时仅省略 entryId，帧本体照发不丢。
				let entryId: string | undefined;
				if (item.sourceMessage !== undefined) {
					try {
						entryId = this.matchAppendedEntry(handle, item.sourceMessage);
					} catch (error) {
						this.log(`entry lookup failed for ${handle.session.sessionId}: ${String(error)}`);
					}
				}
				handle.seq += 1;
				handle.lastActivity = this.now();
				const frame: Record<string, unknown> = {
					kind: "event",
					sessionId: handle.session.sessionId,
					seq: handle.seq,
					time: item.time,
					event: item.finalEvent,
				};
				if (entryId !== undefined) frame.entryId = entryId;
				for (const sink of handle.subscribers) {
					try {
						sink(frame);
					} catch {
						// A dead connection's send must never break the event loop
						// for other subscribers; the router cleans it up on close.
					}
				}
			} catch (error) {
				// 单帧隔离：丢该帧，继续下一帧，避免一个坏事件拖垮整个队列。
				this.log(`frame flush failed for ${handle.session.sessionId}: ${String(error)}`);
			}
		}
	}

	/** 在 pi 追加的条目里用原 message 引用做身份匹配（只用公开入口
	 * `getEntries()`；appendMessage 原样保留引用，引用相等即同一条目）。
	 * 从尾往头扫，命中最近一条即返回；不做内容/时间戳猜测。 */
	private matchAppendedEntry(handle: LiveHandle, sourceMessage: unknown): string | undefined {
		const entries = handle.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message === sourceMessage) return entry.id;
		}
		return undefined;
	}

	// -- handles ------------------------------------------------------------

	/** Load a session by id (idempotent). */
	async openSession(sessionId: string): Promise<SessionHandle> {
		const existing = this.handles.get(sessionId);
		if (existing) return this.toPublicHandle(existing);
		// Concurrent openers of the same session must share one build: two
		// parallel builds would each create an SDK AgentSession, orphaning one
		// (never disposed, invisible to the sweeper) and leaving some
		// subscribers attached to the discarded instance.
		const inflight = this.openingLocks.get(sessionId);
		if (inflight) return inflight;
		const build = this.buildSessionOnce(sessionId);
		this.openingLocks.set(sessionId, build);
		try {
			return await build;
		} finally {
			this.openingLocks.delete(sessionId);
		}
	}

	private async buildSessionOnce(sessionId: string): Promise<SessionHandle> {
		// Another opener may have registered the handle while this one queued.
		const existing = this.handles.get(sessionId);
		if (existing) return this.toPublicHandle(existing);
		const path = await this.resolveSessionPath(sessionId);
		if (path === null) throw new SessionNotFoundError(sessionId);
		const sessionManager = SessionManager.open(path, this.sessionDir);
		const handle = await this.buildSession(sessionManager);
		if (handle.session.sessionId !== sessionId) {
			// The file's header id is authoritative; a mismatch means the
			// index resolved the wrong file (concurrent rename, stale index).
			// Only dispose when this build actually owns the registration —
			// buildSession may have returned a pre-existing handle.
			if (this.handles.get(handle.session.sessionId) === handle) {
				this.disposeHandle(handle);
			}
			throw new SessionNotFoundError(sessionId);
		}
		return this.toPublicHandle(handle);
	}

	/** Create a new session rooted at `cwd`. */
	async createSession(cwd: string): Promise<SessionHandle> {
		// Two concurrent "new session" sends for the same cwd (double-tap,
		// two devices) must produce one session, not a duplicate pair.
		const key = resolve(cwd);
		const inflight = this.creatingLocks.get(key);
		if (inflight) return inflight;
		const build = this.createSessionOnce(cwd);
		this.creatingLocks.set(key, build);
		try {
			return await build;
		} finally {
			this.creatingLocks.delete(key);
		}
	}

	private async createSessionOnce(cwd: string): Promise<SessionHandle> {
		const sessionManager = SessionManager.create(cwd, this.sessionDir);
		const handle = await this.buildSession(sessionManager);
		this.invalidateIndex();
		return this.toPublicHandle(handle);
	}

	/** Get an already-loaded handle, if any (never loads). */
	peekSession(sessionId: string): PiSessionLike | undefined {
		return this.handles.get(sessionId)?.session;
	}

	/** 按 session 摘除 sink：attach 返回的 detach 闭包绑的是当时的 handle，
	 * restart 重建后即失效；unsubscribe/close 必须走这里摘当前 handle，
	 * 否则非 restart 发起方连接的 sink 永久滞留（sweep 跳过，句柄泄漏）。 */
	unsubscribe(sessionId: string, sink: EventSink): boolean {
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) return false;
		// 与 attach/detach 对齐：成功摘除刷新活跃时间，否则长订阅摘除后
		// 下一个 sweep tick 即 dispose，重订阅要付磁盘重载延迟。
		if (!live.subscribers.delete(sink)) return false;
		live.lastActivity = this.now();
		return true;
	}

	private toPublicHandle(handle: LiveHandle): SessionHandle {
		return {
			session: handle.session,
			attach: (sink: EventSink) => {
				handle.subscribers.add(sink);
				handle.lastActivity = this.now();
				return () => {
					handle.subscribers.delete(sink);
					handle.lastActivity = this.now();
				};
			},
		};
	}

	// -- commands -------------------------------------------------------------

	/**
	 * Send a prompt. Resolves when the run is *accepted* (pi's preflight
	 * callback), not when it finishes — the run streams through the event
	 * frames. Failures after acceptance surface as events, matching pi's
	 * own RPC semantics.
	 */
	async prompt(
		handle: SessionHandle,
		text: string,
		mode: "prompt" | "steer" | "followUp",
		images: ImageAttachment[] = [],
	): Promise<void> {
		const live = this.handles.get(handle.session.sessionId);
		if (!live || live.disposed) throw new Error("session handle is no longer loaded");

		// Serialize admission only: once the preceding prompt has passed or
		// failed preflight, the SDK atomically decides whether this
		// submission starts a run or joins its streaming queue (pi-web).
		const previous = live.admissionTail;
		let release!: () => void;
		live.admissionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			live.lastActivity = this.now();
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (settle: () => void) => {
					if (settled) return;
					settled = true;
					settle();
				};
				const options =
					mode === "prompt"
						? {}
						: {
								streamingBehavior: mode,
							};
				let run: Promise<void>;
				try {
					// 纯图消息的上游兼容：pi 的 prompt(text, {images}) 会无条件生成一个 text
					// block（agent-session.js：userContent = [{type:"text", text}]），text 为空时
					// 该空 block 会被 OpenAI 兼容上游拒绝——实测同一中转：
					//   [{text:""}, {image_url}] → 400 "messages 参数非法"
					//   [{image_url}]           → 200
					//   [{text:" "}, {image_url}] → 200
					// 桌面 pi 用 read 工具（tool result 路径）发图不带空 text，所以这是手机端
					// “只发图不打字”路径特有的暴露面。不改 pi 源码，在纯图场景注入单个空格；
					// 手机端把空白正文当“无文字”渲染（只显示图片）。
					const effectiveText = text.trim().length === 0 && images.length > 0 ? " " : text;
					run = live.session.prompt(effectiveText, {
						...options,
						// 图片附件：pi 的 PromptOptions.images（ImageContent）原生支持；
						// 空列表不传，保持请求体与纯文本场景一致。
						...(images.length > 0 ? { images } : {}),
						// Match pi's RPC contract: acknowledge after
						// synchronous validation + extension preflight accept.
						preflightResult: (disposition) => {
							// Pi 1.0：开始、排队、被扩展处理都已受理；拒绝走throw。
							if (disposition === "started" || disposition === "queued" || disposition === "handled") {
								finish(resolve);
							}
						},
					});
				} catch (error) {
					finish(() => reject(error));
					return;
				}
				run.then(
					() => finish(resolve),
					(error) => finish(() => reject(error)),
				);
			});
			// pi 原生（TUI）：从树位置提交消息即从该位置分叉并跟随新分支——
			// 手动叶子表达的“正在浏览旧分支”已被本次提交消费。不释放会让
			// 后续 history（切会话再切回、翻页）一直锚在分叉前的旧窗口，
			// 新消息直到 resetLeaf 重连补拉才可见。
			this.manualLeafIds.delete(handle.session.sessionId);
		} finally {
			release();
		}
	}

	/** Abort the current run and wait for the session to go idle. */
	async abort(sessionId: string): Promise<void> {
		const handle = this.handles.get(sessionId);
		if (!handle) return;
		handle.lastActivity = this.now();
		await handle.session.abort();
	}

	// -- model catalog / switching ---------------------------------------------

	/** Lazy shared model registry; the injected override never touches `~/.pi`. */
	private async registry(): Promise<ModelRegistryLike> {
		if (this.modelRegistryOverride) return this.modelRegistryOverride;
		return this.sharedModelRuntime();
	}

	/** One in-flight `ModelRuntime.create()` shared by every caller: the two
	 * entry points (`models` frames and the real session factory) may race, and
	 * a bare `??= await` would build two runtimes and orphan the loser. */
	private async sharedModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntimePromise ??= ModelRuntime.create();
		try {
			return await this.modelRuntimePromise;
		} catch (error) {
			// A failed init must not poison every later request.
			this.modelRuntimePromise = undefined;
			throw error;
		}
	}

	/**
	 * 触发 pi 重读 models.json（provider-put/provider-delete 成功后调用）。
	 * pi 的 `ModelRuntime.refresh()` 原地重组合 provider 并刷新可用性快照
	 * （models.json 是用户的编辑面，pi 原生只在 create/refresh 时读），修改的是
	 * **同一个 runtime 实例**——所有存活会话的 `_modelRuntime` 都指向它，因此无需
	 * 重建会话，新旧会话即刻看到新 provider。这也是 pi 自身的用法（`/login`
	 * 保存凭证后、agent-session-services 建会话时都这样调）。
	 * models.json 被外部改坏时 refresh 不抛错、而是把目录降级为空并记 error，
	 * 故刷新后还要读 `getError()` 才能区分“真的刷新成功”与“静默降级”。
	 * 注：`refresh()` 内部的可用性刷新对所有 provider 实测毫秒级（未另包超时，
	 * 与 pi 自身的 login/会话服务调用点一致）。
	 * @returns false 表示刷新未完全成功（调用方据此提示配置可能未生效）。
	 */
	async refreshModelRuntime(): Promise<boolean> {
		const registry = await this.registry();
		if (typeof registry.refresh !== "function") {
			// 测试注入的 scripted registry：无刷新语义，视为成功。
			return true;
		}
		try {
			await registry.refresh({ allowNetwork: false });
		} catch (error) {
			// 刷新抛错（IO/未知错）不等于读到最新：清指纹让下一次读取重试。
			this.configFileGates.delete(this.modelsConfigPath());
			this.log(`model runtime refresh failed: ${String(error)}`);
			return false;
		}
		const registryError = typeof registry.getError === "function" ? registry.getError() : undefined;
		if (registryError) {
			// 坏 models.json：目录已降级，如实回 false 让客户端提示。指纹保留
			//（configFileChanged 已记），否则每一帧都会重复重读。
			this.log(`model runtime refresh reported: ${registryError}`);
			return false;
		}
		// 成功即“已读到最新”：记指纹，使显式刷新的调用方（provider-put/delete）
		// 不会在下一次读取时被门控重复刷新一次。
		this.configFileChanged(this.modelsConfigPath());
		return true;
	}

	/** `models.json` 路径；与 pi 的 ModelRuntime 同源（agentDir 缺省时用 pi 的 getAgentDir）。 */
	private modelsConfigPath(): string {
		return join(this.agentDir ?? getAgentDir(), "models.json");
	}

	/** 全局 `settings.json` 路径（与 pi `SettingsManager` 的 globalSettingsPath 同源）。 */
	private settingsConfigPath(): string {
		return join(this.agentDir ?? getAgentDir(), "settings.json");
	}

	/**
	 * 文件自上次门控以来是否变化。首次、stat 失败（ENOENT/权限）均按"已变化"处理；
	 * 命中即记录新指纹——即使随后的重读失败（如 models.json 格式坏）也记录，
	 * 否则每一帧都会重复重读；文件修好后 mtime 再变即自愈。
	 */
	private configFileChanged(path: string): boolean {
		try {
			const stat = statSync(path);
			const previous = this.configFileGates.get(path);
			this.configFileGates.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
			return previous === undefined || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size;
		} catch {
			this.configFileGates.delete(path);
			return true;
		}
	}

	/**
	 * 配置面读前门控（models/providers 帧入口调用）：外部手改（编辑器/桌面 pi/
	 * 其他客户端）即时可见，不需要重启网关。文件没变时零开销（一次 statSync）。
	 */
	/**
	 * 配置门控是否生效。判据：**显式指定了 agentDir（隔离到具体目录）就生效**；
	 * 否则若注入了 registry/enabledModels 读写（测试/嵌入方的 scripted 实现，
	 * 不指向真实文件）则跳过——避免无意义地 stat/读真实 `~/.pi`。生产永远没有
	 * 这些注入，门控照常生效。
	 */
	private configGatingActive(injected: boolean): boolean {
		return this.agentDir !== undefined || !injected;
	}

	async ensureConfigFresh(): Promise<void> {
		if (
			this.configGatingActive(this.modelRegistryOverride !== undefined) &&
			this.configFileChanged(this.modelsConfigPath())
		) {
			await this.refreshModelRuntime();
		}
		await this.ensureSettingsFresh();
	}

	/**
	 * `settings.json` 的读/写前门控。用 pi 公开的 `SettingsManager.reload()`
	 * **同实例**重读——不重建：重建会丢 `projectTrusted`，且把旧实例 writeQueue
	 * 中未落盘的写孤儿化。写路径也必须先走这里，否则
	 * `setEnabledModels([...陈旧 current, pattern])` 会覆盖用户手改的条目。
	 */
	async ensureSettingsFresh(): Promise<void> {
		const injected =
			this.enabledModelsLoaderOverride !== undefined ||
			this.enabledModelsAppenderOverride !== undefined ||
			this.enabledModelsRemoverOverride !== undefined ||
			this.enabledModelsSetterOverride !== undefined;
		if (!this.configGatingActive(injected)) return;
		if (!this.configFileChanged(this.settingsConfigPath())) return;
		try {
			if (!this.settingsManager) {
				// 首次 create 就是读最新，无需再 reload。
				this.settingsManager = SettingsManager.create(process.cwd(), this.agentDir);
				return;
			}
			await this.settingsManager.reload();
		} catch (error) {
			// 读取失败（EACCES/IO）不是"已读到降级状态"：清掉指纹让下一帧重试，
			// 否则本次外部修改会被永久跳过（内存持续陈旧，写路径又会基于它回写）。
			this.configFileGates.delete(this.settingsConfigPath());
			this.log(`settings reload failed: ${String(error)}`);
		}
	}

	/** 模型定义存在性（registry 全量池）。对标 pi CLI resolveCliModel：它刻意用
	 * getModels() 全量而非 getAvailable()（允许 --api-key 首次配置），message 帧
	 * 的 model 预校验用同一口径，在会话创建之前拒绝不存在的模型。 */
	async modelDefinitionExists(provider: string, modelId: string): Promise<boolean> {
		const registry = await this.registry();
		return registry.getModel(provider, modelId) !== undefined;
	}

	/** Models with configured auth, grouped by provider (pi `getAvailable`). */
	async listModels(): Promise<WireModelGroup[]> {
		// 读前门控：外部手改 models.json/settings.json 后，打开模型菜单即最新。
		await this.ensureConfigFresh();
		// resolveModelScope 只消费 getAvailable()；测试注入的 fake registry 满足。
		const modelRuntime = (await this.registry()) as ModelRuntime;
		let available = await modelRuntime.getAvailable();
		// pi /model 默认显示非空的已解析scope；未配置或全部无匹配时回到可用目录。
		// 复用SDK resolver处理provider/model、glob与":level"，不以模型定义目录
		// 替代全局settings的启用范围。
		const patterns = this.enabledModelPatterns();
		if (patterns?.length) {
			const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
			if (scopedModels.length > 0) {
				const enabled = new Set(scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`));
				available = available.filter((model) => enabled.has(`${model.provider}/${model.id}`));
			}
		}
		const groups = new Map<string, WireModelInfo[]>();
		for (const raw of available) {
			const parsed = toWireModel(raw);
			if (!parsed) continue;
			const models = groups.get(parsed.provider) ?? [];
			models.push(parsed.model);
			groups.set(parsed.provider, models);
		}
		return [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, models]) => ({ provider, models: models.sort((a, b) => a.id.localeCompare(b.id)) }));
	}

	/** Explicit editing requires a fresh, valid settings snapshot, never a fallback to all. */
	private async modelScopePatterns(): Promise<string[]> {
		if (this.enabledModelsLoaderOverride) return [...(this.enabledModelsLoaderOverride() ?? [])];
		this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
		await this.settingsManager.flush();
		await this.settingsManager.reload();
		if (this.settingsManager.drainErrors().length > 0) {
			throw new ModelScopeError("scope-read-failed", "Pi设置读取失败，请在电脑端检查配置后重试");
		}
		const patterns = this.settingsManager.getGlobalSettings().enabledModels;
		if (patterns !== undefined && (!Array.isArray(patterns) || !patterns.every((item) => typeof item === "string"))) {
			throw new ModelScopeError("scope-read-failed", "Pi模型范围格式无效，请在电脑端修正后重试");
		}
		return [...(patterns ?? [])];
	}

	async modelScope(): Promise<WireModelScope> {
		await this.ensureConfigFresh();
		const patterns = await this.modelScopePatterns();
		const registry = (await this.registry()) as ModelRuntime;
		const available = await registry.getAvailable();
		const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, registry);
		const selected =
			scopedModels.length > 0
				? scopedModels.map(({ model, thinkingLevel }) => ({
						provider: model.provider,
						modelId: model.id,
						thinkingLevel,
					}))
				: available.map((model) => ({ provider: model.provider, modelId: model.id }));
		const groups = new Map<string, WireModelInfo[]>();
		for (const raw of available) {
			const parsed = toWireModel(raw);
			if (!parsed) continue;
			const models = groups.get(parsed.provider) ?? [];
			models.push(parsed.model);
			groups.set(parsed.provider, models);
		}
		return {
			patterns,
			groups: [...groups.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([provider, models]) => ({ provider, models: models.sort((a, b) => a.id.localeCompare(b.id)) })),
			selected,
			unmatchedPatterns: [
				...new Set(
					diagnostics
						.filter((item) => item.code === "no-match")
						.map((item) => item.pattern)
						.filter((pattern): pattern is string => typeof pattern === "string"),
				),
			],
		};
	}

	async saveModelScope(
		expectedPatterns: string[],
		models: ModelScopeSelection[],
		preserveUnmatched: boolean,
		reset: boolean,
	): Promise<WireModelScope> {
		return this.enqueueSettingsWrite(async () => {
			const current = await this.modelScope();
			if (JSON.stringify(current.patterns) !== JSON.stringify(expectedPatterns)) {
				throw new ModelScopeError("scope-conflict", "模型范围已在电脑端或其他设备更改，请重新加载后保存");
			}
			if ((!reset && models.length === 0) || (reset && models.length !== 0)) {
				throw new ModelScopeError("bad-request", "请选择模型，或明确恢复Pi默认范围");
			}
			const available = new Set(
				current.groups.flatMap((group) => group.models.map((model) => `${group.provider}/${model.id}`)),
			);
			const seen = new Set<string>();
			const patterns = models.map((model) => {
				const key = `${model.provider}/${model.modelId}`;
				if (
					!available.has(key) ||
					seen.has(key) ||
					(model.thinkingLevel !== undefined &&
						!THINKING_LEVELS.includes(model.thinkingLevel as (typeof THINKING_LEVELS)[number]))
				) {
					throw new ModelScopeError("bad-request", "范围含不可用或重复模型，请重新加载");
				}
				seen.add(key);
				return key + (model.thinkingLevel ? `:${model.thinkingLevel}` : "");
			});
			if (!reset && preserveUnmatched) patterns.push(...current.unmatchedPatterns);
			const next = [...new Set(patterns)];
			if (this.enabledModelsSetterOverride) await this.enabledModelsSetterOverride(next);
			else {
				if (this.enabledModelsLoaderOverride) throw new ModelScopeError("scope-save-failed", "模型范围保存不可用");
				this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
				this.settingsManager.setEnabledModels(next);
			}
			if (JSON.stringify(await this.modelScopePatterns()) !== JSON.stringify(next)) {
				throw new ModelScopeError("scope-save-failed", "模型范围未确认写入，请重新加载核对");
			}
			// No setModel: saving scope never changes an active/historical conversation model.
			const { scopedModels } = await resolveModelScopeWithDiagnostics(next, (await this.registry()) as ModelRuntime);
			for (const handle of this.handles.values()) {
				if (!handle.disposed) handle.session.setScopedModels?.(scopedModels);
			}
			return this.modelScope();
		});
	}

	/** 全局 `enabledModels` patterns；未配置或读取失败返回 undefined（不过滤）。 */
	private enabledModelPatterns(): string[] | undefined {
		try {
			const patterns = this.enabledModelsLoaderOverride
				? this.enabledModelsLoaderOverride()
				: this.defaultEnabledModelPatterns();
			return patterns && patterns.length > 0 ? patterns : undefined;
		} catch (error) {
			this.log(`enabledModels unavailable, model menu unfiltered: ${String(error)}`);
			return undefined;
		}
	}

	/**
	 * Admit a phone-saved provider into the global `enabledModels` scope list
	 * (idempotent). pi 的 pattern 语义：含通配符才按 `provider/id` 做 glob 匹配，裸
	 * provider id 走精确匹配且必然无命中（pi 会报 "No models match pattern"），所以
	 * 这里写 `providerId/*`。未配置 enabledModels 时**不写**：那时菜单不过滤，
	 * 追一条反而把全量变成白名单、隐藏其他所有模型。Returns false only when a
	 * needed write failed.
	 */
	async admitEnabledModel(providerId: string): Promise<boolean> {
		// 门控 reload → 读 current → 写 这段必须原子：见 settingsWriteTail 注释。
		return this.enqueueSettingsWrite(async () => {
			const pattern = `${providerId}/*`;
			// 写前门控：先 reload 拿最新盘态再算 [...current, pattern]，否则陈旧内存
			// 全量回写会覆盖用户手改的 enabledModels 条目（丢失更新）。
			await this.ensureSettingsFresh();
			try {
				const current = this.enabledModelsLoaderOverride
					? this.enabledModelsLoaderOverride()
					: this.defaultEnabledModelPatterns();
				if (!current || current.length === 0) return true;
				if (current.includes(pattern)) return true;
				if (this.enabledModelsAppenderOverride) {
					this.enabledModelsAppenderOverride(pattern);
					return true;
				}
				this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
				this.settingsManager.setEnabledModels([...current, pattern]);
				return true;
			} catch (error) {
				this.log(`enabledModels append failed for ${providerId}: ${String(error)}`);
				return false;
			}
		});
	}

	/**
	 * 从全局 enabledModels 删除匹配的 pattern（幂等）。同步 override 逐条回调，
	 * 保证测试注入路径与真实写路径同语义。Returns false only when a needed write failed.
	 */
	private async removeEnabledModelPatternsWhere(shouldRemove: (pattern: string) => boolean): Promise<boolean> {
		// 与 admitEnabledModel 对称：同样串进 settingsWriteTail（见其注释）。
		return this.enqueueSettingsWrite(async () => {
			// 与 admitEnabledModel 对称的写前门控。
			await this.ensureSettingsFresh();
			try {
				const current = this.enabledModelsLoaderOverride
					? this.enabledModelsLoaderOverride()
					: this.defaultEnabledModelPatterns();
				if (!current || current.length === 0) return true;
				const removed = current.filter(shouldRemove);
				if (removed.length === 0) return true;
				if (this.enabledModelsRemoverOverride) {
					for (const pattern of removed) this.enabledModelsRemoverOverride(pattern);
					return true;
				}
				this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
				this.settingsManager.setEnabledModels(current.filter((entry) => !shouldRemove(entry)));
				return true;
			} catch (error) {
				this.log(`enabledModels remove failed: ${String(error)}`);
				return false;
			}
		});
	}

	/** 手机端在 provider 编辑里删掉几个模型行时，把这些模型的**具体** pattern
	 * （`providerId/<模型id>`）从全局 enabledModels 清掉。此前只 append 不清理，
	 * 被删模型的 pattern 会永久残留（实测 `relayA/example-model-flash` 等）。 */
	async removeEnabledModelPatterns(providerId: string, modelIds: string[]): Promise<boolean> {
		const targets = new Set(modelIds.map((modelId) => `${providerId}/${modelId}`));
		// 条目可能带 pi 的 `:<thinkingLevel>` 后缀（`provider/model:high` 手写合法），
		// 比较前剥掉，否则这种条目清不掉（reviewer 抓到的漏网）。
		return this.removeEnabledModelPatternsWhere((pattern) => targets.has(stripThinkingLevelSuffix(pattern)));
	}

	/** 删除整个 provider 时清掉它的**所有** pattern：`providerId/*` 与
	 * `providerId/<模型id>` 都算。此前只删 `providerId/*`，具体模型的 pattern
	 * 不匹配通配符形态、会永久残留。 */
	async removeEnabledModelPatternsForProvider(providerId: string): Promise<boolean> {
		return this.removeEnabledModelPatternsWhere((pattern) => pattern.startsWith(`${providerId}/`));
	}

	private defaultEnabledModelPatterns(): string[] | undefined {
		this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
		return this.settingsManager.getGlobalSettings().enabledModels;
	}

	/** 等待 SettingsManager 的异步写队列落盘（flush 是 pi 公开 API；测试断言用）。 */
	async flushSettingsWrites(): Promise<void> {
		await this.settingsManager?.flush();
	}

	/** settings 的 defaultProvider/defaultModel（比较用 provider/id 引用即可）。 */
	private savedDefaultModelRef(): { provider: string; id: string } | undefined {
		try {
			this.settingsManager ??= SettingsManager.create(process.cwd(), this.agentDir);
			const provider = this.settingsManager.getDefaultProvider();
			const modelId = this.settingsManager.getDefaultModel();
			if (!provider || !modelId) return undefined;
			return { provider, id: modelId };
		} catch {
			return undefined;
		}
	}

	/**
	 * Switch the session's model. Session-only by design: pi appends a
	 * `model_change` entry so the choice survives resume, while global defaults
	 * stay untouched (`persist: false`). `thinkingLevel` is applied *after* the
	 * switch because `setModel` resets the level to the new model's default.
	 * Returns the effective state — pi clamps a level the model does not
	 * support, and the caller must see what actually took effect.
	 */
	async setModel(
		sessionId: string,
		provider: string,
		modelId: string,
		thinkingLevel?: string,
	): Promise<WireSessionState> {
		const handle = await this.openSession(sessionId);
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		// Touch the handle before any await so the idle sweeper cannot reclaim
		// the session while the registry (first call: full `ModelRuntime.create()`
		// disk read) resolves.
		live.lastActivity = this.now();
		const registry = await this.registry();
		const model = registry.getModel(provider, modelId);
		if (model === undefined) throw new ModelChangeError(`unknown model: ${provider}/${modelId}`);
		if (live.disposed) throw new SessionNotFoundError(sessionId);
		try {
			await handle.session.setModel(model, { persist: false });
			if (thinkingLevel !== undefined) handle.session.setThinkingLevel(thinkingLevel);
		} catch (error) {
			// pi's own validation (no API key for the provider, …) is
			// client-actionable and carries no filesystem paths.
			throw new ModelChangeError(error instanceof Error ? error.message : String(error));
		}
		if (live.disposed) throw new SessionNotFoundError(sessionId);
		return this.liveState(sessionId, live);
	}

	// -- session name / compaction ---------------------------------------------

	/** 会话改名（pi `setSessionName`）：持久落到会话文件，sessions 索引的 `name`
	 *  随之更新（客户端列表展示的 `displayTitle` 优先 name）。 */
	async setSessionName(sessionId: string, name: string): Promise<WireSessionState> {
		const handle = await this.openSession(sessionId);
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		live.lastActivity = this.now();
		try {
			handle.session.setSessionName(name);
		} catch (error) {
			// pi 侧校验失败不含路径，可回显给客户端。
			throw new SessionNameError(error instanceof Error ? error.message : String(error));
		}
		return this.liveState(sessionId, live);
	}

	/**
	 * 重建会话：dispose 现有 SDK AgentSession 并重新 openSession（createAgentSession
	 * 内部 resourceLoader.reload()），获得与桌面 pi `/reload`+重开等价的语义——
	 * AGENTS.md/settings/extensions/skills/prompts/themes 全部新鲜读取，消息历史
	 * 从会话文件重放，model 由 model_change 条目恢复。运行中（isStreaming/
	 * isCompacting）拒绝：重建会中断进行中的 run。事件订阅者迁移到新 handle，
	 * seq 从头计数（客户端走重连 catch-up 语义）。
	 */
	async restartSession(sessionId: string): Promise<WireSessionState> {
		const existing = this.handles.get(sessionId);
		if (existing && !existing.disposed && (existing.session.isStreaming || existing.session.isCompacting)) {
			throw new SessionRestartError(sessionId);
		}
		const carriedSubscribers = existing ? [...existing.subscribers] : [];
		if (existing) {
			this.log(`restarting session ${sessionId}`);
			this.disposeHandle(existing);
		}
		// 配置语义对齐 pi 重开：手动叶子属于旧运行时视图，一并释放。
		this.manualLeafIds.delete(sessionId);
		await this.openSession(sessionId);
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		for (const sink of carriedSubscribers) live.subscribers.add(sink);
		return this.liveState(sessionId, live);
	}

	/** 手动压缩（pi 原生 /compact 语义）：compact() 会先中止当前运行，随后开始
	 *  压缩流程；compaction_start/compaction_end 事件本来就经事件流透传给订阅
	 *  客户端，本帧只回触发时的状态快照（isCompacting 由 pi 翻转）。 */
	async beginCompact(sessionId: string): Promise<WireSessionState> {
		const handle = await this.openSession(sessionId);
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		live.lastActivity = this.now();
		void handle.session.compact().catch((error) => {
			// 启动失败（如未选模型）无法直接回帧（本帧已应答）：进日志，
			// 客户端可从 state 轮询看到 isCompacting 未翻转。
			this.log(`compact of ${sessionId} failed: ${String(error)}`);
		});
		return this.liveState(sessionId, live);
	}

	// -- session tree / branch switching -----------------------------------------

	/** 会话树（pi `sessionManager.getTree()` 投影）：全量 entries 按 parentId
	 *  构树（含被放弃的分支），children 按时间排序，活跃 root 排前。当前叶子
	 *  与当前分支路径由客户端依 leafId 高亮。 */
	async tree(
		sessionId: string,
		view?: TreeViewOptions,
	): Promise<{ leafId: string | null; nodes: WireTreeNode[]; selectedId?: string | null }> {
		// 与 history 同一读取路径：每次重新打开会话文件投影。会话可能被其他
		// pi 客户端（桌面 CLI）并发写入，live handle 的内存 entries 是打开时的
		// 快照——复用它会让 tree 停留在陈旧状态而 history 却能看到新内容，
		// 两个视图不一致（实测 12:17 快照 vs 12:41 文件）。
		const path = await this.resolveSessionPath(sessionId);
		if (path === null) throw new SessionNotFoundError(sessionId);
		const sessionManager = this.openSessionManager(path);
		// 旧客户端保留有界窗口；view请求先在全量树筛选、折叠并返回完整结果。
		// DFS是展示顺序，不是跨分支的全局时间排序。
		// leafId 参与投影：活跃标记（`• `）与“含活跃叶子的分支排同级最前”都在网关
		// 算好（pi flattenTree 同样用它排序），客户端零布局逻辑。
		const entries: SessionEntry[] = sessionManager.getEntries();
		const leafId = this.dropStaleManualLeaf(sessionId, entries) ?? sessionManager.getLeafId();
		const projected = toWireTreeNodes(sessionManager.getTree(), leafId, view);
		const nodes = view ? projected : trimTreeNodes(projected, this.treeMaxLimit);
		const visible = new Set(nodes.map((node) => node.id));
		const parents = new Map(entries.map((entry) => [entry.id, entry.parentId]));
		let selectedId = leafId;
		while (selectedId !== null && !visible.has(selectedId)) selectedId = parents.get(selectedId) ?? null;
		selectedId ??= nodes.at(-1)?.id ?? null;
		// leafId 优先取分支切换后的手动叶子，否则树页的活跃路径高亮停在 file 尾。
		// 钉子失效（外部改写）同样自愈：与 history 共用有效性判断，免得高亮飘到 ghost id。
		return { leafId, nodes, ...(view ? { selectedId } : {}) };
	}

	/** File completion must not instantiate a model/session for each keystroke. */
	async inputCwd(context: InputContext): Promise<string> {
		const directory = (cwd: string) => {
			try {
				return validateCwd(cwd);
			} catch {
				throw new InputAssistError("bad-request", "cwd must be an existing absolute directory");
			}
		};
		if (context.cwd !== undefined) return directory(context.cwd);
		const live = this.handles.get(context.sessionId);
		if (live && !live.disposed) return directory(live.sessionManager.getCwd());
		const path = await this.resolveSessionPath(context.sessionId);
		if (!path) throw new InputAssistError("session-not-found", "session not found");
		return directory(SessionManager.open(path, this.sessionDir).getCwd());
	}

	async inputResources(context: InputContext, cwd: string): Promise<InputResources> {
		if (context.cwd !== undefined) return previewInputResources(cwd, this.agentDir);
		const handle = await this.openSession(context.sessionId);
		return sessionInputResources(handle.session, cwd);
	}

	/** 会话级自定义命令清单（三源：扩展/模板/skill，对齐 pi RPC get_commands）。
	 * 按需加载会话；三源逐个判空降级（fake 会话无此三 getter）。TUI 内建
	 * 命令不在 session 层，不在此列。 */
	async listCommands(sessionId: string): Promise<WireSlashCommand[]> {
		const handle = await this.openSession(sessionId);
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		const session = handle.session;
		const extensions =
			session.extensionRunner?.getRegisteredCommands()?.map((command) => ({
				name: command.invocationName,
				description: command.description,
				sourceInfo: command.sourceInfo,
			})) ?? [];
		const templates = session.promptTemplates ?? [];
		const skills = session.resourceLoader?.getSkills()?.skills ?? [];
		return toWireSlashCommands({ extensions, templates, skills });
	}

	/** 内部钉子有效性：id 须在文件全部 entries 中，否则自愈丢弃回文件尾（history/tree 共用）。 */
	private dropStaleManualLeaf(sessionId: string, entries: SessionEntry[]): string | undefined {
		const manualLeafId = this.manualLeafIds.get(sessionId);
		if (manualLeafId !== undefined && !entries.some((entry) => entry.id === manualLeafId)) {
			this.manualLeafIds.delete(sessionId);
			this.log(`stale manual leaf dropped for ${sessionId}`);
			return undefined;
		}
		return manualLeafId;
	}

	/** 当前叶子：pi 原生从 sessionManager 取（TUI 的 realLeafId 语义）。 */
	private currentLeafId(handle: LiveHandle): string | null {
		try {
			const value = handle.sessionManager.getLeafId();
			return typeof value === "string" ? value : null;
		} catch {
			return null;
		}
	}

	/**
	 * 切换分支（pi `/tree` 选择条目 → `navigateTree(entryId, {summarize:false})`，
	 * 对齐 TUI showTreeSelector 的回调语义）：
	 * - 目标即当前叶子 → 不导航，客户端提示 "Already at this point"；
	 * - 压缩进行中拒绝（pi 的 accept 在 lane 忙时同样拒绝）；
	 * - 流式中：先取走排队消息（pi TUI 会把它们恢复回编辑器，mobile 转由
	 *   客户端处理），abort 当前运行，再 navigate。
	 * 响应带 editorText（target 是 user/custom 消息时为目标内容，供草稿恢复）
	 * 与 queued（被取走的排队消息文本）。
	 */
	async switchBranch(
		sessionId: string,
		entryId: string,
	): Promise<{
		entryId: string;
		leafId: string | null;
		alreadyAt: boolean;
		editorText: string | null;
		queued: string[];
		state: WireSessionState;
	}> {
		const live = this.handles.get(sessionId);
		if (!live || live.disposed) throw new SessionNotFoundError(sessionId);
		if (live.session.isCompacting) {
			throw new SessionNameError("压缩进行中，请等压缩完成后再切换分支");
		}

		const leafId = this.currentLeafId(live);
		if (leafId !== null && entryId === leafId) {
			return {
				entryId,
				leafId,
				alreadyAt: true,
				editorText: null,
				queued: [],
				state: this.liveState(sessionId, live),
			};
		}

		// 流式中对齐 pi TUI：取走排队消息（TUI 会恢复进编辑器），中止当前运行。
		const queued: string[] = [];
		if (live.session.isStreaming) {
			queued.push(...live.session.getSteeringMessages(), ...live.session.getFollowUpMessages());
		}
		if (live.session.isStreaming) {
			await live.session.abort();
		}

		const session = live.session as unknown as {
			navigateTree: (
				targetId: string,
				options: { summarize: boolean },
			) => Promise<{ editorText?: string; cancelled?: boolean }>;
		};
		live.lastActivity = this.now();
		const result = await session.navigateTree(entryId, { summarize: false });
		if (result.cancelled) {
			// pi 的 accept 层拒绝（LaneBusy/UnknownTarget 等）：如实映射 bad-request。
			throw new SessionNameError(result.editorText ?? "切换被拒绝");
		}
		const newLeafId = this.currentLeafId(live);
		if (newLeafId !== null) this.manualLeafIds.set(sessionId, newLeafId);
		return {
			entryId,
			leafId: newLeafId,
			alreadyAt: false,
			editorText: typeof result.editorText === "string" ? result.editorText : null,
			queued,
			state: this.liveState(sessionId, live),
		};
	}

	// -- history / state --------------------------------------------------------

	async history(
		sessionId: string,
		beforeEntryId: string | undefined,
		limit: number | undefined,
		resetLeaf?: boolean,
		turnLimit?: number,
	): Promise<HistoryPage & { state: WireSessionState; latestEntryId: string | null }> {
		const startedAt = performance.now();
		const path = await this.resolveSessionPath(sessionId);
		const resolvedAt = performance.now();
		if (path === null) throw new SessionNotFoundError(sessionId);
		const fileSessionManager = this.openSessionManager(path);
		const fileEntries: SessionEntry[] = fileSessionManager.getEntries();
		const readAt = performance.now();
		const live = this.handles.get(sessionId);
		// Pi 的 SessionManager 在首个 assistant 写入前会延迟创建/刷新 session
		// 文件；这时 user 条目只存在 live handle 的内存树里。重连中的手机若只读
		// 文件，会把刚发出的 user 消息误判成不存在。保留文件视图，同时并入 live
		// 尚未出现在文件中的条目；文件外部追加的条目仍由 fileEntries 提供。
		const liveEntries =
			live && !live.disposed && live.session.sessionFile === path ? live.sessionManager.getEntries() : [];
		const fileEntryIds = new Set(fileEntries.map((entry) => entry.id));
		// 两个可证明的未落盘窗口才并入 live，且共用同一前缀防护（文件视图必须
		// 是 live 条目的前缀，文件不存在/为空时平凡成立），避免 live 内存快照
		// 陈旧时把外部重写已经删除的条目复活：
		// 1) 首 assistant 前延迟建文件（Pi SDK `_persist` 的既语义，不要求流式中）；
		// 2) 旧会话 run 进行中：pi 的 `_handleAgentEvent` 先 emit 事件、后
		//    `appendMessage` 落盘（本会话 emit→append 的微任务窗口内文件暂缺
		//    当前 in-flight user），另要求 isStreaming 作为 in-flight 证据。
		// 前缀不成立＝文件被外部重写/重排，live 视为陈旧不并入。外部删除文件
		// 尾部的复活风险与 pi 自身在该病态场景的数据不一致同源，属可接受残余
		// （PROTOCOL §4.6）。
		const fileHasAssistant = fileEntries.some(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		const fileIsLivePrefix =
			liveEntries.length > 0 &&
			fileEntries.length <= liveEntries.length &&
			fileEntries.every((entry, index) => liveEntries[index]?.id === entry.id);
		const liveStreamingAhead = fileIsLivePrefix && live !== undefined && !live.disposed && live.session.isStreaming;
		const mergeLiveTail = fileIsLivePrefix && (!fileHasAssistant || liveStreamingAhead);
		const liveEntriesAhead = mergeLiveTail ? liveEntries.filter((entry) => !fileEntryIds.has(entry.id)) : [];
		const entries: SessionEntry[] = fileEntries.concat(liveEntriesAhead);
		const liveLeafId =
			live && !live.disposed && live.session.sessionFile === path ? live.sessionManager.getLeafId() : null;
		const liveUnflushedLeafId =
			mergeLiveTail && liveLeafId !== null && !fileEntryIds.has(liveLeafId) ? liveLeafId : undefined;
		const effectiveLimit = Math.min(Math.max(limit ?? this.historyDefaultLimit, 1), this.historyMaxLimit);
		// 重连 catch-up = pi TUI 重开会话（对齐"重开会话回文件尾"语义）：释放
		// 手动叶子、活跃链回文件尾，断连期间主线新消息随本次重拉回到客户端。
		// 翻页（beforeEntryId）永不重置；运行时叶子的同步是 best-effort（流式中
		// pi 的 accept 层可能拒绝，不阻塞 history 返回），无 live handle 时下次
		// prompt 开新 handle 自然从文件尾恢复。
		if (resetLeaf === true && beforeEntryId === undefined) {
			// pi accept 层拒绝（流式中 LaneBusy 等）时必须恢复手动叶子：运行时
			// 叶子仍停在旧分支、后续 prompt 也会落旧分支，文件视图必须跟着钉住，
			// 否则 UI 显示主线而用户消息落旧分支（reviewer Finding P2）。
			const previousManualLeaf = this.manualLeafIds.get(sessionId);
			this.manualLeafIds.delete(sessionId);
			const live = this.handles.get(sessionId);
			if (live && !live.disposed) {
				try {
					const value = fileSessionManager.getLeafId();
					if (typeof value === "string") {
						const session = live.session as unknown as {
							navigateTree: (
								targetId: string,
								options: { summarize: boolean },
							) => Promise<{ editorText?: string; cancelled?: boolean }>;
						};
						const result = await session.navigateTree(value, { summarize: false });
						if (result.cancelled && previousManualLeaf !== undefined) {
							this.manualLeafIds.set(sessionId, previousManualLeaf);
						}
					}
				} catch {
					// best-effort 失败同样恢复，保持两视图一致。
					if (previousManualLeaf !== undefined) {
						this.manualLeafIds.set(sessionId, previousManualLeaf);
					}
				}
			}
		}
		// 历史分页是"文件视图"而非模型上下文视图：sliceActiveBranchTail 直接
		// 切原始活跃链，页内条目全部上送（compaction 条目由 entryToWireMessage
		// 渲染为标记行）。此前页内切片还独立套一层 buildContextEntries（模型
		// 上下文视图）：页内含 compaction 时会丢弃/重排页内条目，产生薄页
		// （limit=60 首页只渲染 9 条）与跨页重复+乱序（实测 limit=100 首页
		// 85 条与下一页重复）；且上下文视图里 compaction 之前的内容不可达，
		// older 分页会翻不到压缩前的历史。pi TUI 无分页概念（一次渲染
		// buildContextEntries 全视图），移动端分页浏览取文件视图更贴用户诉求。
		const manualLeafId = this.dropStaleManualLeaf(sessionId, entries);
		// 手动叶子优先；否则若 live 里有尚未落盘的当前叶子，从它切活跃链，
		// 不能退回文件尾把刚发出的 user 条目截掉。
		const startLeafId = manualLeafId ?? liveUnflushedLeafId;
		// limit 按原始条目计数。整页若只有元数据，capHistoryPage([]) 会误报到头；
		// 沿最旧条目继续前切，直到有 wire 消息或抵达链头。有消息的页照常返回。
		let cursor = beforeEntryId;
		const turnPage =
			turnLimit === undefined
				? null
				: historyTurnPage(entries, Math.min(Math.max(turnLimit, 1), 10), this.historyMaxBytes, cursor, startLeafId);
		this.log(
			`history-read resolveMs=${(resolvedAt - startedAt).toFixed(1)} readMs=${(readAt - resolvedAt).toFixed(1)} pageMs=${(performance.now() - readAt).toFixed(1)} entries=${entries.length}`,
		);
		let sliced = turnPage
			? { entries: [] as SessionEntry[], hasMore: false }
			: sliceActiveBranchTail(entries, effectiveLimit, cursor, startLeafId);
		if ("error" in sliced) throw new Error(`unknown beforeEntryId: ${beforeEntryId}`);
		let messages: WireMessage[] = [];
		let entryIds: string[] = [];
		for (;;) {
			messages = [];
			entryIds = [];
			for (const entry of sliced.entries) {
				const message = entryToWireMessage(entry);
				if (message) {
					// Per-message budget with a hard stub bound, so a single huge
					// message (image base64, giant tool output) cannot pierce the
					// page cap and invalidate the paging contract.
					messages.push(sanitizeHistoryMessage(message));
					entryIds.push(entry.id);
				}
			}
			if (messages.length > 0 || !sliced.hasMore) break;
			const oldest = sliced.entries.length > 0 ? sliced.entries[0] : undefined;
			if (!oldest || oldest.id === cursor) break;
			cursor = oldest.id;
			const older = sliceActiveBranchTail(entries, effectiveLimit, cursor, startLeafId);
			// 本页条目都在活跃链上，向前取祖先不可能落到链外；防御性收束，不抛。
			if ("error" in older) break;
			sliced = older;
		}
		const state = this.stateFrom(sessionId, entries);
		let latestEntryId: string | null = null;
		try {
			const value = fileSessionManager.getLeafId();
			latestEntryId = typeof value === "string" ? value : null;
		} catch {
			latestEntryId = null;
		}
		// 并入了 live 未落盘尾部时，最新应以活跃链为准：仍报文件水位会让客户端
		// 把“已显示 in-flight user”误判成落后于最新（isBehindLatest 误报）。
		// 与 liveUnflushedLeafId 同源取 live 叶子（getLeafId），缺省回退并入
		// 视图的最后一条。
		if (liveEntriesAhead.length > 0) {
			latestEntryId = liveLeafId ?? entries.at(-1)?.id ?? latestEntryId;
		}
		return {
			...(turnPage ?? capHistoryPage(messages, entryIds, this.historyMaxBytes, sliced.hasMore)),
			state,
			// 文件视图最新叶子（与 tree 帧 getLeafId 同源同语义，不受 manualLeafIds
			// 影响）：客户端拿活跃链尾与之比对，落后即提示"跳到最新"。
			latestEntryId,
		};
	}

	/** (mtime,size) 门控的 SessionManager 复用。 */
	private openSessionManager(path: string): SessionManager {
		// 新会话的 sent 补拉发生在 prompt 首轮落盘之前，此时 jsonl 还不存在：
		// SessionManager.open 对缺失文件宽容（空会话），statSync 则会 ENOENT。
		// 不缓存缺失文件，落回直接 open 的原语义。
		let mtimeMs = Number.NaN;
		let size = Number.NaN;
		try {
			const stats = statSync(path);
			mtimeMs = stats.mtimeMs;
			size = stats.size;
		} catch {
			this.projectionCache.delete(path);
			return SessionManager.open(path, this.sessionDir);
		}
		const stats = { mtimeMs, size };
		const cached = this.projectionCache.get(path);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return cached.manager;
		}
		const manager = SessionManager.open(path, this.sessionDir);
		this.projectionCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, manager });
		if (this.projectionCache.size > 4) {
			const oldest = this.projectionCache.keys().next().value;
			if (oldest !== undefined && oldest !== path) this.projectionCache.delete(oldest);
		}
		return manager;
	}

	/** Cheap reconciliation poll: live state when loaded, file-derived otherwise. */
	async state(sessionId: string): Promise<WireSessionState> {
		const live = this.handles.get(sessionId);
		if (live) return this.liveState(sessionId, live);
		const path = await this.resolveSessionPath(sessionId);
		if (path === null) throw new SessionNotFoundError(sessionId);
		const entries = this.openSessionManager(path).getEntries();
		return this.stateFrom(sessionId, entries);
	}

	private stateFrom(sessionId: string, entries: SessionEntry[]): WireSessionState {
		const live = this.handles.get(sessionId);
		if (live) return this.liveState(sessionId, live);
		const derived = deriveSettingsFromEntries(entries);
		return {
			sessionId,
			isStreaming: false,
			isCompacting: false,
			model: derived.model,
			thinkingLevel: derived.thinkingLevel,
			queuedMessages: { steering: [], followUp: [] },
			contextUsage: null,
		};
	}

	private liveState(sessionId: string, live: LiveHandle): WireSessionState {
		const model = live.session.model;
		const usage = live.session.getContextUsage();
		return {
			sessionId,
			isStreaming: live.session.isStreaming,
			isCompacting: live.session.isCompacting,
			model: model ? { provider: model.provider, modelId: model.id } : null,
			thinkingLevel: live.session.thinkingLevel,
			queuedMessages: {
				steering: [...live.session.getSteeringMessages()],
				followUp: [...live.session.getFollowUpMessages()],
			},
			contextUsage: usage ? { percent: usage.percent, contextWindow: usage.contextWindow, tokens: usage.tokens } : null,
		};
	}

	// -- attachment (§4.22 历史图片按需读取) ------------------------------------

	/**
	 * 按三元组 (sessionId, entryId, imageIndex) 读取 user 消息里的原图。只用 pi
	 * 公开 `SessionManager.getEntry()`，不为读图建 AgentSession/触发模型。
	 *
	 * 读取路径：先查同 session 的 live SessionManager（覆盖新会话尚未落盘的
	 * 消息）；live 不存在或其中没有该 entry 时，再读该会话当前文件视图
	 * （桌面 pi 后来追加的条目，live 内存快照可能看不到；(mtime,size) 门控
	 * 缓存对并发追加已失效自刷新）。两处都以 session 身份为归属校验。
	 */
	async attachment(
		sessionId: string,
		entryId: string,
		imageIndex: number,
	): Promise<{
		sessionId: string;
		entryId: string;
		imageIndex: number;
		mediaType: string;
		bytes: number;
		dataBase64: string;
	}> {
		let entry: SessionEntry | undefined;
		const live = this.handles.get(sessionId);
		if (live && !live.disposed) {
			try {
				entry = live.sessionManager.getEntry(entryId);
			} catch (error) {
				// live 读取异常不致命：落到文件视图再试。
				this.log(`attachment live entry lookup failed for ${sessionId}: ${String(error)}`);
			}
		}
		if (!entry) {
			const path = await this.resolveSessionPath(sessionId);
			if (path === null) throw new SessionNotFoundError(sessionId);
			const manager = this.openSessionManager(path);
			// 文件头 id 是权威身份：陈旧索引解析到别的会话文件时按未找到处理。
			if (manager.getSessionId() !== sessionId) throw new SessionNotFoundError(sessionId);
			entry = manager.getEntry(entryId);
			// 读到文件视图即触碰句柄活跃时间，避免 sweeper 过快回收刚用过的会话。
			if (live && !live.disposed) live.lastActivity = this.now();
		}
		if (!entry) throw new AttachmentNotFoundError(entryId);
		const raw = entry as unknown as Record<string, unknown>;
		const message = raw.type === "message" && isRecord(raw.message) ? raw.message : undefined;
		if (message?.role !== "user") {
			throw new AttachmentNotFoundError(entryId);
		}
		// imageIndex 只按 user content 里的 image 块从 0 计数（路由层已验非负安
		// 全整数，这里只负责语义层边界）。
		const content = Array.isArray(message.content) ? message.content : [];
		const imageBlocks = content.filter(
			(block): block is Record<string, unknown> => isRecord(block) && block.type === "image",
		);
		if (imageIndex < 0 || imageIndex >= imageBlocks.length || !Number.isSafeInteger(imageIndex)) {
			throw new AttachmentNotFoundError(entryId);
		}
		const block = imageBlocks[imageIndex];
		if (typeof block.data !== "string" || block.data.length === 0) {
			throw new AttachmentInvalidError("image block has no base64 payload");
		}
		if (!isValidImageMediaType(block.mimeType)) {
			throw new AttachmentInvalidError("image mimeType must be a bounded image/* string");
		}
		// 先限 base64 长度，再合法性/解码校验：超限路径绝不先把 payload 装进响应。
		if (block.data.length > ATTACHMENT_MAX_BASE64_CHARS) {
			throw new AttachmentTooLargeError();
		}
		if (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
			throw new AttachmentInvalidError("image data is not valid base64");
		}
		const decoded = Buffer.from(block.data, "base64");
		if (decoded.length > ATTACHMENT_MAX_RAW_BYTES) {
			throw new AttachmentTooLargeError();
		}
		return {
			sessionId,
			entryId,
			imageIndex,
			mediaType: block.mimeType,
			bytes: decoded.length,
			dataBase64: block.data,
		};
	}

	// -- lifecycle ------------------------------------------------------------

	private disposeHandle(handle: LiveHandle): void {
		if (handle.disposed) return;
		handle.disposed = true;
		handle.unsubscribe();
		// 清空出站队列：微任务里的残留 flush 对已处置的句柄不得再发帧。
		handle.pendingFrames.length = 0;
		this.handles.delete(handle.session.sessionId);
		try {
			handle.session.dispose();
		} catch (error) {
			this.log(`dispose failed for ${handle.session.sessionId}: ${String(error)}`);
		}
	}

	/** Dispose idle, subscriber-less handles past their grace period. */
	sweep(): void {
		for (const handle of this.handles.values()) {
			if (handle.subscribers.size > 0) continue;
			if (handle.session.isStreaming || handle.session.isCompacting) continue;
			if (this.now() - handle.lastActivity < this.idleDisposeMs) continue;
			this.log(`disposing idle session ${handle.session.sessionId}`);
			this.disposeHandle(handle);
		}
	}

	/** Dispose everything (process shutdown). */
	disposeAll(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
		for (const handle of [...this.handles.values()]) this.disposeHandle(handle);
	}
}

export class SessionNotFoundError extends Error {
	constructor(sessionId: string) {
		super(`session not found: ${sessionId}`);
	}
}

/** Model switch rejected by the client (unknown model) or by pi (no auth, …). */
export class ModelChangeError extends Error {}

/** 会话改名失败（pi 侧校验，消息可回显客户端）。 */
export class SessionRestartError extends Error {
	constructor(sessionId: string) {
		super(`session ${sessionId} is busy; finish the run before restarting`);
		this.name = "SessionRestartError";
	}
}
export class SessionNameError extends Error {}

/** attachment 请求的条目不存在/非 user/索引越界（§4.22：一律 not-found）。 */
export class AttachmentNotFoundError extends Error {
	constructor(entryId: string) {
		super(`attachment entry not found: ${entryId}`);
		this.name = "AttachmentNotFoundError";
	}
}
/** 单图原始字节超过 4 MiB（不发巨大帧）。 */
export class AttachmentTooLargeError extends Error {}
/** mime 非法或 base64 解码失败（消息可回显客户端）。 */
export class AttachmentInvalidError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentInvalidError";
	}
}

function asRecordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Project one pi `Model` (unknown shape at runtime) into a wire picker row. */
function toWireModel(raw: unknown): { provider: string; model: WireModelInfo } | null {
	const record = asRecordValue(raw);
	if (!record) return null;
	const provider = typeof record.provider === "string" ? record.provider : undefined;
	const id = typeof record.id === "string" ? record.id : undefined;
	if (!provider || !id) return null;
	const reasoning = record.reasoning === true;
	const map = asRecordValue(record.thinkingLevelMap);
	// Mirrors pi-ai getSupportedThinkingLevels(): a non-reasoning model is
	// "off" only; `null` marks a level unsupported; xhigh/max need an explicit
	// mapping entry.
	const thinkingLevels = reasoning
		? THINKING_LEVELS.filter((level) => {
				const mapped = map?.[level];
				if (mapped === null) return false;
				if (level === "xhigh" || level === "max") return mapped !== undefined;
				return true;
			})
		: ["off"];
	return {
		provider,
		model: {
			id,
			name: typeof record.name === "string" && record.name !== "" ? record.name : id,
			contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : 0,
			maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : 0,
			reasoning,
			input: wireInput(record.input),
			thinkingLevels: [...thinkingLevels],
		},
	};
}

/** Project a pi `Model.input` into the documented closed set: `["text"]` or
 * `["text","image"]` — a missing or unexpected modality must never leak
 * through as `[]` or an unknown string. */
function wireInput(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["text"];
	const input = raw.filter((value): value is string => value === "text" || value === "image");
	return input.length > 0 ? input : ["text"];
}

/** Validate a client-provided cwd for new sessions. */
export function validateCwd(cwd: string): string {
	if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
	const resolved = resolve(cwd);
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolved);
	} catch {
		throw new Error(`cwd does not exist: ${resolved}`);
	}
	if (!stats.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
	return resolved;
}

export interface ScopedEntryLike {
	model: { provider: string; id: string };
	thinkingLevel?: string;
}

/**
 * pi CLI（main.js buildSessionOptions）的新会话初始模型语义：settings 的
 * `defaultProvider`/`defaultModel` 在 `enabledModels` 解析范围内则优先它，
 * 否则用范围第一项；范围未配置/为空时由pi兜底。恢复已有会话仍传scope，
 * 不传初始model/thinkingLevel，由会话记录恢复当前模型。
 */
export async function selectInitialScopedModel<T extends ScopedEntryLike>(
	hasExistingSession: boolean,
	patterns: string[] | undefined,
	resolveScope: (patterns: string[]) => Promise<T[]>,
	savedDefault: { provider: string; id: string } | undefined,
): Promise<{ entry: T | undefined; scopedModels: T[] }> {
	if (!patterns?.length) {
		return { entry: undefined, scopedModels: [] };
	}
	const scopedModels = await resolveScope(patterns);
	if (scopedModels.length === 0) {
		return { entry: undefined, scopedModels: [] };
	}
	if (hasExistingSession) return { entry: undefined, scopedModels };
	const savedInScope = savedDefault
		? scopedModels.find(
				(scoped) => scoped.model.provider === savedDefault.provider && scoped.model.id === savedDefault.id,
			)
		: undefined;
	return { entry: savedInScope ?? scopedModels[0], scopedModels };
}
