// 合成验证观测扩展：定时把公开编辑器正文、队列布尔状态、busy 写到文件。
// 只读公开 UI 上下文，不安装编辑器、不改变产品行为。

import { renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function observer(pi: ExtensionAPI) {
	const file = process.env.E2E_OBSERVE_FILE;
	if (!file) return;
	let ctx: ExtensionContext | undefined;
	let timer: NodeJS.Timeout | undefined;
	const sample = () => {
		if (!ctx) return;
		try {
			const payload = `${JSON.stringify({
				at: Date.now(),
				pid: process.pid,
				sessionId: ctx.sessionManager.getSessionId(),
				editorText: ctx.ui.getEditorText(),
				pending: ctx.hasPendingMessages(),
				busy: !ctx.isIdle(),
			})}\n`;
			writeFileSync(`${file}.tmp`, payload);
			renameSync(`${file}.tmp`, file);
		} catch {
			// 采样失败不影响被测行为。
		}
	};
	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (!timer) timer = setInterval(sample, 100);
		sample();
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx = undefined;
	});
}
