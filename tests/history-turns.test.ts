import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { historyTurnPage } from "../src/history-turns.ts";

function fixture(turns: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < turns; i++) {
		for (const [suffix, role, stopReason] of [
			["u", "user", undefined],
			["call", "assistant", "toolUse"],
			["tool", "toolResult", undefined],
			["a", "assistant", "stop"],
		]) {
			entries.push({
				type: "message",
				id: `${i}-${suffix}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-10-07T00:00:00Z",
				message: {
					role,
					content: [{ type: "text", text: `${i}-${suffix}` }],
					stopReason,
					toolCallId: `${i}-c`,
					toolName: "read",
					timestamp: 1,
				},
			} as unknown as SessionEntry);
		}
	}
	return entries;
}

test("ten complete turns then older pages retain tool interactions and have no duplicates", () => {
	const entries = fixture(25);
	const first = historyTurnPage(entries, 10, 2 * 1024 * 1024);
	assert.equal(first.entryIds[0], "15-u");
	assert.equal(first.entryIds.length, 40);
	assert.equal(first.hasMore, true);
	const second = historyTurnPage(entries, 10, 2 * 1024 * 1024, first.oldestEntryId ?? undefined);
	const last = historyTurnPage(entries, 10, 2 * 1024 * 1024, second.oldestEntryId ?? undefined);
	assert.equal(second.entryIds[0], "5-u");
	assert.equal(last.entryIds.length, 20);
	assert.equal(last.hasMore, false);
	assert.deepEqual(
		[...last.entryIds, ...second.entryIds, ...first.entryIds],
		entries.map((e) => e.id),
	);
});

test("active branch and cursors reject abandoned or mid-turn entries", () => {
	const entries = fixture(12);
	const page = historyTurnPage(entries, 10, 999999, undefined, "5-a");
	assert.equal(page.entryIds.at(-1), "5-a");
	assert.throws(() => historyTurnPage(entries, 10, 999999, "10-u", "5-a"));
	assert.throws(() => historyTurnPage(entries, 10, 999999, "5-tool"));
});

test("budget cuts only whole turns and explicitly rejects oversized single turns", () => {
	const entries = fixture(3);
	const one = historyTurnPage(entries, 1, 999999);
	const page = historyTurnPage(entries, 3, one.bytes + 1);
	assert.deepEqual(page.entryIds, one.entryIds);
	assert.equal(page.hasMore, true);
	assert.throws(() => historyTurnPage(entries, 1, 1), /安全传输上限/);
});

test("consecutive user steering stays in a turn; pending newest user stays visible", () => {
	const entries = fixture(12);
	entries[2] = { ...entries[2], message: { role: "user", content: "steer", timestamp: 2 } } as SessionEntry;
	const last = entries[entries.length - 1];
	entries.push({ ...entries[0], id: "pending", parentId: last.id });
	const page = historyTurnPage(entries, 10, 999999);
	assert.equal(page.entryIds[0], "3-u");
	assert.equal(page.entryIds.at(-1), "pending");
	const all = historyTurnPage(entries.slice(0, 4), 1, 999999);
	assert.deepEqual(all.entryIds, ["0-u", "0-call", "0-tool", "0-a"]);
});

test("aborted assistant with tool calls ends the interrupted turn", () => {
	const entries = fixture(12);
	entries[43] = {
		...entries[43],
		message: {
			role: "assistant",
			stopReason: "aborted",
			content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
		},
	} as SessionEntry;
	const page = historyTurnPage(entries, 1, 999999);
	assert.equal(page.entryIds[0], "11-u");
});
