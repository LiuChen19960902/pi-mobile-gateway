// 桥接扩展与网关之间的本机 IPC 契约（Unix socket，换行分隔 JSON）。
//
// 这是网关与扩展之间的私有协议，不是手机看到的 WebSocket 协议（那份在
// 网关 PROTOCOL.md）。两边同仓维护，schema 变化必须同时改网关客户端。

export const BRIDGE_SCHEMA = 1;
export const BRIDGE_EXTENSION_VERSION = "0.8.2";

/** 覆盖桥接运行目录的环境变量；默认 `<PI_CODING_AGENT_DIR>/mobile-bridge`。 */
export const BRIDGE_ROOT_ENV = "PI_MOBILE_BRIDGE_ROOT";

export const REGISTRY_DIR = "registry";
export const SOCKETS_DIR = "sockets";
export const OWNERS_DIR = "owners";

/** 一条 IPC JSON 帧的字节上限。手机 WS 数据面 18 MiB（4 张压图 base64 ≤16 MiB），
 *  IPC 接收同一帧时只剩少量信封开销；再放宽到 24 MiB，避免合法大图在桥接层被断开。
 *  超限必须回 frame-too-large，不能伪装成 runtime-offline。 */
export const BRIDGE_MAX_FRAME_BYTES = 24 * 1024 * 1024;

/** 注册表描述符：网关只从这里发现实例，不扫描进程表。 */
export interface BridgeDescriptor {
	schema: number;
	extensionVersion: string;
	instanceId: string;
	epoch: string;
	sessionId: string;
	pid: number;
	socketPath: string;
	sessionFile: string | null;
	cwd: string;
	startedAt: number;
	/** 同一会话的第二个实例只能观察，不能写。 */
	owner: boolean;
}

/** 每个请求都带实例身份，过期 epoch 一律拒绝，避免旧回调污染新会话。 */
export interface BridgeRequestIdentity {
	id: string;
	instanceId: string;
	epoch: string;
	sessionId: string;
}

export type BridgeRequest = BridgeRequestIdentity &
	(
		| { op: "snapshot" }
		| { op: "models" }
		| { op: "refresh-model"; operationId: string }
		| { op: "input-resources" }
		| { op: "tree" }
		| { op: "worktree-fork"; operationId: string; targetPath: string; sessionDir?: string }
		| { op: "entry-copy"; entryId: string }
		| { op: "label-put"; operationId: string; entryId: string; label?: string | null }
		| { op: "name"; operationId: string; name: string }
		| { op: "switch-branch"; operationId: string; entryId: string }
		| { op: "set-model"; operationId: string; provider: string; modelId: string; thinkingLevel?: string }
		| { op: "compact"; operationId: string }
		| { op: "history"; beforeEntryId?: string; limit?: number }
		| { op: "send"; operationId: string; text: string; images?: BridgeImage[]; deliverAs?: "steer" | "followUp" }
		| { op: "abort"; operationId: string; restoreQueued?: boolean }
		| { op: "dequeue"; operationId: string }
		| { op: "operation-status"; operationId: string }
	);

export interface BridgeImage {
	type: "image";
	data: string;
	mimeType: string;
}

/** 快照 + 之后的事件构成一个同步边界；seq 在 epoch 内单调递增。 */
export interface BridgeSnapshot {
	schema: number;
	extensionVersion: string;
	instanceId: string;
	epoch: string;
	sessionId: string;
	pid: number;
	socketPath: string;
	sessionFile: string | null;
	cwd: string;
	owner: boolean;
	seq: number;
	busy: boolean;
	/** 可选以兼容旧扩展；busy仍覆盖启动期与所有原生活动。 */
	isCompacting?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	pending: boolean;
	/** 公开导航没有取消句柄；超时后仍在执行时阻止模式切换，不冒充队列或生成。 */
	controlPending?: boolean;
	leafId: string | null;
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string | null;
	/** 手机不使用电脑草稿内容，只报告队列取回能力是否可用。 */
	editor: "bridge" | "unavailable";
	/** 当前未完成的 assistant 消息；已 end 后为 null。 */
	partial: unknown;
	/** 进行中的工具执行（tool_execution_start/update 原样缓存）。 */
	tools: unknown[];
}

export interface BridgeModelGroup {
	provider: string;
	models: Array<{
		id: string;
		name: string;
		contextWindow: number;
		maxTokens: number;
		reasoning: boolean;
		input: string[];
		thinkingLevels: string[];
	}>;
}

export interface BridgeReply {
	kind: "reply";
	id: string;
	ok: boolean;
	code?: string;
	instanceId?: string;
	epoch?: string;
	sessionId?: string;
	duplicate?: boolean;
	/** 0.4+ compact/set-model/abort/dequeue 的成功ACK必须带快照；
	 * 其它操作的reply没有这项，因此在共用reply类型上可选。 */
	snapshot?: BridgeSnapshot;
	status?: "submitted" | "settled" | "timeout" | "failed" | "unknown";
	entryId?: string;
	queuedText?: string | null;
	queuedRestoredToDesktop?: boolean;
	/**
	 * 取队列结果三态（abort 带 restoreQueued 时）：`captured` 手机已拿到文字，queuedRestoredToDesktop 可同时为 true（复制原生恢复稿）；
	 * `left-on-desktop` 桥接没动队列，交给 Pi 原生 abort 交还电脑编辑器；
	 * `unknown` 取回动作抛错且无捕获，队列是否还在不可知。
	 */
	queuedDisposition?: "captured" | "left-on-desktop" | "unknown";
	pending?: boolean;
	busy?: boolean;
	groups?: BridgeModelGroup[];
	skillCommandsEnabled?: boolean;
	commands?: Array<{ name: string; description?: string; source: "skill" | "prompt"; scope?: string }>;
	shadowed?: Array<{ name: string; source: "skill" | "prompt"; by: "extension" | "skill" }>;
	targetSessionId?: string;
	targetSessionFile?: string;
	cwd?: string;
	tree?: Array<{ entry: Record<string, unknown>; label?: string; labelTimestamp?: string }>;
	text?: string;
	bytes?: number;
	oversized?: boolean;
	label?: string | null;
	name?: string;
	labelEntryId?: string | null;
	editorText?: string;
	alreadyAt?: boolean;
	entries?: unknown[];
	hasMore?: boolean;
	oldestEntryId?: string | null;
	leafId?: string | null;
	model?: BridgeSnapshot["model"];
	thinkingLevel?: string | null;
}

export interface BridgeEventFrame {
	kind: "event";
	instanceId: string;
	epoch: string;
	sessionId: string;
	seq: number;
	entryId?: string;
	event: unknown;
	/** 仅在状态边界附带真实快照字段，不在每个文本delta重算占用。 */
	/** 状态边界三项一起出现；普通事件全部省略，不支持独立usage-only事件。 */
	isStreaming?: boolean;
	isCompacting?: boolean;
	contextUsage?: BridgeSnapshot["contextUsage"];
}

export interface BridgeHelloFrame {
	kind: "hello";
	snapshot: BridgeSnapshot;
}

/** 业务错误码，网关按码映射成面向手机的稳定短文案。 */
export type BridgeErrorCode =
	| "worktree-operation-invalid"
	| "worktree-operation-conflict"
	| "worktree-target-unavailable"
	| "worktree-source-empty"
	| "worktree-source-changed"
	| "worktree-busy"
	| "worktree-queued"
	| "worktree-result-unknown"
	| "worktree-continue-failed"
	| "invalid-request"
	| "unsupported"
	| "runtime-offline"
	| "stale-runtime"
	| "session-owned"
	| "busy"
	| "invalid-text"
	| "invalid-delivery"
	| "image-invalid"
	| "operation-id-conflict"
	| "operation-capacity"
	| "submission-failed"
	| "editor-unavailable"
	| "dequeue-unconfirmed"
	| "frame-too-large"
	| "model-config-refresh-failed"
	| "model-refresh-busy";
