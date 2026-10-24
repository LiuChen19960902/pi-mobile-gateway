// 合成验证用 Provider 与工具：只走公开扩展 API，不发真实网络请求。
// 文本 `stream:<key>` 在 BEGIN 与 MIDDLE 之间用 gate 文件暂停流，供移动端在
// 中途接入；`tool:<key>` 在助手消息结束后调用一个等待释放的合成工具。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI) {
	pi.registerCommand("fixture-empty-custom", {
		handler: async () => {
			pi.sendMessage({ customType: "fixture-empty", content: "", display: true });
		},
	});

	const root = process.env.E2E_ROOT ?? "/work/state";
	const record = (value: unknown) =>
		appendFileSync(`${root}/fixture.jsonl`, `${JSON.stringify({ at: Date.now(), pid: process.pid, value })}\n`);

	pi.registerTool({
		name: "e2e_hold",
		label: "E2E hold",
		description: "等待释放文件的合成工具，用于观察取消与实时进度",
		parameters: Type.Object({ key: Type.String() }),
		async execute(callId, params, signal, onUpdate) {
			const key = params.key.replace(/[^a-zA-Z0-9_-]/g, "_");
			record({ tool: "start", callId, key });
			const deadline = Date.now() + 20_000;
			let ticks = 0;
			try {
				while (!existsSync(`${root}/gates/${key}.release`)) {
					if (Date.now() >= deadline) throw new Error("fixture gate timed out");
					onUpdate?.({ content: [{ type: "text", text: `WAIT:${key}:${++ticks}` }], details: { key, ticks } });
					await delay(150, undefined, { signal });
				}
				record({ tool: "done", callId, key });
				return { content: [{ type: "text", text: `TOOL-DONE:${key}` }], details: { key } };
			} catch (error) {
				record({ tool: "aborted-or-failed", callId, key });
				throw error;
			}
		},
	});

	pi.registerProvider("fixture", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "synthetic-not-a-real-key",
		api: "fixture-offline",
		models: [
			{
				id: "reasoning",
				name: "Scoped reasoning",
				reasoning: true,
				input: process.env.E2E_IMAGE === "1" ? ["text", "image"] : ["text"],
				contextWindow: 65536,
				maxTokens: 4096,
				thinkingLevelMap: { off: null, xhigh: "high" },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "extra",
				name: "Global only",
				reasoning: false,
				input: process.env.E2E_IMAGE === "1" ? ["text", "image"] : ["text"],
				contextWindow: 65536,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "offline",
				name: "E2E Fixture",
				reasoning: false,
				input: process.env.E2E_IMAGE === "1" ? ["text", "image"] : ["text"],
				contextWindow: 65536,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const messages = context.messages;
			let userIndex = -1;
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (messages[index]?.role === "user") {
					userIndex = index;
					break;
				}
			}
			const user = messages[userIndex];
			const content = user?.role === "user" ? user.content : "";
			const text =
				typeof content === "string"
					? content
					: content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("");
			const key = text.replace(/^(tool|stream):/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			void (async () => {
				try {
					if (
						existsSync(`${root}/compact-control.json`) &&
						JSON.parse(readFileSync(`${root}/compact-control.json`, "utf8")).mode === "default-fail"
					)
						throw new Error("synthetic compaction provider failure");
					record({
						modelRequest: true,
						model: model.id,
						reasoning: options?.reasoning,
						text,
						imageCount: Array.isArray(content) ? content.filter((c) => c.type === "image").length : 0,
						afterTool: messages.slice(userIndex + 1).some((m) => m.role === "toolResult"),
					});
					if (process.env.E2E_IMAGE === "1" && text === "image:fail") throw new Error("synthetic image failure");
					stream.push({ type: "start", partial: output });
					const block = { type: "text" as const, text: "" };
					output.content.push(block);
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					for (const part of [`BEGIN:${text}\n`, `MIDDLE:${text}\n`, `END:${text}`]) {
						if (options?.signal?.aborted) throw new Error("fixture aborted");
						block.text += part;
						stream.push({ type: "text_delta", contentIndex: 0, delta: part, partial: output });
						record({ streamChunk: part, text });
						if (text.startsWith("stream:") && !part.startsWith("END:")) {
							const gate = part.startsWith("BEGIN:") ? key : `${key}-finish`;
							const deadline = Date.now() + 20_000;
							while (!existsSync(`${root}/gates/${gate}.release`)) {
								if (Date.now() >= deadline) throw new Error("fixture stream gate timed out");
								await delay(100, undefined, { signal: options?.signal });
							}
						}
						await delay(75, undefined, { signal: options?.signal });
					}
					stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
					const needsTool =
						text.startsWith("tool:") && !messages.slice(userIndex + 1).some((m) => m.role === "toolResult");
					if (needsTool) {
						const call = {
							type: "toolCall" as const,
							id: `call_${key}`,
							name: "e2e_hold",
							arguments: {} as { key?: string },
						};
						output.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
						call.arguments = { key };
						stream.push({
							type: "toolcall_delta",
							contentIndex: 1,
							delta: JSON.stringify(call.arguments),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
					}
					output.stopReason = needsTool ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
				} catch (error) {
					const aborted = options?.signal?.aborted === true;
					output.stopReason = aborted ? "aborted" : "error";
					output.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: output.stopReason, error: output });
					stream.end();
				}
			})();
			return stream;
		},
	});

	pi.on("session_before_compact", async (event) => {
		const path = `${root}/compact-control.json`;
		if (!existsSync(path)) return;
		const control = JSON.parse(readFileSync(path, "utf8")) as { mode: string };
		record({ compactionHook: true, mode: control.mode, tokensBefore: event.preparation.tokensBefore });
		if (control.mode === "hold") {
			while (!existsSync(`${root}/gates/compact.release`)) await delay(40, undefined, { signal: event.signal });
		}
		if (control.mode === "default-fail") return;
		return {
			compaction: {
				summary: "Synthetic compaction summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	pi.on("session_start", () => {
		mkdirSync(`${root}/gates`, { recursive: true });
		pi.setActiveTools(["e2e_hold"]);
	});
}
