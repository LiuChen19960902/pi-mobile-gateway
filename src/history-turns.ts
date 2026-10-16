import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	entryToWireMessage,
	type HistoryPage,
	sanitizeHistoryMessage,
	sliceActiveBranchTail,
	type WireMessage,
} from "./wire.ts";

export class HistoryCursorError extends Error {
	constructor() {
		super("历史位置已变化，请重新加载");
	}
}

export class HistoryTurnPageTooLargeError extends Error {
	constructor() {
		super("单轮历史超过安全传输上限，无法完整加载；请在电脑端查看该轮");
	}
}

/** User-to-final-output groups on the active branch, including the current unfinished turn. */
export function historyTurnPage(
	entries: SessionEntry[],
	turnLimit: number,
	maxBytes: number,
	beforeEntryId?: string,
	startLeafId?: string,
): HistoryPage {
	const branch = sliceActiveBranchTail(entries, Number.MAX_SAFE_INTEGER, undefined, startLeafId);
	if ("error" in branch) throw new HistoryCursorError();
	const groups: SessionEntry[][] = [];
	let group: SessionEntry[] = [];
	let hasUser = false;
	let finished = false;
	for (const entry of branch.entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (hasUser && finished) {
				groups.push(group);
				group = [];
			}
			hasUser = true;
			finished = false;
		}
		group.push(entry);
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			finished =
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				(message.stopReason !== "toolUse" && !message.content.some((part) => part.type === "toolCall"));
		}
	}
	if (group.length) groups.push(group);
	let end = groups.length;
	if (beforeEntryId !== undefined) {
		end = groups.findIndex((entries) => entries[0]?.id === beforeEntryId);
		if (end < 0) throw new HistoryCursorError();
	}
	let start = end;
	let bytes = 0;
	const pages: Array<{ messages: WireMessage[]; ids: string[] }> = [];
	while (start > 0 && end - start < turnLimit) {
		const messages: WireMessage[] = [];
		const ids: string[] = [];
		for (const entry of groups[start - 1]) {
			const wire = entryToWireMessage(entry);
			if (wire) {
				messages.push(sanitizeHistoryMessage(wire));
				ids.push(entry.id);
			}
		}
		const size = messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message), "utf8"), 0);
		if (bytes + size > maxBytes) {
			if (start === end) throw new HistoryTurnPageTooLargeError();
			break;
		}
		bytes += size;
		pages.unshift({ messages, ids });
		start--;
	}
	return {
		messages: pages.flatMap((page) => page.messages),
		entryIds: pages.flatMap((page) => page.ids),
		hasMore: start > 0,
		oldestEntryId: start < end ? groups[start][0].id : null,
		bytes,
	};
}
