import type { PiTreeNode } from "./wire.ts";

export const TREE_FILTERS = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;

export { ENTRY_COPY_MAX_BYTES, entryCopyText } from "../bridge-extension/src/entries.ts";

/** 标签长度上限（`label-put`，PROTOCOL §4.27）。Pi 的 LabelInput 只 trim 不限长，
 * 这里是 wire 护栏：超限回 bad-request，不静默截断后写成另一个标签。 */
export const LABEL_MAX_CHARS = 200;
export interface TreeViewOptions {
	filter: (typeof TREE_FILTERS)[number];
	search: string;
	foldedIds: string[];
}

export function readTreeView(value: unknown): TreeViewOptions | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (!TREE_FILTERS.includes(v.filter as TreeViewOptions["filter"]) || typeof v.search !== "string") return null;
	if (!Array.isArray(v.foldedIds) || !v.foldedIds.every((id) => typeof id === "string" && id.length > 0)) return null;
	return { filter: v.filter as TreeViewOptions["filter"], search: v.search, foldedIds: v.foldedIds as string[] };
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter((b) => record(b).type === "text")
		.map((b) => String(record(b).text ?? ""))
		.join("");
}
const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

/** Mirrors the locked SDK's applyFilter/getSearchableText, including its 200-character content search window. */
export function matchesTreeView(node: PiTreeNode, leafId: string | null, view: TreeViewOptions): boolean {
	const e = record(node.entry),
		m = record(e.message);
	// Pi 1.0 stores usage separately; it is hidden in every /tree filter.
	if (e.type === "usage") return false;
	if (e.type === "message" && m.role === "assistant" && e.id !== leafId) {
		const hasText =
			typeof m.treeTextPresent === "boolean"
				? m.treeTextPresent
				: typeof m.content === "string"
					? m.content.trim().length > 0
					: Array.isArray(m.content) &&
						m.content.some((b) => record(b).type === "text" && String(record(b).text ?? "").trim().length > 0);
		if (!hasText && (!m.stopReason || m.stopReason === "stop" || m.stopReason === "toolUse")) return false;
	}
	const settings = [
		"label",
		"context_edit",
		"custom",
		"model_change",
		"thinking_level_change",
		"session_info",
	].includes(String(e.type));
	if (view.filter === "user-only" && !(e.type === "message" && m.role === "user")) return false;
	if (view.filter === "labeled-only" && node.label === undefined) return false;
	if ((view.filter === "default" || view.filter === "no-tools") && settings) return false;
	if (view.filter === "no-tools" && e.type === "message" && m.role === "toolResult") return false;
	const parts = [node.label ?? ""];
	switch (e.type) {
		case "message":
			parts.push(
				String(m.role),
				text(m.content).slice(0, 200),
				m.role === "bashExecution" ? String(m.command ?? "") : "",
			);
			break;
		case "custom_message":
			parts.push(String(e.customType), typeof e.content === "string" ? e.content : text(e.content).slice(0, 200));
			break;
		case "compaction":
			parts.push("compaction");
			break;
		case "branch_summary":
			parts.push("branch summary", String(e.summary ?? ""));
			break;
		case "session_info":
			parts.push("title", String(e.name ?? ""));
			break;
		case "model_change":
			parts.push("model", String(e.modelId ?? ""));
			break;
		case "thinking_level_change":
			parts.push("thinking", String(e.thinkingLevel ?? ""));
			break;
		case "custom":
			parts.push("custom", String(e.customType ?? ""));
			break;
		case "context_edit":
			parts.push("context edit", e.replacement === null ? "omit" : "replace", String(e.targetId ?? ""));
			break;
		case "label":
			parts.push("label", String(e.label ?? ""));
			break;
	}
	const searchable = parts.join(" ").toLowerCase();
	return view.search
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((token) => searchable.includes(token));
}

/**
 * Shift+L 的标签值归一（Pi `LabelInput.handleInput`：提交前 trim，空值传 undefined
 * 即清除标签）。返回 null 表示协议违规（非字符串或超长），由路由回 bad-request。
 */
export function normalizeLabelValue(value: unknown): { label: string | undefined } | null {
	if (value === undefined || value === null) return { label: undefined };
	if (typeof value !== "string" || value.length > LABEL_MAX_CHARS) return null;
	const trimmed = value.trim();
	return { label: trimmed === "" ? undefined : trimmed };
}

export function treeToolCalls(nodes: Iterable<PiTreeNode>): Map<string, Record<string, unknown>> {
	const calls = new Map<string, Record<string, unknown>>();
	for (const node of nodes) {
		const e = record(node.entry),
			m = record(e.message);
		if (e.type !== "message" || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			const b = record(block);
			if (b.type === "toolCall" && typeof b.id === "string") calls.set(b.id, b);
		}
	}
	return calls;
}
function toolDisplay(call: Record<string, unknown>): string {
	const name = String(call.name),
		args = record(call.arguments);
	const shorten = (value: unknown) => {
		const p = String(value),
			home = process.env.HOME || process.env.USERPROFILE || "";
		return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const path = () => shorten(args.path || args.file_path || "");
	switch (name) {
		case "read": {
			let display = path();
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = Number(args.offset ?? 1),
					end = args.limit !== undefined ? start + Number(args.limit) - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
		case "edit":
			return `[${name}: ${path()}]`;
		case "bash": {
			const raw = String(args.command || "");
			return `[bash: ${normalize(raw).slice(0, 50)}${raw.length > 50 ? "..." : ""}]`;
		}
		case "grep":
			return `[grep: /${String(args.pattern || "")}/ in ${shorten(args.path || ".")}]`;
		case "find":
			return `[find: ${String(args.pattern || "")} in ${shorten(args.path || ".")}]`;
		case "ls":
			return `[ls: ${shorten(args.path || ".")}]`;
		default: {
			const json = JSON.stringify(args);
			return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`;
		}
	}
}

/** Plain text equivalent of Pi getEntryDisplayText; ANSI styling belongs to the client. */
export function treeDisplayText(node: PiTreeNode, calls: Map<string, Record<string, unknown>>): string {
	const e = record(node.entry),
		m = record(e.message);
	switch (e.type) {
		case "message": {
			const content = normalize(text(m.content).slice(0, 200));
			switch (m.role) {
				case "user":
					return `user: ${content}`;
				case "assistant":
					return `assistant: ${content || (m.stopReason === "aborted" ? "(aborted)" : m.errorMessage ? normalize(String(m.errorMessage)).slice(0, 80) : "(no content)")}`;
				case "toolResult": {
					const call = calls.get(String(m.toolCallId));
					return call ? toolDisplay(call) : `[${m.toolName ?? "tool"}]`;
				}
				case "bashExecution":
					return `[bash]: ${normalize(String(m.command ?? ""))}`;
				default:
					return `[${m.role}]`;
			}
		}
		case "custom_message":
			return `[${e.customType}]: ${normalize(text(e.content))}`;
		case "compaction":
			return `[compaction: ${Math.round(Number(e.tokensBefore) / 1000)}k tokens]`;
		case "branch_summary":
			return `[branch summary]: ${normalize(String(e.summary ?? ""))}`;
		case "model_change":
			return `[model: ${e.modelId}]`;
		case "thinking_level_change":
			return `[thinking: ${e.thinkingLevel}]`;
		case "custom":
			return `[custom: ${e.customType}]`;
		case "context_edit":
			return `[context ${e.replacement === null ? "omit" : "replace"}: ${e.targetId}]`;
		case "label":
			return `[label: ${e.label ?? "(cleared)"}]`;
		case "session_info":
			return `[title: ${e.name || "empty"}]`;
		default:
			return "";
	}
}
