import assert from "node:assert/strict";
import test from "node:test";
import {
	entryCopyText,
	LABEL_MAX_CHARS,
	normalizeLabelValue,
	readTreeView,
	type TreeViewOptions,
} from "../src/tree-view.ts";
import { type PiTreeNode, toWireTreeNodes } from "../src/wire.ts";

const view: TreeViewOptions = { filter: "default", search: "", foldedIds: [] };
function node(id: string, entry: Record<string, unknown>, children: PiTreeNode[] = [], label?: string): PiTreeNode {
	return {
		entry: { id, parentId: null, timestamp: "2026-10-07T00:00:00Z", ...entry },
		children,
		...(label !== undefined ? { label } : {}),
	} as unknown as PiTreeNode;
}
const message = (role: string, content: unknown, extra = {}) => ({
	type: "message",
	message: { role, content, ...extra },
});

test("Pi default retains tool results, summaries and display=false custom messages; filters only SDK bookkeeping", () => {
	const tree = [
		node("u", message("user", "question")),
		node(
			"call",
			message(
				"assistant",
				[{ type: "toolCall", id: "c", name: "read", arguments: { path: "/tmp/a", offset: 2, limit: 3 } }],
				{ stopReason: "toolUse" },
			),
		),
		node("t", message("toolResult", [{ type: "text", text: "result" }], { toolCallId: "c", toolName: "read" })),
		node("c", { type: "compaction", tokensBefore: 200, summary: "secret" }),
		node("custom", { type: "custom_message", customType: "note", content: "body", display: false }),
		node("model", { type: "model_change", modelId: "model-x" }),
		node("err", message("assistant", [], { stopReason: "error", errorMessage: "failed" })),
	];
	const rows = toWireTreeNodes(tree, "err", view);
	assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(["u", "t", "c", "custom", "err"]));
	assert.equal(rows.find((r) => r.id === "t")?.displayText, "[read: /tmp/a:2-4]");
	assert.equal(rows.find((r) => r.id === "c")?.displayText, "[compaction: 0k tokens]");
	assert.equal(rows.find((r) => r.id === "err")?.displayText, "assistant: failed");
	assert.equal(
		toWireTreeNodes(tree, "call", view).some((r) => r.id === "call"),
		true,
	);
	assert.equal(
		toWireTreeNodes(tree, "err", { ...view, filter: "all" }).some((r) => r.id === "call"),
		false,
	);
	assert.equal(
		toWireTreeNodes(tree, "err", { ...view, filter: "all" }).some((r) => r.id === "model"),
		true,
	);
	assert.deepEqual(
		toWireTreeNodes(tree, "err", { ...view, filter: "user-only" }).map((r) => r.id),
		["u"],
	);
	assert.equal(
		toWireTreeNodes(tree, "err", { ...view, filter: "no-tools" }).some((r) => r.id === "t"),
		false,
	);
});

test("Pi 1.0 hides usage in every filter and keeps visible ancestors across bookkeeping", () => {
	const tail = node("tail", message("assistant", "answer"));
	const usage = node("usage", { type: "usage" }, [tail], "meter");
	const edit = node("edit", { type: "context_edit", targetId: "u", replacement: null }, [usage], "trim");
	const root = node("u", message("user", "question"), [edit]);
	const rows = toWireTreeNodes([root], "tail", view);
	assert.deepEqual(
		rows.map((r) => [r.id, r.parentId]),
		[
			["u", null],
			["tail", "u"],
		],
	);
	for (const filter of ["default", "no-tools", "user-only", "labeled-only", "all"] as const) {
		assert.equal(
			toWireTreeNodes([root], "usage", { ...view, filter }).some((r) => r.id === "usage"),
			false,
		);
	}
	assert.equal(
		toWireTreeNodes([root], "tail", { ...view, filter: "labeled-only" }).some((r) => r.id === "edit"),
		true,
	);
	const selected = toWireTreeNodes([root], "tail", { ...view, filter: "all", search: "context omit u" });
	assert.deepEqual(
		selected.map((r) => [r.id, r.displayText]),
		[["edit", "[context omit: u]"]],
	);
	assert.equal(
		toWireTreeNodes([node("replace", { type: "context_edit", targetId: "u", replacement: {} })], "replace", {
			...view,
			filter: "all",
			search: "context replace u",
		})[0].displayText,
		"[context replace: u]",
	);
});

test("search follows Pi token AND, labels, role and 200-character content window", () => {
	const tree = [node("a", message("user", "x".repeat(130) + "needle" + "x".repeat(70) + "outside"), [], "Bookmark")];
	assert.equal(toWireTreeNodes(tree, "a", { ...view, search: "USER bookmark NEEDLE" }).length, 1);
	assert.equal(toWireTreeNodes(tree, "a", { ...view, search: "outside" }).length, 0);
	assert.equal(toWireTreeNodes(tree, "a", { ...view, filter: "labeled-only" }).length, 1);
	assert.equal(
		toWireTreeNodes(tree, "a", view)[0].displayText,
		"user: " + ("x".repeat(130) + "needle" + "x".repeat(70)).slice(0, 200),
	);
});

test("fold and search reattach to visible ancestors with active sibling first and no single-chain drift", () => {
	const tail = node("tail", message("assistant", "tail"));
	const a = node("a", message("user", "branch A"), [tail]);
	const b = node("b", message("user", "branch B"));
	const root = node("root", message("user", "root"), [b, a]);
	let rows = toWireTreeNodes([root], "tail", view);
	assert.deepEqual(
		rows.map((r) => r.id),
		["root", "a", "tail", "b"],
	);
	assert.deepEqual(
		rows.map((r) => r.prefix),
		["", "├⊟ ", "│     ", "└─ "],
	);
	assert.deepEqual(
		rows.map((r) => r.onActivePath),
		[true, true, true, false],
	);
	rows = toWireTreeNodes([root], "tail", { ...view, foldedIds: ["a"] });
	assert.deepEqual(
		rows.map((r) => r.id),
		["root", "a", "b"],
	);
	assert.equal(rows[1].prefix, "├⊞ ");
	assert.equal(rows[1].folded, true);
	rows = toWireTreeNodes([root], "tail", { ...view, search: "tail" });
	assert.deepEqual(
		rows.map((r) => [r.id, r.prefix, r.parentId]),
		[["tail", "", null]],
	);
});

test("complete view keeps deep chains beyond the legacy 400-row window", () => {
	let root = node("n999", message("user", "end"));
	for (let i = 998; i >= 0; i--) root = node(`n${i}`, message("user", String(i)), [root]);
	const rows = toWireTreeNodes([root], "n999", view);
	assert.equal(rows.length, 1000);
	assert.ok(rows.every((r) => r.prefix === ""));
	assert.equal(rows[0].foldable, true);
	assert.equal(rows[1].foldable, false);
});

test("view validation rejects malformed and unsupported options", () => {
	assert.equal(readTreeView({ ...view, filter: "invented" }), null);
	assert.equal(readTreeView({ ...view, foldedIds: [1] }), null);
	assert.equal(readTreeView({ ...view, search: 12 }), null);
	assert.deepEqual(readTreeView(view), view);
});

// ---------------------------------------------------------------------------
// entry-copy / label-put（PROTOCOL §4.26–§4.27）的纯语义层
// ---------------------------------------------------------------------------

test("entryCopyText mirrors Pi getEntryCopyText: full text per entry type, never the preview window", () => {
	const long = `${"x".repeat(130)}needle${"x".repeat(4000)}`;
	// user 字符串正文：全文返回，不取树行的 120/200 字窗口。
	assert.equal(entryCopyText({ type: "message", message: { role: "user", content: long } }), long);
	// 多 text 块拼接，非 text 块（图片/工具调用）不贡献文本。
	assert.equal(
		entryCopyText({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "第一段\n" },
					{ type: "image", data: "AAAA" },
					{ type: "text", text: "第二段" },
				],
			},
		}),
		"第一段\n第二段",
	);
	// bashExecution 取命令行本身；toolResult 取其正文。
	assert.equal(
		entryCopyText({ type: "message", message: { role: "bashExecution", command: "ls -la /tmp" } }),
		"ls -la /tmp",
	);
	assert.equal(
		entryCopyText({
			type: "message",
			message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] },
		}),
		"file body",
	);
	// assistant 无正文时回落 errorMessage；两者都没 → undefined（不造占位）。
	assert.equal(
		entryCopyText({ type: "message", message: { role: "assistant", content: [], errorMessage: "stream died" } }),
		"stream died",
	);
	assert.equal(
		entryCopyText({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c" }] } }),
		undefined,
	);
	assert.equal(entryCopyText({ type: "message", message: { role: "user", content: "   \n " } }), undefined);
	// custom_message / compaction / branch_summary 各自的正文来源。
	assert.equal(entryCopyText({ type: "custom_message", customType: "note", content: "body" }), "body");
	assert.equal(entryCopyText({ type: "compaction", summary: "摘要全文", tokensBefore: 1000 }), "摘要全文");
	assert.equal(entryCopyText({ type: "branch_summary", summary: "分支摘要" }), "分支摘要");
	// 簿记条目没有可复制文本（Pi："Selected entry has no text to copy"）。
	for (const entry of [
		{ type: "label", targetId: "e1", label: "交付" },
		{ type: "model_change", provider: "p", modelId: "m" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "session_info", name: "标题" },
		{ type: "usage", kind: "cache_warm" },
		{ type: "context_edit", targetId: "e1", replacement: null },
	]) {
		assert.equal(entryCopyText(entry), undefined, JSON.stringify(entry));
	}
	// 与 Pi 一致：只有 trim 后非空才返回，且返回**未 trim** 的原文。
	assert.equal(entryCopyText({ type: "compaction", summary: "\n  保留首尾空白  \n" }), "\n  保留首尾空白  \n");
});

test("normalizeLabelValue follows Pi LabelInput: trim, empty clears, oversized is a protocol violation", () => {
	assert.deepEqual(normalizeLabelValue(undefined), { label: undefined });
	assert.deepEqual(normalizeLabelValue(null), { label: undefined });
	assert.deepEqual(normalizeLabelValue("   "), { label: undefined });
	assert.deepEqual(normalizeLabelValue("\t交付 \n"), { label: "交付" });
	assert.deepEqual(normalizeLabelValue("a".repeat(LABEL_MAX_CHARS)), { label: "a".repeat(LABEL_MAX_CHARS) });
	assert.equal(normalizeLabelValue("a".repeat(LABEL_MAX_CHARS + 1)), null);
	assert.equal(normalizeLabelValue(12), null);
	assert.equal(normalizeLabelValue({ text: "x" }), null);
	assert.equal(normalizeLabelValue(["x"]), null);
});
