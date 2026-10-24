// R2 合成场景：输入框由**另一个正常 custom editor** 占用。
// 本扩展只安装一个普通 CustomEditor（不注册 `app.message.dequeue` 动作，也不是
// 桥接的工厂），用来验证桥接在"别家编辑器在岗"时的停止与队列归属；不模拟坏扩展，
// 也不读别家编辑器的私有状态。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

export default function foreignEditor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, context) => {
		// 只在没有别的 custom editor 时装自己：就是"普通第三方编辑器"的位置。
		if (context.ui.getEditorComponent() !== undefined) return;
		context.ui.setEditorComponent((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings));
	});
	pi.on("session_shutdown", (_event, context) => {
		context.ui.setEditorComponent(undefined);
	});
}
