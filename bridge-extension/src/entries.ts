// 两种宿主共用 Pi 的全文复制语义；这里不依赖网关或 AgentSession 私有对象。
export const ENTRY_COPY_MAX_BYTES = 512 * 1024;
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
/** Pi `TreeList.extractFullContent`：字符串原样，数组只拼 text 块，**不截断**。
 * 复制不走任何展示层窗口：树行 `preview` 是另拍的 120 字截断，搜索窗口是
 * `getSearchableText` 的 200 字（PROTOCOL §4.18/§4.26），两者都不是复制口径。 */
function extractFullContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		const b = record(block);
		if (b.type === "text") result += String(b.text ?? "");
	}
	return result;
}

/**
 * Pi `TreeList.getEntryCopyText`（TUI Ctrl+X / `app.message.copy`）的等价实现：
 * 当前选中 entry 的完整可复制文本，不是树行预览、不是整条分支。
 * - message + bashExecution → 命令行本身；
 * - 其余 message → 全部 text 块拼接；assistant 无正文时回落 errorMessage；
 * - custom_message → 正文；compaction / branch_summary → summary；
 * - 其他类型（label/model_change/tool 调用元数据等）→ undefined，
 *   Pi 在这种情况下提示 "Selected entry has no text to copy"，网关同样不造占位文本。
 * 与 Pi 一致：只有 trim 后非空才返回，且返回**未 trim** 的原文。
 */
export function entryCopyText(entry: unknown): string | undefined {
	const e = record(entry);
	let text: string | undefined;
	switch (e.type) {
		case "message": {
			const m = record(e.message);
			if (m.role === "bashExecution") {
				text = typeof m.command === "string" ? m.command : "";
			} else if ("content" in m) {
				text = extractFullContent(m.content);
				if (!text && m.role === "assistant" && typeof m.errorMessage === "string") text = m.errorMessage;
			}
			break;
		}
		case "custom_message":
			text = extractFullContent(e.content);
			break;
		case "compaction":
		case "branch_summary":
			text = typeof e.summary === "string" ? e.summary : undefined;
			break;
	}
	return text !== undefined && text.trim() !== "" ? text : undefined;
}

/** 树只传展示/搜索需要的条目字段；图片和思考全文不进入树 IPC。 */
export function treeEntry(entry: unknown): Record<string, unknown> {
	const e = record(entry),
		m = record(e.message);
	const out: Record<string, unknown> = {};
	for (const key of [
		"id",
		"parentId",
		"timestamp",
		"type",
		"customType",
		"tokensBefore",
		"modelId",
		"name",
		"thinkingLevel",
		"targetId",
		"label",
	])
		if (e[key] !== undefined) out[key] = e[key];
	if (e.type === "context_edit") out.replacement = e.replacement === null ? null : "";
	if (e.type === "branch_summary") out.summary = e.summary;
	const content = (value: unknown, fullString = false): unknown => {
		if (typeof value === "string") return fullString ? value : value.slice(0, 200);
		if (!Array.isArray(value)) return [];
		let remaining = 200;
		return value.flatMap<Record<string, unknown>>((block) => {
			const b = record(block);
			if (b.type === "text") {
				const text = String(b.text ?? "").slice(0, remaining);
				remaining -= text.length;
				return [{ type: "text", text }];
			}
			if (b.type === "image") return [{ type: "image" }];
			if (b.type === "toolCall") {
				const args = record(b.arguments),
					limited: Record<string, unknown> = {};
				for (const key of ["path", "file_path", "command", "pattern", "offset", "limit"])
					if (typeof args[key] === "string") limited[key] = args[key].slice(0, 200);
					else if (typeof args[key] === "number") limited[key] = args[key];
				return [{ type: "toolCall", id: b.id, name: b.name, arguments: limited }];
			}
			return [];
		});
	};
	if (e.type === "message") {
		out.message = {
			role: m.role,
			// 可见性按全文判断；展示和搜索窗口再由网关处理。
			treeTextPresent:
				typeof m.content === "string"
					? m.content.trim().length > 0
					: Array.isArray(m.content) &&
						m.content.some((block) => {
							const b = record(block);
							return b.type === "text" && String(b.text ?? "").trim().length > 0;
						}),
			content: content(m.content),
			stopReason: m.stopReason,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
			toolCallId: m.toolCallId,
			toolName: m.toolName,
			command: typeof m.command === "string" ? m.command : undefined,
		};
	}
	if (e.type === "custom_message") out.content = content(e.content, true);
	return out;
}
