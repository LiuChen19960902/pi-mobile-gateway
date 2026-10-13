// Unit tests for the wire vocabulary: pi event projection, history entry
// conversion, active-branch paging, and byte capping. Pure functions only —
// no pi resources, no sockets.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	ATTACHMENT_MAX_BASE64_CHARS,
	ATTACHMENT_MAX_RAW_BYTES,
	capHistoryPage,
	deriveSettingsFromEntries,
	entryToWireMessage,
	isValidImageMediaType,
	normalizeToolCalls,
	oversizedEventStub,
	sanitizeHistoryMessage,
	shrinkForWire,
	sliceActiveBranchTail,
	toWireEvent,
	toWireTreeNodes,
	trimTreeNodes,
	WIRE_EVENT_MAX_BYTES,
	WIRE_HISTORY_MESSAGE_MAX_BYTES,
	type WireMessage,
} from "../src/wire.ts";

// ---------------------------------------------------------------------------
// toWireEvent
// ---------------------------------------------------------------------------

describe("toWireEvent", () => {
	it("strips the cumulative partial from message_update, hoists tool call metadata, and takes usage from the snapshot", () => {
		// Real SDK shape (pi-agent-core): message_update carries the
		// cumulative `message` (with usage) and has NO top-level usage.
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "call_1", name: "bash" },
				],
				usage: { totalTokens: 10 },
			},
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: {
					role: "assistant",
					content: [
						{ type: "text", text: "hi" },
						{ type: "toolCall", id: "call_1", name: "bash" },
					],
				},
			},
		} as unknown as Parameters<typeof toWireEvent>[0];
		const wire = toWireEvent(event);
		assert.ok(wire);
		assert.equal(wire.type, "message_update");
		assert.deepEqual(wire.usage, { totalTokens: 10 });
		const assistantMessageEvent = wire.assistantMessageEvent as Record<string, unknown>;
		assert.equal(assistantMessageEvent.type, "toolcall_start");
		assert.equal(assistantMessageEvent.id, "call_1");
		assert.equal(assistantMessageEvent.toolName, "bash");
		assert.equal("partial" in assistantMessageEvent, false);
		assert.equal("message" in wire, false);
	});

	it("keeps message_update deltas without partial as-is (usage from message snapshot)", () => {
		const event = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "Hi" }], usage: { totalTokens: 3 } },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
		};
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.ok(wire);
		assert.equal(wire.type, "message_update");
		assert.deepEqual(wire.usage, { totalTokens: 3 });
		assert.deepEqual(wire.assistantMessageEvent, { type: "text_delta", contentIndex: 0, delta: "Hello " });
	});

	it("message_update without any usage field omits usage", () => {
		const event = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
		};
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.ok(wire);
		assert.equal("usage" in wire, false);
	});

	it("keeps assistant error fields on message_end for mobile consumers", () => {
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "401 insufficient quota",
			},
		};
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.deepEqual(wire, event);
	});

	it("keeps only toolCallId, toolName and partialResult on tool_execution_update", () => {
		const event = {
			type: "tool_execution_update",
			toolCallId: "call_2",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { content: [{ type: "text", text: "a\n" }] },
		};
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.deepEqual(wire, {
			type: "tool_execution_update",
			toolCallId: "call_2",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: "a\n" }] },
		});
	});

	it("drops agent_end.messages but keeps willRetry", () => {
		const event = { type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: true };
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.deepEqual(wire, { type: "agent_end", willRetry: true });
	});

	it("omits turn boundaries", () => {
		assert.equal(toWireEvent({ type: "turn_start" } as Parameters<typeof toWireEvent>[0]), null);
		assert.equal(toWireEvent({ type: "turn_end", message: {} } as Parameters<typeof toWireEvent>[0]), null);
	});

	it("passes queue updates through", () => {
		const event = { type: "queue_update", steering: ["focus"], followUp: [] };
		const wire = toWireEvent(event as Parameters<typeof toWireEvent>[0]);
		assert.deepEqual(wire, event);
	});
});

// ---------------------------------------------------------------------------
// normalizeToolCalls / entryToWireMessage
// ---------------------------------------------------------------------------

describe("normalizeToolCalls", () => {
	it("converts file-format toolCall blocks to the live display shape", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Running" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
		};
		const normalized = normalizeToolCalls(message) as {
			content: Array<Record<string, unknown>>;
		};
		assert.deepEqual(normalized.content[1], {
			type: "toolCall",
			toolCallId: "call_1",
			toolName: "bash",
			input: { command: "ls" },
		});
	});

	it("leaves non-assistant messages and non-toolCall blocks untouched", () => {
		const message = {
			role: "user",
			content: [{ type: "toolCall", id: "x", name: "y", arguments: {} }],
		};
		assert.equal(normalizeToolCalls(message), message);
		const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
		assert.equal(normalizeToolCalls(assistant), assistant);
	});
});

describe("entryToWireMessage", () => {
	it("converts message entries and normalizes their tool calls", () => {
		const entry = {
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }],
			},
		};
		const message = entryToWireMessage(entry as unknown as SessionEntry) as {
			content: Array<Record<string, unknown>>;
		};
		assert.equal(message.content[0].toolName, "read");
	});

	it("converts compaction entries to custom compaction messages", () => {
		const entry = {
			type: "compaction",
			id: "e5",
			parentId: "e4",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "Sum",
			firstKeptEntryId: "e2",
			tokensBefore: 123,
		};
		const message = entryToWireMessage(entry as unknown as SessionEntry);
		assert.equal(message?.role, "custom");
		assert.equal(message?.customType, "compaction");
	});

	it("converts empty-stop-retry custom entries to custom messages with details", () => {
		const entry = {
			type: "custom",
			customType: "empty-stop-retry",
			id: "e9",
			parentId: "e8",
			timestamp: "2026-01-01T00:00:00.000Z",
			data: { attempt: 1, reason: "流错误: 401", model: "relayF/model-x" },
		};
		const message = entryToWireMessage(entry as unknown as SessionEntry) as {
			role: string;
			customType: string;
			details: { attempt: number; reason: string };
			timestamp?: number;
		};
		assert.equal(message.role, "custom");
		assert.equal(message.customType, "empty-stop-retry");
		assert.equal(message.details.attempt, 1);
		assert.equal(message.details.reason, "流错误: 401");
		assert.equal(message.timestamp, 1767225600000);
	});

	it("drops other custom event entries", () => {
		assert.equal(
			entryToWireMessage({
				type: "custom",
				customType: "some-agent-event",
				id: "e10",
				parentId: null,
				data: { foo: 1 },
			} as unknown as SessionEntry),
			null,
		);
	});

	it("drops non-message metadata entries", () => {
		assert.equal(
			entryToWireMessage({
				type: "model_change",
				id: "e1",
				parentId: null,
				provider: "p",
				modelId: "m",
			} as unknown as SessionEntry),
			null,
		);
	});
});

// ---------------------------------------------------------------------------
// sliceActiveBranchTail / capHistoryPage
// ---------------------------------------------------------------------------

function linearEntries(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: i === 0 ? null : `e${i - 1}`,
			timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
			message: { role: "user", content: `m${i}` },
		} as unknown as SessionEntry);
	}
	return entries;
}

describe("sliceActiveBranchTail", () => {
	it("returns the newest tail of the active branch", () => {
		const entries = linearEntries(5);
		const slice = sliceActiveBranchTail(entries, 3);
		assert.ok(!("error" in slice));
		assert.deepEqual(
			slice.entries.map((entry) => entry.id),
			["e2", "e3", "e4"],
		);
		assert.equal(slice.hasMore, true);
	});

	it("returns everything when the branch fits", () => {
		const slice = sliceActiveBranchTail(linearEntries(3), 10);
		assert.ok(!("error" in slice));
		assert.equal(slice.entries.length, 3);
		assert.equal(slice.hasMore, false);
	});

	it("pages backwards with a beforeEntryId cursor (cursor exclusive)", () => {
		const entries = linearEntries(6);
		const page1 = sliceActiveBranchTail(entries, 3);
		assert.ok(!("error" in page1));
		assert.equal(page1.entries[0].id, "e3");
		// Next page: entries strictly older than e3.
		const page2 = sliceActiveBranchTail(entries, 3, page1.entries[0].id);
		assert.ok(!("error" in page2));
		assert.deepEqual(
			page2.entries.map((entry) => entry.id),
			["e0", "e1", "e2"],
		);
		assert.equal(page2.hasMore, false);
		// A cursor at the root's first entry has nothing older.
		const page3 = sliceActiveBranchTail(entries, 3, "e0");
		assert.ok(!("error" in page3));
		assert.deepEqual(page3.entries, []);
		assert.equal(page3.hasMore, false);
	});

	it("returns an error for a cursor that is not on the branch", () => {
		const slice = sliceActiveBranchTail(linearEntries(3), 2, "nope");
		assert.ok("error" in slice);
		assert.equal(slice.error, "unknown-cursor");
	});

	it("rejects a cursor pointing at an abandoned branch instead of paging ancestors", () => {
		// File order: e0 -> e1a -> e2a(active). e1a sits on the abandoned
		// branch even though it exists in the file.
		const entries: SessionEntry[] = [
			{ type: "message", id: "e0", parentId: null, message: { role: "user", content: "root" } },
			{ type: "message", id: "e1a", parentId: "e0", message: { role: "assistant", content: "abandoned" } },
			{ type: "message", id: "e2a", parentId: "e0", message: { role: "assistant", content: "active" } },
		] as unknown as SessionEntry[];
		const slice = sliceActiveBranchTail(entries, 5, "e1a");
		assert.ok("error" in slice);
		assert.equal(slice.error, "unknown-cursor");
		// The active branch still pages normally.
		const active = sliceActiveBranchTail(entries, 5);
		assert.ok(!("error" in active));
		assert.deepEqual(
			active.entries.map((entry) => entry.id),
			["e0", "e2a"],
		);
	});

	it("handles empty sessions", () => {
		const slice = sliceActiveBranchTail([], 5);
		assert.ok(!("error" in slice));
		assert.deepEqual(slice.entries, []);
		assert.equal(slice.hasMore, false);
	});
});

describe("capHistoryPage", () => {
	it("always keeps the newest message and reports hasMore when older ones drop", () => {
		const messages = [{ text: "aaa" }, { text: "b" }, { text: "c" }];
		const entryIds = ["e0", "e1", "e2"];
		// Budget fits the newest two, but not all three.
		const budget = Buffer.byteLength(JSON.stringify(messages[1])) + Buffer.byteLength(JSON.stringify(messages[2]));
		const page = capHistoryPage(messages, entryIds, budget, false);
		assert.deepEqual(
			page.messages.map((message) => message.text),
			["b", "c"],
		);
		assert.deepEqual(page.entryIds, ["e1", "e2"]);
		assert.equal(page.hasMore, true);
		assert.equal(page.oldestEntryId, "e1");
	});

	it("keeps everything within the budget", () => {
		const page = capHistoryPage([{ text: "a" }], ["e0"], 1024, false);
		assert.deepEqual(page.messages, [{ text: "a" }]);
		assert.equal(page.hasMore, false);
		assert.equal(page.oldestEntryId, "e0");
	});

	it("handles empty pages", () => {
		const page = capHistoryPage([], [], 1024, false);
		assert.deepEqual(page, { messages: [], entryIds: [], hasMore: false, oldestEntryId: null, bytes: 0 });
	});
});

// ---------------------------------------------------------------------------
// deriveSettingsFromEntries
// ---------------------------------------------------------------------------

describe("deriveSettingsFromEntries", () => {
	it("derives model and thinking level from the newest changes on the chain", () => {
		const entries = [
			{ type: "model_change", id: "e0", parentId: null, provider: "p1", modelId: "m1" },
			{ type: "thinking_level_change", id: "e1", parentId: "e0", thinkingLevel: "high" },
			{ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } },
		] as unknown as SessionEntry[];
		const settings = deriveSettingsFromEntries(entries);
		assert.deepEqual(settings.model, { provider: "p1", modelId: "m1" });
		assert.equal(settings.thinkingLevel, "high");
	});

	it("falls back to the assistant message provider/model and defaults", () => {
		const entries = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				message: { role: "assistant", content: [], provider: "p2", model: "m2" },
			},
		] as unknown as SessionEntry[];
		const settings = deriveSettingsFromEntries(entries);
		assert.deepEqual(settings.model, { provider: "p2", modelId: "m2" });
		const empty = deriveSettingsFromEntries([]);
		assert.equal(empty.model, null);
		assert.equal(empty.thinkingLevel, "off");
	});
});

// ---------------------------------------------------------------------------
// Outbound size budget (shrinkForWire / sanitizeHistoryMessage)
// ---------------------------------------------------------------------------

describe("outbound size budget", () => {
	const bigData = "A".repeat(600 * 1024);

	it("passes payloads within budget through untouched", () => {
		const value = { type: "message_end", message: { role: "user", content: "hi" } };
		const result = shrinkForWire(value, 1024 * 1024);
		assert.equal(result.shrank, false);
		assert.equal(result.value, value);
	});

	it("replaces image base64 payloads with metadata placeholders when over budget", () => {
		const value = {
			type: "message_end",
			message: { role: "toolResult", content: [{ type: "image", data: bigData, mediaType: "image/png" }] },
		};
		const result = shrinkForWire(value, 64 * 1024);
		assert.equal(result.shrank, true);
		const message = (result.value as Record<string, unknown>).message as Record<string, unknown>;
		const imageBlock = (message.content as Record<string, unknown>[])[0];
		assert.equal("data" in imageBlock, false);
		assert.equal(imageBlock.dataOmitted, true);
		assert.equal(imageBlock.type, "image");
		assert.equal(typeof imageBlock.dataBytes, "number");
	});

	it("truncates oversized strings but keeps small ones verbatim", () => {
		const value = { type: "message_end", message: { role: "assistant", content: "x".repeat(200_000) } };
		const result = shrinkForWire(value, 16 * 1024);
		assert.equal(result.shrank, true);
		const text = ((result.value as Record<string, unknown>).message as Record<string, unknown>).content as string;
		assert.ok(text.length < 200_000);
		assert.ok(text.endsWith("[已截断]"));
		// A small payload is untouched.
		const small = shrinkForWire({ text: "keep me" }, 16 * 1024);
		assert.equal(small.shrank, false);
	});

	it("event frames: caller can downgrade a still-oversized payload to a stub", () => {
		// 100 blocks of over-limit text still exceeds the budget after shrinking.
		const blocks = Array.from({ length: 100 }, () => ({ type: "text", text: "y".repeat(200_000) }));
		const value = { type: "message_end", message: { role: "assistant", content: blocks } };
		const result = shrinkForWire(value, 64 * 1024);
		assert.ok(result.bytes > 64 * 1024);
		const stub = oversizedEventStub(value.type, result.bytes);
		assert.equal(stub.type, "event_omitted");
		assert.equal(stub.originalType, "message_end");
	});

	it("sanitizeHistoryMessage shrinks a huge message below the per-message budget", () => {
		const message: WireMessage = {
			role: "assistant",
			content: [{ type: "text", text: "z".repeat(3 * 1024 * 1024) }],
			display: true,
		};
		const sanitized = sanitizeHistoryMessage(message);
		const bytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
		assert.ok(bytes <= WIRE_HISTORY_MESSAGE_MAX_BYTES);
		assert.ok(String((sanitized.content as { text: string }[])[0].text).endsWith("[已截断]"));
	});

	it("sanitizeHistoryMessage stubs out pathological payloads entirely", () => {
		const blocks = Array.from({ length: 100 }, () => ({ type: "text", text: "w".repeat(200_000) }));
		const message: WireMessage = { role: "assistant", content: blocks, display: true };
		const sanitized = sanitizeHistoryMessage(message);
		const bytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
		assert.ok(bytes <= WIRE_HISTORY_MESSAGE_MAX_BYTES);
		assert.equal(sanitized.customType, "wire-oversized");
	});
});

// toWireTreeNodes（pi 树行投影：可见祖先重映射 + indent/gutter/prefix）

describe("toWireTreeNodes", () => {
	/** 造一个可见 message 节点（用例只关心投影形态，不关心 preview 细节）。 */
	const msg = (id: string, parentId: string | null, role: string, text: string, children: unknown[] = []) =>
		({
			entry: {
				id,
				parentId,
				type: "message",
				timestamp: "2026-09-15T00:00:00.000Z",
				message: { role, content: [{ type: "text", text }] },
			},
			children,
		}) as never;

	it("只保留 user/assistant，parentId 重映射到最近可见祖先（pi findVisibleAncestor）", () => {
		// a(user) → t(toolResult，不可见) → b(assistant)：b 的可见父是 a 而不是 t。
		// 旧实现原样透出 entry.parentId，客户端拿到指向不可见条目的父 id 就断链
		//（实测真实会话里 58/79、246/315 的节点如此），一棵树被切成几十个 root，
		// 竖线彼此不连、分叉曲线几乎不出现——用户看到的就是这个。
		const b = msg("b", "t", "assistant", "hello");
		const t = msg("t", "a", "toolResult", "x", [b]);
		const a = msg("a", null, "user", "hi", [t]);
		const nodes = toWireTreeNodes([a, msg("d", null, "assistant", "done")] as never, null);
		assert.deepEqual(
			nodes.map((n) => [n.id, n.parentId]),
			[
				["a", null],
				["b", "a"],
				["d", null],
			],
		);
	});

	it("分叉才缩进，穿透竖线延伸到该子树最后一行（pi indent/gutter 规则）", () => {
		// P → a → (a2, a1)，P → b：a 不是末孩子，它的整棵子树前两列都带 `│`。
		// 与 pi 实测渲染一致：├─ a / │  ├─ a2 / │  └─ a1 / └─ b。
		//（pi 在每级第 2 个字符放折叠标记 ⊟/⊞，手机端不支持折叠，恒为 ─。）
		const a = msg("a", "p", "assistant", "a", [msg("a2", "a", "user", "a2"), msg("a1", "a", "assistant", "a1")]);
		const p = msg("p", null, "user", "P", [a, msg("b", "p", "assistant", "b")]);
		const nodes = toWireTreeNodes([p] as never, null);
		assert.deepEqual(
			nodes.map((n) => [n.id, n.prefix]),
			[
				["p", ""],
				["a", "├─ "],
				["a2", "│  ├─ "],
				["a1", "│  └─ "],
				["b", "└─ "],
			],
		);
	});

	it("单链平铺不缩进，分叉后的第一代才 +1（pi childIndent）", () => {
		// P → (a, b)，a 之后是单链 a1 → a2：a1 是"分叉后的第一代"，缩进 +1；
		// a1 → a2 又是单链，保持平铺不再加深（否则长会话会一路右漂）。
		const a1 = msg("a1", "a", "assistant", "a1", [msg("a2", "a1", "user", "a2")]);
		const a = msg("a", "p", "assistant", "a", [a1]);
		const p = msg("p", null, "user", "P", [a, msg("b", "p", "assistant", "b")]);
		const nodes = toWireTreeNodes([p] as never, null);
		assert.deepEqual(
			nodes.map((n) => [n.id, n.prefix]),
			[
				["p", ""],
				["a", "├─ "],
				["a1", "│     "],
				["a2", "│     "],
				["b", "└─ "],
			],
		);
	});

	it("活跃路径：标记 onActivePath，且含活跃叶子的分支排同级最前", () => {
		// nodeId 落在可见链尾 → 一路 onActivePath；同级里活跃分支排前（pi 同样
		// 在 flattenTree 里先用 containsActive 排序），当前分支一眼可见。
		const x = msg("x", "p", "assistant", "x");
		const y = msg("y", "p", "assistant", "y");
		const p = msg("p", null, "user", "P", [x, y]);
		const nodes = toWireTreeNodes([p] as never, "y");
		assert.deepEqual(
			nodes.map((n) => [n.id, n.onActivePath]),
			[
				["p", true],
				["y", true],
				["x", false],
			],
		);
	});

	it("leafId 落在不可见条目上时，仍沿全量父链标记可见祖先", () => {
		// 叶子常常是 toolResult（不可见）：活跃路径要沿全量 parentId 上溯，
		// 否则树里一条高亮都没有。
		const t = msg("t", "a", "toolResult", "x");
		const a = msg("a", null, "user", "hi", [t]);
		const nodes = toWireTreeNodes([a] as never, "t");
		assert.deepEqual(
			nodes.map((n) => [n.id, n.onActivePath]),
			[["a", true]],
		);
	});

	it("image-only user message gets a placeholder preview", () => {
		// 手机端核心场景：发纯图。没有文本块时不留占位，树行就只剩「我」标签。
		const nodes = toWireTreeNodes(
			[
				{
					entry: {
						id: "img",
						type: "message",
						message: {
							role: "user",
							content: [{ type: "image", data: "AAA", mimeType: "image/png" }],
						},
					},
					children: [],
				},
			] as never,
			null,
		);
		assert.equal(nodes[0].preview, "(image)");
	});

	it("survives a very deep single chain (4000 entries) without recursion blowup", () => {
		const depth = 4000;
		let child = msg(`m${depth - 1}`, `m${depth - 2}`, "assistant", `msg ${depth - 1}`);
		for (let i = depth - 2; i >= 0; i--) {
			child = msg(`m${i}`, i === 0 ? null : `m${i - 1}`, "user", `msg ${i}`, [child]);
		}
		const nodes = toWireTreeNodes([child] as never, null);
		assert.equal(nodes.length, depth);
		// 单链平铺：整条链没有分叉，prefix 全空（旧"可见嵌套深度"语义会累积到
		// 4000 级，树页按缩进把节点推到屏幕外几万 dp）。
		assert.equal(nodes[depth - 1].prefix, "");
		assert.equal(nodes[depth - 1].preview, `msg ${depth - 1}`);
	});

	it("trims by recency but always keeps the whole active path", () => {
		// 活跃分支排同级最前后，数组前部是当前分支、尾部是被放弃的分支：直接
		// slice(-limit) 会把当前对话整支切掉（reviewer 抓到的 P1 回归）。
		const nodes = Array.from({ length: 10 }, (_, i) => ({
			id: `n${i}`,
			parentId: null,
			prefix: "",
			onActivePath: i < 3,
			type: "message",
			preview: `p${i}`,
			timestamp: `2026-09-15T00:00:${String(i).padStart(2, "0")}.000Z`,
		}));
		const kept = trimTreeNodes(nodes as never, 5);
		// 活跃的 n0/n1/n2 必须都在，其余按时间取最近（n8/n9），并保持展示序。
		assert.deepEqual(
			kept.map((n) => n.id),
			["n0", "n1", "n2", "n8", "n9"],
		);
	});

	it("keeps an aborted/length assistant without text visible, and the current leaf", () => {
		// 对齐 pi applyFilter：isErrorOrAborted（stopReason 非 stop/toolUse）算可见；
		// 当前叶子另有例外（叶子常落在纯工具轮上）。
		const aborted = msg("a1", null, "assistant", "", []);
		(aborted as never as { entry: { message: Record<string, unknown> } }).entry.message.stopReason = "length";
		const toolOnlyLeaf = {
			entry: {
				id: "t1",
				parentId: "a1",
				type: "message",
				timestamp: "2026-09-15T00:00:01.000Z",
				message: { role: "assistant", content: [{ type: "toolCall", name: "Read" }] },
			},
			children: [],
		} as never;
		(aborted as never as { children: unknown[] }).children = [toolOnlyLeaf];
		const nodes = toWireTreeNodes([aborted] as never, "t1");
		assert.deepEqual(
			nodes.map((n) => n.id),
			["a1", "t1"],
		);
	});
});

// ---------------------------------------------------------------------------
// UTF-16 截断不拆代理对（wire 100k 文本裁剪 + 120 树预览共用 helper）
// ---------------------------------------------------------------------------

describe("UTF-16 truncation keeps surrogate pairs intact", () => {
	const EMOJI = "\u{1F600}"; // 😀 = D83D DE00，2 个 UTF-16 单元

	it("shrinks an over-budget string without splitting a pair at the cut", () => {
		// 超出实际 event 预算，降损后可正常发出，不会再被整帧占位替换。
		const s = `${"a".repeat(100_000 - 1)}${EMOJI}tail`;
		const result = shrinkForWire({ text: s, padding: "x".repeat(WIRE_EVENT_MAX_BYTES) }, WIRE_EVENT_MAX_BYTES);
		assert.equal(result.shrank, true);
		assert.ok(result.bytes <= WIRE_EVENT_MAX_BYTES);
		const out = (result.value as { text: string }).text;
		assert.ok(out.endsWith("…[已截断]"));
		const body = out.slice(0, out.length - "…[已截断]".length);
		// 孤立高代理会被 replace(/\p{Surrogate}/gu) 命中——不允许残留任何代理项。
		assert.equal(body.match(/\p{Surrogate}/gu), null);
		assert.equal(body, "a".repeat(100_000 - 1)); // 高代理随其低代理一起丢弃
	});

	it("cuts plain ASCII exactly at the same budget (unchanged behaviour)", () => {
		const result = shrinkForWire({ text: "x".repeat(150_000) }, 1024);
		const out = (result.value as { text: string }).text;
		assert.equal(out.slice(0, out.length - "…[已截断]".length).length, 100_000);
	});

	it("in-budget strings pass through untouched (emoji included)", () => {
		const value = { text: `${EMOJI}${EMOJI}ok` };
		const result = shrinkForWire(value, 1024);
		assert.equal(result.shrank, false);
		assert.equal(result.value, value);
	});

	it("tree preview: 60 emojis fill the 120-unit budget exactly and stay whole", () => {
		// 60 × 2 单元 = 120 = TREE_PREVIEW_MAX_CHARS：不超限，也不得误判跨界。
		const trees = toWireTreeNodes(
			[
				{ entry: { id: "e", type: "message", message: { role: "user", content: EMOJI.repeat(60) } }, children: [] },
			] as never,
			null,
		);
		assert.equal(trees[0].preview, EMOJI.repeat(60));
	});

	it("tree preview keeps complete pairs before an overflowing suffix", () => {
		// 120 单元恰在两个 emoji 之间，不需回退。
		const trees = toWireTreeNodes(
			[
				{ entry: { id: "e", type: "message", message: { role: "user", content: EMOJI.repeat(61) } }, children: [] },
			] as never,
			null,
		);
		assert.equal(trees[0].preview, `${EMOJI.repeat(60)}…`);
	});

	it("tree preview retreats when the 120-unit cut splits an emoji", () => {
		const prefix = "a".repeat(119);
		const trees = toWireTreeNodes(
			[
				{
					entry: { id: "e", type: "message", message: { role: "user", content: `${prefix}${EMOJI}tail` } },
					children: [],
				},
			] as never,
			null,
		);
		assert.equal(trees[0].preview, `${prefix}…`);
		assert.equal(trees[0].preview.match(/\p{Surrogate}/gu), null);
	});

	it("assistant error preview also preserves the pair at its 80-unit cut", () => {
		const prefix = "e".repeat(79);
		const trees = toWireTreeNodes(
			[
				{
					entry: {
						id: "e",
						type: "message",
						message: {
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: `${prefix}${EMOJI}tail`,
						},
					},
					children: [],
				},
			] as never,
			null,
		);
		assert.equal(trees[0].preview, prefix);
	});
});

// ---------------------------------------------------------------------------
// attachment（§4.22）：常量关系与 mime/base64 预检
// ---------------------------------------------------------------------------

describe("attachment budgets", () => {
	it("base64 预检上限 = ceil(raw/3)*4，raw = 4MiB 时回复 ≈ 5.33MiB，低于 8MiB 背压阈值", () => {
		assert.equal(ATTACHMENT_MAX_BASE64_CHARS, Math.ceil(ATTACHMENT_MAX_RAW_BYTES / 3) * 4);
		assert.equal(ATTACHMENT_MAX_RAW_BYTES, 4 * 1024 * 1024);
		const replyUpperBound = ATTACHMENT_MAX_BASE64_CHARS + 200; // 200 = 帧外壳+元数据的宽松余量
		assert.ok(replyUpperBound < 8 * 1024 * 1024, "attachment 回复必须低于出站背压阈值");
	});

	it("合法 image/* mime 在有界长度内通过；超界/非 image/、空串拒绝", () => {
		assert.equal(isValidImageMediaType("image/png"), true);
		assert.equal(isValidImageMediaType("image/jpeg"), true);
		assert.equal(isValidImageMediaType("IMAGE/svg+xml"), true);
		assert.equal(isValidImageMediaType(""), false);
		assert.equal(isValidImageMediaType("text/html"), false);
		assert.equal(isValidImageMediaType("image"), false);
		assert.equal(isValidImageMediaType(undefined), false);
		assert.equal(isValidImageMediaType("image/"), false);
		assert.equal(isValidImageMediaType(`${"a".repeat(96)}/${"b".repeat(5)}`), false);
	});
});
