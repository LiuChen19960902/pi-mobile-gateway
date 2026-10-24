// 公开 CustomEditor 适配：只借用原生 `app.message.dequeue` 动作，把原生队列
// 文本截获到手机侧，同时不动电脑草稿。
//
// 原生 `restoreQueuedMessagesToEditor` 会先取 `this.editor.getText()`，把
// `[队列文本, 现稿]` 用空行拼接后 `setText`。捕获期间 getText 返回空串、setText
// 只记录不落地，于是电脑草稿保持原样，取回内容完整交给调用方。
// 动作同步执行，捕获窗口无需异步。

import { CustomEditor } from "@earendil-works/pi-coding-agent";

/** 原生 abort 同步把队列拼到现稿之前；只提取可精确分离的前缀，不外发电脑原稿。
 * 不改写别的 editor；getExpandedText 等导致原稿不能精确匹配时返回 null。
 */
export const MAX_QUEUE_COPY_CHARS = 1_048_576;

export function restoredQueuePrefix(
	before: string,
	after: string,
	submittedTexts: Iterable<string> = [],
): string | null {
	// 恢复失败可留在电脑，不能为尝试复制而阻塞原生输入循环。
	if (before.length > MAX_QUEUE_COPY_CHARS || after.length > MAX_QUEUE_COPY_CHARS) return null;
	if (before === after) return null;
	const suffix = before.trim().length > 0 ? `\n\n${before}` : "";
	if (suffix && !after.endsWith(suffix)) return null;
	const text = suffix ? after.slice(0, -suffix.length) : after;
	if (text.trim().length === 0) return null;
	// getEditorText 可能是外来 editor 的展开表示，不保证等于原生 getText。
	// 原稿后缀匹配只是形状检查；回传内容还必须完全由手机已提交的完整文本组成，
	// 否则它可能混入电脑原稿。白名单仅用于拒绝可疑回读，绝不作为恢复文本来源。
	const known: string[] = [];
	let totalChars = 0;
	let candidates = 0;
	for (const value of submittedTexts) {
		totalChars += value.length;
		if (++candidates > 256 || totalChars > MAX_QUEUE_COPY_CHARS) return null;
		if (value.length > 0) known.push(value);
	}
	let workChars = 0;
	let positions = new Set([0]);
	for (let count = 0; count < 256 && positions.size > 0; count += 1) {
		const next = new Set<number>();
		for (const offset of positions)
			for (const value of known) {
				workChars += value.length;
				if (workChars > 2 * MAX_QUEUE_COPY_CHARS) return null;
				if (!text.startsWith(value, offset)) continue;
				const end = offset + value.length;
				if (end === text.length) return text;
				if (text.startsWith("\n\n", end)) next.add(end + 2);
				if (next.size > 256) return null;
			}
		positions = next;
	}
	return null;
}

/** 取队列结果：见 [BridgeEditor.takeQueuedText]。 */
export type QueueTakeResult = { status: "captured"; text: string } | { status: "not-executed" } | { status: "unknown" };

export class BridgeEditor extends CustomEditor {
	private inputRevision = 0;
	private textRevision = 0;
	checkpoint(): { input: number; text: number; value: string } {
		return { input: this.inputRevision, text: this.textRevision, value: this.getText() };
	}
	/** 只撤回本次导航的自动回填，期间有键盘输入或额外写入就保留现稿。 */
	restoreNavigationFill(before: ReturnType<BridgeEditor["checkpoint"]>, injected: string): void {
		if (this.inputRevision === before.input && this.textRevision === before.text + 1 && this.getText() === injected)
			this.setText(before.value);
	}
	override handleInput(data: string): void {
		this.inputRevision += 1;
		super.handleInput(data);
	}
	private capture: { text: string } | null = null;

	override getText(): string {
		return this.capture ? "" : super.getText();
	}

	override setText(value: string): void {
		if (this.capture) {
			this.capture.text = value;
			return;
		}
		this.textRevision += 1;
		super.setText(value);
	}

	/**
	 * 触发原生取回动作并报告"队列到底怎么样了"（三态，不把未知当已恢复）：
	 * - `captured`：动作执行且写回了文本（可能是空串：队列里没有可拼接的文字）。
	 * - `not-executed`：本 editor 没有 dequeue 动作（例如被其他 custom editor
	 *   接管），我们**没有**动过队列，恢复留给 Pi 原生 abort 语义。
	 * - `unknown`：动作抛错且此前没捕获到任何文本。原型动作先清队列再 setText，
	 *   中途抛错时队列可能已被清空——不能声称"已留在电脑输入框"。
	 */
	takeQueuedText(): QueueTakeResult {
		const action = this.actionHandlers.get("app.message.dequeue");
		if (typeof action !== "function") return { status: "not-executed" };
		const capture = { text: "" };
		this.capture = capture;
		try {
			action();
		} catch {
			// 抛错前已写进 capture 的部分仍须交回调用方，不能丢。
			return capture.text.trim().length > 0 ? { status: "captured", text: capture.text } : { status: "unknown" };
		} finally {
			this.capture = null;
		}
		return { status: "captured", text: capture.text };
	}
}
