// Extension UI bridge (status only).
//
// Pi 扩展通过公开 `ctx.ui.setStatus(key, text)` 发布一行状态文本（RPC 模式下
// 对应 `extension_ui_request` / `method:"setStatus"`）。网关只桥接这一个显示
// 原语：`setStatus` 的值按会话保存并推给手机；其余扩展 UI 方法保持 no-op，
// 避免在没有对话框协议的情况下让扩展挂起。
//
// 状态是显示提示，不是任务契约：它不证明任务终态，也不能用来决定会话回收。

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

export interface ExtensionStatusEntry {
	key: string;
	text: string;
}

/** 单个扩展状态行的上限（wire 护栏；Pi 自身只 trim，不限长）。 */
export const EXTENSION_STATUS_MAX_TEXT_CHARS = 200;
const MAX_STATUS_ENTRIES = 16;
const MAX_STATUS_KEY_CHARS = 64;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_CSI = String.fromCharCode(0x9b);
/**
 * 去终端控制序列：OSC（ESC ] … BEL/ST）、CSI（ESC [ / C1 0x9b）、
 * 两字节 ESC 序列。手机只显示纯文本，不能把 ANSI 颜色/标题/超链接控制码
 * 当成正文；逐类列出比单一 CSI 正则更完整。
 */
const ANSI_ESCAPE_PATTERN = new RegExp(
	// OSC：ESC ] <payload> (BEL | ESC \\)；payload 允许任意字符（含误用的 ESC）
	`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)` +
		// 未终止的 OSC：吞到文本末尾，避免把控制参数当正文显示
		`|${ESC}\\][\\s\\S]*$` +
		// CSI：ESC [ <parameter/intermediate> <final>
		`|${ESC}\\[[0-?]*[ -/]*[@-~]` +
		// C1 CSI（UTF-8 解码路径可能保留 0x9b）
		`|${C1_CSI}[0-?]*[ -/]*[@-~]` +
		// 其余两字节 ESC 序列：ESC + final byte（如 RIS ESC c、保存/恢复光标）
		`|${ESC}[\\x30-\\x7e]`,
	"g",
);
/** 去掉 ANSI 后仍可能残留的 C0/C1 控制字符（保留普通空格）。 */
function replaceControlChars(value: string): string {
	let result = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
	}
	return result;
}

/** 按 UTF-16 预算截断但退掉被切开的代理对，避免 JSON 出现孤立代理。 */
function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const cut = value.slice(0, maxChars);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function normalizeStatusText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = replaceControlChars(value.replace(ANSI_ESCAPE_PATTERN, "").replace(/[\r\n\t]+/g, " ")).trim();
	if (text === "") return undefined;
	return truncateText(text, EXTENSION_STATUS_MAX_TEXT_CHARS);
}

/** key 只 trim；超出 wire 上限就忽略，避免缩写覆盖其他扩展的合法 key。 */
export function normalizeStatusKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	return key !== "" && key.length <= MAX_STATUS_KEY_CHARS ? key : undefined;
}

export interface ExtensionStatusStore {
	/** 传给 `session.bindExtensions()` 的 UI 上下文。 */
	uiContext: ExtensionUIContext;
	/** 当前状态快照，按 key 排序，保证重发与重连结果稳定。 */
	entries(): ExtensionStatusEntry[];
}

/**
 * 创建一个收集 `setStatus` 的状态仓库。
 *
 * @param onChange 任一状态行实际变化后调用；相同 key 相同文本不重复通知。
 */
export function createExtensionStatusStore(onChange: () => void): ExtensionStatusStore {
	const statuses = new Map<string, string>();
	const notify = (): void => {
		try {
			onChange();
		} catch {
			// 状态只是显示提示；订阅者异常不能打断扩展调用。
		}
	};

	const setStatus = (key: string, text: string | undefined): void => {
		const normalizedKey = normalizeStatusKey(key);
		if (!normalizedKey) return;
		const normalizedText = normalizeStatusText(text);
		if (normalizedText === undefined) {
			if (statuses.delete(normalizedKey)) notify();
			return;
		}
		if (!statuses.has(normalizedKey) && statuses.size >= MAX_STATUS_ENTRIES) return;
		if (statuses.get(normalizedKey) === normalizedText) return;
		statuses.set(normalizedKey, normalizedText);
		notify();
	};

	// 只用于扩展在状态文本里做颜色调用；手机显示纯文本，故所有样式均为恒等。
	const theme = {
		name: "pi-mobile-gateway",
		appearance: "dark",
		colors: {},
		style: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor",
		getThinkingBorderColor: () => (text: string) => text,
		getBashModeBorderColor: () => (text: string) => text,
	} as unknown as Theme;

	const noop = (): void => {};
	const cancelDialog = async (): Promise<undefined> => undefined;

	const uiContext: ExtensionUIContext = {
		select: cancelDialog,
		confirm: async () => false,
		input: cancelDialog,
		notify: noop,
		onTerminalInput: () => noop,
		setStatus,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		// 字符串 widget 也不桥接：状态行足够，且避免把 TUI 面板文本塞进手机界面。
		setWidget: (_key: string, _content: unknown, _options?: unknown) => {},
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async <T>() => undefined as T,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: cancelDialog,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not supported in pi-mobile-gateway" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};

	return {
		uiContext,
		entries: () =>
			[...statuses.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, text]) => ({ key, text })),
	};
}
