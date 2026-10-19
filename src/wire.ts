import { matchesTreeView, type TreeViewOptions, treeDisplayText, treeToolCalls } from "./tree-view.ts";
// Wire vocabulary for the business frames (phase 2+).
//
// Design: keep dsh-mobile's frame *skeleton* (client sends `{type, ...}`,
// server answers `{kind: <type>, ...}` or the uniform error frame, pushes
// `{kind: "event", ...}`), but the *payload* vocabulary is pi-native:
//
//   - events are pi `AgentSessionEvent`s projected to the JSON shape of pi's
//     own RPC stdout protocol (`JsonAgentSessionEvent` semantics: the
//     cumulative `partial` snapshot is stripped from `message_update`, tool
//     call ids/names are hoisted onto `toolcall_start`/`toolcall_delta`),
//     plus the two bandwidth deviations pi-web also makes: `turn_start`/
//     `turn_end` are omitted and `agent_end.messages` is dropped (each
//     message already arrives via `message_end`).
//   - history is entry-id paginated over the session file's active branch,
//     mirroring pi-web's session-reader (slice the parent chain from the
//     leaf, then let the SDK's compaction-aware `buildContextEntries()`
//     select what a page renders).
//
// Sources: pi-coding-agent docs/rpc.md (event JSON projection),
// pi-web lib/agent-event-wire.ts + lib/normalize.ts + lib/session-reader.ts
// (MIT, © pi-web authors) — adapted for this gateway.

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Frames the client may send (after pairing + hello). */
/** 客户端帧类型的运行时清单：类型与清单同源，测试用它全量比对 hello.capabilities。 */
export const CLIENT_FRAME_TYPES = [
	"ping",
	"sessions",
	"subscribe",
	"unsubscribe",
	"message",
	"abort",
	"dequeue",
	"history",
	"state",
	"models",
	"model-scope",
	"model-scope-put",
	"set-model",
	"name",
	"compact",
	"directories",
	"directory-create",
	"workspace-create",
	"providers",
	"provider-put",
	"provider-delete",
	"provider-test",
	"provider-models",
	"restart-session",
	"tree",
	"switch-branch",
	"worktree-list",
	"worktree-create",
	"worktree-continue",
	"worktree-status",
	"worktree-trust",
	"entry-copy",
	"label-put",
	"commands",
	"input-resources",
	"input-completions",
	"attachment",
] as const;

export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];

/** One listable custom command (prompt template / skill / extension command).
 * name 不带 `/` 前缀；skill 按 pi RPC 口径加 `skill:` 前缀。path 不传
 * （宿主机绝对路径对手机 UI 无价值，最小暴露）。 */
export interface WireSlashCommand {
	[key: string]: unknown;
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	scope?: string;
	origin?: string;
	/** 仅 source=prompt 有（模板 frontmatter argument-hint）。 */
	argumentHint?: string;
	/** 仅 source=skill 有（模型不可自主调用，仅显式 /skill: 触发）。 */
	disableModelInvocation?: boolean;
}

/** 三源清单 → wire（对齐 pi RPC get_commands：扩展 invocationName、skill 加前缀）。 */
export function toWireSlashCommands(sources: {
	extensions: ReadonlyArray<{ name: string; description?: string; sourceInfo?: { scope?: string; origin?: string } }>;
	templates: ReadonlyArray<{
		name: string;
		description: string;
		argumentHint?: string;
		sourceInfo?: { scope?: string; origin?: string };
	}>;
	skills: ReadonlyArray<{
		name: string;
		description: string;
		disableModelInvocation: boolean;
		sourceInfo?: { scope?: string; origin?: string };
	}>;
}): WireSlashCommand[] {
	const out: WireSlashCommand[] = [];
	for (const command of sources.extensions) {
		out.push({
			name: command.name,
			...(command.description === undefined ? {} : { description: command.description }),
			source: "extension",
			...(command.sourceInfo?.scope === undefined ? {} : { scope: command.sourceInfo.scope }),
			...(command.sourceInfo?.origin === undefined ? {} : { origin: command.sourceInfo.origin }),
		});
	}
	for (const template of sources.templates) {
		out.push({
			name: template.name,
			description: template.description,
			source: "prompt",
			...(template.sourceInfo?.scope === undefined ? {} : { scope: template.sourceInfo.scope }),
			...(template.sourceInfo?.origin === undefined ? {} : { origin: template.sourceInfo.origin }),
			...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
		});
	}
	for (const skill of sources.skills) {
		out.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			...(skill.sourceInfo?.scope === undefined ? {} : { scope: skill.sourceInfo.scope }),
			...(skill.sourceInfo?.origin === undefined ? {} : { origin: skill.sourceInfo.origin }),
			disableModelInvocation: skill.disableModelInvocation,
		});
	}
	return out;
}

/** Server push frame for one live session event. */
export interface EventFrame {
	[key: string]: unknown;
	kind: "event";
	sessionId: string;
	seq: number;
	time: number;
	event: Record<string, unknown>;
}

/** Uniform server error frame (dsh skeleton). */
export interface ErrorFrame {
	[key: string]: unknown;
	kind: "error";
	code: string;
	message: string;
	requestType: string;
	sessionId?: string;
}

export function errorFrame(code: string, message: string, requestType: string, sessionId?: string): ErrorFrame {
	return sessionId === undefined
		? { kind: "error", code, message, requestType }
		: { kind: "error", code, message, requestType, sessionId };
}

/** Single-image raw-byte budget for `attachment` replies (§4.22)：原始
 * 字节 ≤ 4 MiB；base64 约 5.33 MiB + 小量元数据仍低于出站 8 MiB 背压阈值。
 * 与客户端预处理 4,893,356 base64 字符上限对齐。history/event 预算不复用。 */
export const ATTACHMENT_MAX_RAW_BYTES = 4 * 1024 * 1024;
/** base64 长度先行预检上限：ceil(maxRaw/3)*4；未达上限不必分配解码缓冲。 */
export const ATTACHMENT_MAX_BASE64_CHARS = Math.ceil(ATTACHMENT_MAX_RAW_BYTES / 3) * 4;
/** mime 白名单前缀 + 有界长度：防病态长头。 */
const MEDIA_TYPE_MAX_LENGTH = 100;

export function isValidImageMediaType(mediaType: unknown): mediaType is string {
	return (
		typeof mediaType === "string" &&
		mediaType.length > 0 &&
		mediaType.length <= MEDIA_TYPE_MAX_LENGTH &&
		/^image\/[a-z0-9.+-]+$/i.test(mediaType)
	);
}

/** 成功应答帧（含声明的解码字节数，客户端以它为准先验再解）。 */
export interface AttachmentReply {
	kind: "attachment";
	sessionId: string;
	entryId: string;
	imageIndex: number;
	mediaType: string;
	bytes: number;
	dataBase64: string;
}

// ---------------------------------------------------------------------------
// Event projection (pi AgentSessionEvent -> wire)
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract `{id, toolName}` for a toolcall delta from the cumulative partial
 * message that the raw SDK event still carries (pi-web agent-event-wire.ts).
 */
function toolCallMetadata(event: Record<string, unknown>): { id: string; toolName: string } | null {
	if (event.type !== "toolcall_start" && event.type !== "toolcall_delta") return null;
	const partial = event.partial;
	if (!isRecord(partial)) return null;
	const content = partial.content;
	const contentIndex = event.contentIndex;
	if (!Array.isArray(content) || typeof contentIndex !== "number") return null;
	const block = content[contentIndex];
	if (!isRecord(block) || block.type !== "toolCall") return null;
	const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : null;
	const toolName =
		typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : null;
	return id !== null && toolName !== null ? { id, toolName } : null;
}

/** Events the wire omits: turn boundaries are implicit in the message stream. */
const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end"]);

/**
 * Project one pi session event to the wire shape. Returns null for omitted
 * event types. The projection matches pi's own JSON protocol semantics; the
 * only further deviation is dropping `agent_end.messages` (bandwidth — every
 * message already arrived via `message_end`).
 */
export function toWireEvent(event: AgentSessionEvent): Record<string, unknown> | null {
	const raw = event as unknown as Record<string, unknown>;
	if (OMITTED_EVENT_TYPES.has(String(raw.type))) return null;

	if (raw.type === "message_update") {
		const assistantMessageEvent = raw.assistantMessageEvent;
		if (!isRecord(assistantMessageEvent)) return null;
		// pi-agent-core emits `message_update` without a top-level usage; pi's
		// own JSON projection takes it from the cumulative snapshot's usage.
		const message = isRecord(raw.message) ? raw.message : undefined;
		const usage = message?.usage ?? raw.usage;
		const payload: Record<string, unknown> = { type: "message_update", assistantMessageEvent: undefined };
		if (usage !== undefined) payload.usage = usage;
		if (!("partial" in assistantMessageEvent)) {
			payload.assistantMessageEvent = assistantMessageEvent;
			return payload as Record<string, unknown>;
		}
		const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
		void _partial;
		const metadata = toolCallMetadata(assistantMessageEvent);
		payload.assistantMessageEvent = metadata ? { ...deltaEvent, ...metadata } : deltaEvent;
		return payload as Record<string, unknown>;
	}

	if (raw.type === "tool_execution_update") {
		return {
			type: "tool_execution_update",
			toolCallId: raw.toolCallId,
			toolName: raw.toolName,
			partialResult: raw.partialResult,
			...(typeof raw.parentToolCallId === "string" ? { parentToolCallId: raw.parentToolCallId } : {}),
		};
	}

	if (raw.type === "agent_end") {
		return { type: "agent_end", willRetry: raw.willRetry === true };
	}

	return { ...raw };
}

// ---------------------------------------------------------------------------
// History projection (session file entries -> wire messages)
// ---------------------------------------------------------------------------

/** Display shape of a tool-call content block (matches live `message_end`). */
interface WireToolCallBlock {
	type: "toolCall";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export type WireMessage = Record<string, unknown>;

/**
 * Normalize file-format toolCall blocks (`{id, name, arguments}`) to the
 * in-memory display shape (`{toolCallId, toolName, input}`) so history
 * messages match the live event stream (pi-web lib/normalize.ts).
 */
export function normalizeToolCalls(message: WireMessage): WireMessage {
	if (message.role !== "assistant") return message;
	const content = message.content;
	if (!Array.isArray(content)) return message;
	let changed = false;
	const normalized = content.map((block) => {
		if (!isRecord(block) || block.type !== "toolCall") return block;
		changed = true;
		const wire: WireToolCallBlock = {
			type: "toolCall",
			toolCallId:
				typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "",
			toolName: typeof block.toolName === "string" ? block.toolName : typeof block.name === "string" ? block.name : "",
			input:
				typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
					? (block.input as Record<string, unknown>)
					: typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
						? (block.arguments as Record<string, unknown>)
						: {},
		};
		return wire;
	});
	return changed ? { ...message, content: normalized } : message;
}

function parseEntryTimestamp(timestamp: string): number | undefined {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Convert one session entry on the active branch into a chat message.
 * Returns null for entries that do not render (metadata, non-message types).
 * (pi-web session-reader.ts entryToUiMessage, minus the image deferral.)
 */
export function entryToWireMessage(entry: SessionEntry): WireMessage | null {
	const raw = entry as unknown as Record<string, unknown>;
	switch (raw.type) {
		case "message": {
			const message = raw.message;
			if (!isRecord(message)) return null;
			return normalizeToolCalls(message);
		}
		case "compaction":
			return {
				role: "custom",
				entryType: "compaction",
				customType: "compaction",
				content: raw.summary,
				display: true,
				details: {
					tokensBefore: raw.tokensBefore,
					firstKeptEntryId: raw.firstKeptEntryId,
				},
				timestamp: parseEntryTimestamp(String(raw.timestamp ?? "")),
			};
		case "branch_summary": {
			if (typeof raw.summary !== "string" || raw.summary === "") return null;
			return {
				role: "user",
				content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${raw.summary}`,
				timestamp: parseEntryTimestamp(String(raw.timestamp ?? "")),
			};
		}
		case "custom":
			return null; // Pi内部数据不是可见消息，不解释插件私有类型。
		case "custom_message":
			return {
				role: "custom",
				entryType: "custom_message",
				customType: raw.customType,
				content: raw.content,
				display: raw.display,
				details: raw.details,
				timestamp: parseEntryTimestamp(String(raw.timestamp ?? "")),
			};
		default:
			return null;
	}
}

export interface BranchSlice {
	/** Active-branch entries of this page, oldest first. */
	entries: SessionEntry[];
	hasMore: boolean;
}

/**
 * Slice the newest `limit` entries off the active branch (the parent chain
 * from the file's last entry), for `beforeEntryId`-cursor paging. Iterative
 * on purpose: a linear session's chain equals its entry count, recursion
 * would overflow. (pi-web session-reader.ts sliceActiveBranch.)
 */
export function sliceActiveBranchTail(
	entries: SessionEntry[],
	limit: number,
	beforeEntryId?: string,
	startLeafId?: string,
): BranchSlice | { error: "unknown-cursor" } {
	if (entries.length === 0) return { entries: [], hasMore: false };
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	// 起点：分支切换后的手动叶子（pi navigateTree 只改运行时 leafId 不落盘），
	// 未指定时取 file-order 尾（最新）。
	let startLeaf: SessionEntry | undefined = startLeafId ? byId.get(startLeafId) : entries[entries.length - 1];
	if (startLeafId && !startLeaf) return { error: "unknown-cursor" };

	// Walk the active branch (file-order leaf -> root) once so a cursor that
	// points at an entry outside it (abandoned branch) is rejected instead of
	// silently paging shared ancestors.
	const activeIds = new Set<string>();
	let walk: SessionEntry | undefined = startLeaf;
	while (walk) {
		activeIds.add(walk.id);
		walk = walk.parentId ? byId.get(walk.parentId) : undefined;
	}

	if (beforeEntryId !== undefined) {
		if (!activeIds.has(beforeEntryId)) return { error: "unknown-cursor" };
		// The cursor itself was already delivered; page in front of it.
		const cursor = byId.get(beforeEntryId);
		startLeaf = cursor?.parentId ? byId.get(cursor.parentId) : undefined;
		if (!startLeaf) return { entries: [], hasMore: false };
	}

	const chain: SessionEntry[] = [];
	let current: SessionEntry | undefined = startLeaf;
	let hasMore = false;
	while (current) {
		if (chain.length === limit) {
			hasMore = true;
			break;
		}
		chain.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	chain.reverse();
	return { entries: chain, hasMore };
}

export interface HistoryPage {
	/** Wire messages of this page, oldest first. */
	messages: WireMessage[];
	/** Parallel array: the session entry id behind each message. */
	entryIds: string[];
	hasMore: boolean;
	/** Cursor for the next (older) page; null when this page starts at the root. */
	oldestEntryId: string | null;
	bytes: number;
}

/**
 * Cap a converted page to a serialized byte budget, keeping the newest
 * suffix (dsh gateway capHistoryEvents semantics: the newest item always
 * survives; older items drop beyond the budget).
 */
export function capHistoryPage(
	messages: WireMessage[],
	entryIds: string[],
	maxBytes: number,
	hasMore: boolean,
): HistoryPage {
	if (messages.length === 0) {
		return { messages: [], entryIds: [], hasMore: false, oldestEntryId: null, bytes: 0 };
	}
	const sizes = messages.map((message) => Buffer.byteLength(JSON.stringify(message), "utf8"));
	let total = sizes[sizes.length - 1];
	let start = sizes.length - 1;
	for (let i = sizes.length - 2; i >= 0; i--) {
		if (total + sizes[i] > maxBytes) break;
		total += sizes[i];
		start = i;
	}
	return {
		messages: messages.slice(start),
		entryIds: entryIds.slice(start),
		// Older messages were dropped from this page (start > 0) or exist before it.
		hasMore: hasMore || start > 0,
		oldestEntryId: entryIds[start],
		bytes: total,
	};
}

/** Model/thinking level derived from file entries when no live session exists. */
export function deriveSettingsFromEntries(entries: SessionEntry[]): {
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
} {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	let current: SessionEntry | undefined = entries[entries.length - 1];
	let thinkingLevel: string | undefined;
	let model: { provider: string; modelId: string } | undefined;
	while (current && (thinkingLevel === undefined || model === undefined)) {
		const raw = current as unknown as Record<string, unknown>;
		if (thinkingLevel === undefined && raw.type === "thinking_level_change" && typeof raw.thinkingLevel === "string") {
			thinkingLevel = raw.thinkingLevel;
		}
		if (
			model === undefined &&
			raw.type === "model_change" &&
			typeof raw.provider === "string" &&
			typeof raw.modelId === "string"
		) {
			model = { provider: raw.provider, modelId: raw.modelId };
		}
		if (model === undefined && raw.type === "message") {
			const message = raw.message;
			if (
				isRecord(message) &&
				message.role === "assistant" &&
				typeof message.provider === "string" &&
				typeof message.model === "string"
			) {
				model = { provider: message.provider, modelId: message.model };
			}
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return { model: model ?? null, thinkingLevel: thinkingLevel ?? "off" };
}

// ---------------------------------------------------------------------------
// Outbound size budget (mobile delivery)
// ---------------------------------------------------------------------------

/** Longest string kept verbatim in any shrunken payload. */
export const WIRE_TEXT_MAX_CHARS = 100_000;
/** Serialized size budget for one live event frame (matches the inbound 1 MiB cap). */
export const WIRE_EVENT_MAX_BYTES = 1024 * 1024;
/** Serialized size budget for one history message (must stay below the page budget). */
export const WIRE_HISTORY_MESSAGE_MAX_BYTES = 512 * 1024;

/** 保持 UTF-16 单元预算；切点若拆开有效代理对就退一单元，不产生孤立代理。 */
function truncateUtf16(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const high = text.charCodeAt(limit - 1);
	const low = text.charCodeAt(limit);
	const splitPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
	return text.slice(0, splitPair ? limit - 1 : limit);
}

/** Replace base64 image payloads with metadata placeholders (deep walk). */
function shrinkForBudget(node: unknown): { value: unknown; changed: boolean } {
	if (typeof node === "string") {
		if (node.length > WIRE_TEXT_MAX_CHARS) {
			return { value: `${truncateUtf16(node, WIRE_TEXT_MAX_CHARS)}…[已截断]`, changed: true };
		}
		return { value: node, changed: false };
	}
	if (Array.isArray(node)) {
		let changed = false;
		const out = node.map((item) => {
			const result = shrinkForBudget(item);
			if (result.changed) changed = true;
			return result.value;
		});
		return { value: changed ? out : node, changed };
	}
	if (isRecord(node)) {
		// Image content blocks: the base64 payload is the multi-megabyte
		// offender; keep the metadata so clients can render a placeholder
		// (full image delivery/deferred fetch is phase 4).
		if (node.type === "image" && typeof node.data === "string") {
			const { data, ...rest } = node;
			return {
				value: { ...rest, dataOmitted: true, dataBytes: Buffer.byteLength(data, "utf8") },
				changed: true,
			};
		}
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			const result = shrinkForBudget(value);
			if (result.changed) changed = true;
			out[key] = result.value;
		}
		return { value: changed ? out : node, changed };
	}
	return { value: node, changed: false };
}

export interface WireShrinkResult {
	/** Final payload (original reference when within budget). */
	value: unknown;
	/** Serialized size of the final payload. */
	bytes: number;
	/** True when shrinking modified the payload. */
	shrank: boolean;
}

function wireBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Enforce a serialized byte budget on an outbound payload: within budget it
 * passes through untouched; over budget, long strings are truncated and
 * image base64 payloads are replaced with metadata placeholders. The result
 * can still exceed the budget in pathological cases (huge block counts) —
 * callers decide the final degrade with `bytes`.
 */
export function shrinkForWire(value: unknown, budgetBytes: number): WireShrinkResult {
	const bytes = wireBytes(value);
	if (bytes <= budgetBytes) return { value, bytes, shrank: false };
	const shrunk = shrinkForBudget(value).value;
	return { value: shrunk, bytes: wireBytes(shrunk), shrank: true };
}

/** Last-resort replacement for a live event that cannot fit the budget. */
export function oversizedEventStub(originalType: unknown, bytes: number): Record<string, unknown> {
	return {
		type: "event_omitted",
		originalType: typeof originalType === "string" ? originalType : "unknown",
		bytes,
		reason: "event too large for mobile delivery; re-sync via history",
	};
}

/** Last-resort replacement for a history message that cannot fit its budget. */
export function oversizedMessageStub(bytes: number): WireMessage {
	return {
		role: "custom",
		customType: "wire-oversized",
		entryType: "wire_oversized",
		content: "[消息过大，移动端已省略]",
		display: true,
		originalBytes: bytes,
	};
}

/**
 * Enforce the per-message history budget with a hard bound: shrink first,
 * and if the payload still cannot fit, replace it with a small stub so the
 * page cap always holds.
 */
export function sanitizeHistoryMessage(message: WireMessage): WireMessage {
	const result = shrinkForWire(message, WIRE_HISTORY_MESSAGE_MAX_BYTES);
	if (result.bytes <= WIRE_HISTORY_MESSAGE_MAX_BYTES) return result.value as WireMessage;
	return oversizedMessageStub(result.bytes);
}

// ---------------------------------------------------------------------------
// Tree projection (sessionManager.getTree() -> wire)
// ---------------------------------------------------------------------------

/** pi 的 getTree 节点：entry + children + 可选 label。 */
export interface PiTreeNode {
	entry: SessionEntry;
	children: PiTreeNode[];
	label?: string | null;
	labelTimestamp?: string | null;
}

/** wire 树节点：文本已裁剪，字段只保留客户端渲染所需。 */
export interface WireTreeNode {
	id: string;
	/** 最近**可见**祖先的 id（pi `recalculateVisualStructure` 的 findVisibleAncestor）：
	 * 被过滤掉的中间条目（toolResult/model_change…）不会切断树，根为 null。 */
	parentId: string | null;
	/** 树行前缀：缩进 + 穿透竖线 + 分叉字符（pi tree-selector 的规则）。 */
	prefix: string;
	/** 是否在当前活跃路径上（渲染 `• ` 标记；pi 也只标行、不标线）。 */
	onActivePath: boolean;
	type: string;
	/** user/assistant/toolResult/bashExecution 等，message 类型才有。 */
	role?: string;
	/** 单行摘要（≤120 字符）；message 类只输出正文，不带 role 前缀
	 *（角色由 `role` 字段表达，客户端自己渲染短标签，见 nodeToWire）。 */
	preview: string;
	/** Pi tree-view-v1 plain display text and fold state. */
	displayText?: string;
	foldable?: boolean;
	folded?: boolean;
	label?: string;
	timestamp?: string;
}

/** 树行穿透竖线的一段（pi flattenTree 的 gutters 元素）。 */
interface TreeGutter {
	position: number;
	show: boolean;
}

/** 可见树的遍历帧（pi recalculateVisualStructure 的栈元素）。 */
interface TreeFrame {
	id: string;
	indent: number;
	justBranched: boolean;
	showConnector: boolean;
	isLast: boolean;
	gutters: TreeGutter[];
	isVirtualRootChild: boolean;
}

/**
 * 拼树行前缀（pi `tree-selector.js` 的字符规则）：每级 3 字符，位置 0 放穿透
 * 竖线或分叉字符（`├`/`└`），位置 1 放 `─`（pi 在这里放折叠标记 ⊟/⊞，手机端
 * 不支持折叠，恒为 `─`），位置 2 空格。单链不缩进，只有分叉才加一级。
 */
function buildTreePrefix(
	displayIndent: number,
	isLast: boolean,
	showConnector: boolean,
	gutters: TreeGutter[],
	foldMarker = "─",
): string {
	const connectorPosition = showConnector ? displayIndent - 1 : -1;
	const chars: string[] = [];
	for (let i = 0; i < displayIndent * 3; i++) {
		const level = Math.floor(i / 3);
		const posInLevel = i % 3;
		const gutter = gutters.find((entry) => entry.position === level);
		if (gutter !== undefined) {
			// 穿透竖线：上面那级还有后续兄弟，该列一直延续到那棵子树结束。
			chars.push(posInLevel === 0 && gutter.show ? "│" : " ");
		} else if (showConnector && level === connectorPosition) {
			if (posInLevel === 0) chars.push(isLast ? "└" : "├");
			else if (posInLevel === 1) chars.push(foldMarker);
			else chars.push(" ");
		} else {
			chars.push(" ");
		}
	}
	return chars.join("");
}

/** 预览单行长度上限（与 pi TUI 的树行一致是单行摘要，超长省略）。 */
const TREE_PREVIEW_MAX_CHARS = 120;

function normalizePreview(text: string): string {
	const normalized = text.replace(/[\n\t]/g, " ").trim();
	return normalized.length > TREE_PREVIEW_MAX_CHARS
		? `${truncateUtf16(normalized, TREE_PREVIEW_MAX_CHARS)}…`
		: normalized;
}

/** 从 message content 抽文本块并拼接（PiEventNormalizer.textOf 的 TS 对应版）。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("");
}

/**
 * Project one pi tree node into the wire shape. The text preview mirrors
 * pi's own TUI tree row (getEntryDisplayText), except that the `user: ` /
 * `assistant: ` prefixes are dropped: `role` already carries that, and the
 * phone renders its own short colour-coded tag ("我" / "AI") — the 11-char
 * `assistant: ` prefix only ate the single-line budget on a phone. Tool /
 * compaction / branch_summary markers keep their `[...]` form.
 */
function visibleAssistant(message: Record<string, unknown>): boolean {
	if (contentText(message.content) !== "") return true;
	// 对齐 pi applyFilter 的 isErrorOrAborted：stopReason 存在且不是正常结束
	//（stop/toolUse）就算有可见内容——aborted/error/length 都算，errorMessage
	// 无需单独判（那几种情况 stopReason 本就不是 stop/toolUse）。
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
	return stopReason !== "" && stopReason !== "stop" && stopReason !== "toolUse";
}

/** content 是否为纯图片（无文本块）。pi 的 image 块为 `{type:"image"}`。 */
function hasImageBlock(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "image");
}

function nodeToWire(
	node: PiTreeNode,
	prefix: string,
	onActivePath: boolean,
	visibleParentId: string | null,
): WireTreeNode {
	const entry = node.entry as unknown as Record<string, unknown>;
	const type = String(entry.type ?? "unknown");
	let role: string | undefined;
	let preview = "";

	if (type === "message" && isRecord(entry.message)) {
		const message = entry.message as Record<string, unknown>;
		role = typeof message.role === "string" ? message.role : undefined;
		const content = contentText(message.content);
		switch (role) {
			case "user":
				// 纯图消息（手机端核心场景）没有文本块：不留占位的话树行只剩
				// 「我」标签、正文全白。
				preview = content !== "" ? content : hasImageBlock(message.content) ? "(image)" : "(no text)";
				break;
			case "assistant": {
				const text = contentText(message.content);
				if (text !== "") preview = text;
				else if (message.stopReason === "aborted") preview = "(aborted)";
				else if (typeof message.errorMessage === "string" && message.errorMessage !== "")
					preview = truncateUtf16(message.errorMessage.replace(/[\n\t]/g, " ").trim(), 80);
				else preview = "(no content)";
				break;
			}
			case "toolResult": {
				const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
				preview = `[${toolName}]`;
				break;
			}
			case "bashExecution":
				preview = `[bash]: ${content}`;
				break;
			default:
				preview = `[${role ?? "message"}]`;
		}
	} else if (type === "custom_message") {
		const customType = typeof entry.customType === "string" ? entry.customType : "custom";
		preview = `[${customType}]: ${contentText(entry.content)}`;
	} else if (type === "compaction") {
		const tokensBefore = typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0;
		preview = `[compaction: ${Math.max(1, Math.round(tokensBefore / 1000))}k tokens]`;
	} else if (type === "branch_summary") {
		preview = `[branch summary]: ${contentText(entry.summary)}`;
	} else if (type === "model_change") {
		preview = `[model: ${typeof entry.modelId === "string" ? entry.modelId : ""}]`;
	} else if (type === "session_info") {
		preview = `[session: ${typeof entry.name === "string" ? entry.name : ""}]`;
	} else {
		preview = `[${type}]`;
	}

	return {
		id: typeof entry.id === "string" ? entry.id : "",
		parentId: visibleParentId,
		prefix,
		onActivePath,
		type,
		...(role !== undefined ? { role } : {}),
		preview: normalizePreview(preview),
		...(typeof node.label === "string" && node.label !== "" ? { label: node.label } : {}),
		...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
	};
}

/**
 * Flatten a pi tree to a wire array (DFS pre-order, children in time order).
 * Iterative on purpose: real sessions can be single chains thousands of
 * entries deep (observed 3400+), recursion would blow the call stack — and
 * nested JSON would blow it again inside JSON.stringify.
 */
/**
 * 截断到 limit 条：**活跃路径整条保留**，其余按时间取最近，最后保持展示序
 * （原数组顺序，prefix 逐行自带所以子集仍可正确渲染）。
 *
 * 不能直接 `slice(-limit)`：活跃分支排同级最前（pi 的排序）之后，数组前部是
 * 当前分支、尾部是被放弃的分支，切尾会把当前对话整支切掉——最坏情况整页无
 * `•` 标记、树页显示的是废弃分支（reviewer 抓到的 P1 回归）。
 */
export function trimTreeNodes(nodes: WireTreeNode[], limit: number): WireTreeNode[] {
	if (nodes.length <= limit) return nodes;
	const keep = new Set<string>();
	for (const node of nodes) {
		if (node.onActivePath) keep.add(node.id);
	}
	const rest = nodes
		.filter((node) => !node.onActivePath)
		.map((node, index) => ({ node, index }))
		.sort((a, b) => {
			const ta = Date.parse(a.node.timestamp ?? "") || 0;
			const tb = Date.parse(b.node.timestamp ?? "") || 0;
			return ta !== tb ? ta - tb : a.index - b.index;
		});
	for (let i = rest.length - 1; i >= 0 && keep.size < limit; i--) keep.add(rest[i].node.id);
	return nodes.filter((node) => keep.has(node.id));
}

export function toWireTreeNodes(tree: PiTreeNode[], leafId: string | null, view?: TreeViewOptions): WireTreeNode[] {
	const folded = new Set(view?.foldedIds ?? []);
	const hiddenByFold = new Set<string>();
	const idOf = (node: PiTreeNode): string => String((node.entry as unknown as Record<string, unknown>).id ?? "");
	// 可见口径唯一定义：过滤与分叉计数同口径，否则纯工具 assistant 兄弟会把
	// 单可见孩子误判成双孩子（多缩进一级，传染子树）。
	const isVisibleEntry = (id: string, raw: unknown): boolean => {
		const record = raw as Record<string, unknown>;
		if (String(record.type ?? "unknown") !== "message" || !isRecord(record.message)) return false;
		const role = record.message.role;
		if (role === "user") return true;
		if (role !== "assistant") return false;
		// 当前叶子即使没有可见正文也保留（pi applyFilter 的 isCurrentLeaf 例外）：
		// 叶子常落在纯工具轮上，否则活跃路径看起来断在半路。
		if (id === leafId) return true;
		return visibleAssistant(record.message);
	};

	// 1) 全量前序：id→节点、id→全量父、可见条目顺序。
	//    全量父链是 findVisibleAncestor 的底座（被过滤的中间条目要能连续上溯）。
	const nodeById = new Map<string, PiTreeNode>();
	const parentIdById = new Map<string, string | null>();
	const visibleOrder: string[] = [];
	const visibleIds = new Set<string>();
	{
		const stack: Array<{ node: PiTreeNode; parentId: string | null }> = [];
		for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], parentId: null });
		while (stack.length > 0) {
			const { node, parentId } = stack.pop() as { node: PiTreeNode; parentId: string | null };
			const id = idOf(node);
			nodeById.set(id, node);
			parentIdById.set(id, parentId);
			if (parentId !== null && (folded.has(parentId) || hiddenByFold.has(parentId))) hiddenByFold.add(id);
			if (!hiddenByFold.has(id) && (view ? matchesTreeView(node, leafId, view) : isVisibleEntry(id, node.entry))) {
				visibleIds.add(id);
				visibleOrder.push(id);
			}
			for (let i = node.children.length - 1; i >= 0; i--) {
				stack.push({ node: node.children[i], parentId: id });
			}
		}
	}

	// 2) 活跃路径：从 leafId 沿**全量**父链上溯（叶子可能落在被过滤掉的条目上，
	//    例如 toolResult），只记可见节点。
	const activePath = new Set<string>();
	const fullActivePath = new Set<string>();
	{
		let current: string | null = leafId;
		while (current !== null) {
			fullActivePath.add(current);
			if (visibleIds.has(current)) activePath.add(current);
			current = parentIdById.get(current) ?? null;
		}
	}

	// Pi sorts the full tree before filtering. Hidden active ancestors still determine sibling order.
	if (view) {
		visibleOrder.length = 0;
		const orderedFull = (nodes: PiTreeNode[]) => [
			...nodes.filter((node) => fullActivePath.has(idOf(node))),
			...nodes.filter((node) => !fullActivePath.has(idOf(node))),
		];
		const stack = orderedFull(tree).reverse();
		while (stack.length > 0) {
			const node = stack.pop() as PiTreeNode;
			if (visibleIds.has(idOf(node))) visibleOrder.push(idOf(node));
			stack.push(...orderedFull(node.children).reverse());
		}
	}

	// 3) 重建可见树：每个节点挂到最近可见祖先（pi findVisibleAncestor）。
	const visibleParent = new Map<string, string | null>();
	const visibleChildren = new Map<string | null, string[]>();
	for (const id of visibleOrder) {
		let ancestor = parentIdById.get(id) ?? null;
		while (ancestor !== null && !visibleIds.has(ancestor)) {
			ancestor = parentIdById.get(ancestor) ?? null;
		}
		visibleParent.set(id, ancestor);
		const siblings = visibleChildren.get(ancestor);
		if (siblings) siblings.push(id);
		else visibleChildren.set(ancestor, [id]);
	}
	const roots = visibleChildren.get(null) ?? [];
	const multipleRoots = roots.length > 1;

	// 4) 走一遍可见树算 indent/gutter/prefix（pi recalculateVisualStructure）。
	//    含活跃叶子的分支排同级最前（pi 同样这样排），保持"当前分支一眼可见"。
	const out: WireTreeNode[] = [];
	const calls = view ? treeToolCalls(nodeById.values()) : new Map();
	const ordered = (ids: string[]): string[] =>
		view ? ids : [...ids.filter((id) => activePath.has(id)), ...ids.filter((id) => !activePath.has(id))];
	const frames: TreeFrame[] = [];
	const orderedRoots = ordered(roots);
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		frames.push({
			id: orderedRoots[i],
			indent: multipleRoots ? 1 : 0,
			justBranched: multipleRoots,
			showConnector: multipleRoots,
			isLast: i === orderedRoots.length - 1,
			gutters: [],
			isVirtualRootChild: multipleRoots,
		});
	}
	while (frames.length > 0) {
		const frame = frames.pop() as TreeFrame;
		const node = nodeById.get(frame.id);
		if (node === undefined) continue;
		// 多个可见根时，虚拟根占一级，显示上退掉（pi displayIndent）。
		const displayIndent = multipleRoots ? Math.max(0, frame.indent - 1) : frame.indent;
		const connectorDisplayed = frame.showConnector && !frame.isVirtualRootChild;
		const parent = visibleParent.get(frame.id) ?? null;
		const foldable =
			folded.has(frame.id) ||
			((visibleChildren.get(frame.id)?.length ?? 0) > 0 &&
				(parent === null || (visibleChildren.get(parent)?.length ?? 0) > 1));
		let prefix = buildTreePrefix(
			displayIndent,
			frame.isLast,
			connectorDisplayed,
			frame.gutters,
			view ? (folded.has(frame.id) ? "⊞" : foldable ? "⊟" : "─") : "─",
		);
		if (view && folded.has(frame.id) && !connectorDisplayed) prefix += "⊞ ";
		const wire = nodeToWire(node, prefix, activePath.has(frame.id), parent);
		if (view) {
			wire.displayText = treeDisplayText(node, calls);
			wire.foldable = foldable;
			wire.folded = folded.has(frame.id);
		}
		out.push(wire);
		const children = ordered(visibleChildren.get(frame.id) ?? []);
		const multipleChildren = children.length > 1;
		// 分叉点（以及分叉后的第一代）才 +1，单链平铺（pi childIndent）。
		const childIndent = multipleChildren
			? frame.indent + 1
			: frame.justBranched && frame.indent > 0
				? frame.indent + 1
				: frame.indent;
		const childGutters = connectorDisplayed
			? [...frame.gutters, { position: Math.max(0, displayIndent - 1), show: !frame.isLast }]
			: frame.gutters;
		for (let i = children.length - 1; i >= 0; i--) {
			frames.push({
				id: children[i],
				indent: childIndent,
				justBranched: multipleChildren,
				showConnector: multipleChildren,
				isLast: i === children.length - 1,
				gutters: childGutters,
				isVirtualRootChild: false,
			});
		}
	}
	return out;
}
