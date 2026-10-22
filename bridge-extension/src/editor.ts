// 公开 CustomEditor 适配：只借用原生 `app.message.dequeue` 动作，把原生队列
// 文本截获到手机侧，同时不动电脑草稿。
//
// 原生 `restoreQueuedMessagesToEditor` 会先取 `this.editor.getText()`，把
// `[队列文本, 现稿]` 用空行拼接后 `setText`。捕获期间 getText 返回空串、setText
// 只记录不落地，于是电脑草稿保持原样，取回内容完整交给调用方。
// 动作同步执行，捕获窗口无需异步。

import { CustomEditor } from "@earendil-works/pi-coding-agent";

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
	 * 触发原生取回动作并返回它写入编辑器的文本。返回 null 表示当前
	 * editor 没有可用的 dequeue 动作（例如被其他 custom editor 覆盖）。
	 */
	takeQueuedText(): string | null {
		const action = this.actionHandlers.get("app.message.dequeue");
		if (typeof action !== "function") return null;
		const capture = { text: "" };
		this.capture = capture;
		try {
			action();
		} catch {
			return null;
		} finally {
			this.capture = null;
		}
		return capture.text;
	}
}
