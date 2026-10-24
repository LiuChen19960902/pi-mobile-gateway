import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createExtensionStatusStore,
	EXTENSION_STATUS_MAX_TEXT_CHARS,
	normalizeStatusKey,
	normalizeStatusText,
} from "../src/extension-status.ts";

describe("extension status normalization", () => {
	it("strips TUI ANSI colors and folds multiline text into one line", () => {
		assert.equal(normalizeStatusText("\u001b[2m2 agents running\u001b[22m"), "2 agents running");
		assert.equal(normalizeStatusText("line1\nline2\r\n"), "line1 line2");
		assert.equal(normalizeStatusText("   "), undefined);
		assert.equal(normalizeStatusText(undefined), undefined);
	});

	it("strips OSC titles/hyperlinks and leftover control characters", () => {
		const oscTitle = `\u001b]0;window title\u0007ok`;
		assert.equal(normalizeStatusText(oscTitle), "ok");
		const oscHyperlink = `\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\`;
		assert.equal(normalizeStatusText(oscHyperlink), "link");
		assert.equal(normalizeStatusText("a\u0007b\u0000c"), "a b c");
	});

	it("caps text to the wire guard", () => {
		const text = normalizeStatusText("x".repeat(EXTENSION_STATUS_MAX_TEXT_CHARS + 50));
		assert.equal(text?.length, EXTENSION_STATUS_MAX_TEXT_CHARS);
	});

	it("does not split surrogate pairs at the text cap", () => {
		const text = `${"a".repeat(199)}😀`;
		const normalized = normalizeStatusText(text);
		assert.ok(normalized);
		assert.equal(normalized.length, 199);
		assert.equal(normalized.includes("\ud83d"), false, "truncation must not leave a lone high surrogate");
	});

	it("drops malformed OSC payloads that contain a non-ST ESC", () => {
		assert.equal(normalizeStatusText("\u001b]0;title\u001b[2J"), undefined);
	});

	it("preserves bounded keys and ignores oversized keys without aliasing", () => {
		const boundary = "k".repeat(64);
		assert.equal(normalizeStatusKey(`  ${boundary}  `), boundary);
		assert.equal(normalizeStatusKey(`${boundary}x`), undefined);
		assert.equal(normalizeStatusKey("   "), undefined);
	});
});

describe("extension status store", () => {
	it("oversized keys cannot overwrite or clear a legal short key", () => {
		let changes = 0;
		const store = createExtensionStatusStore(() => {
			changes += 1;
		});
		// 此短 key 是旧的长 key 压缩结果；它本身也是合法的原始 key。
		const shortKey = `${"k".repeat(55)}#07d4f6aa`;
		const longKey = "k".repeat(65);
		store.uiContext.setStatus(shortKey, "legal status");
		store.uiContext.setStatus(longKey, undefined);
		assert.deepEqual(store.entries(), [{ key: shortKey, text: "legal status" }]);
		store.uiContext.setStatus(longKey, "ignored");
		assert.deepEqual(store.entries(), [{ key: shortKey, text: "legal status" }]);
		assert.equal(changes, 1);
	});

	it("publishes keyed status entries and clears them", () => {
		let changes = 0;
		const store = createExtensionStatusStore(() => {
			changes += 1;
		});
		store.uiContext.setStatus("b", "second");
		store.uiContext.setStatus("a", "first");
		assert.deepEqual(store.entries(), [
			{ key: "a", text: "first" },
			{ key: "b", text: "second" },
		]);
		assert.equal(changes, 2);

		// 相同 key/文本不重复通知；空文本等价于清除。
		store.uiContext.setStatus("a", "first");
		assert.equal(changes, 2);
		store.uiContext.setStatus("a", undefined);
		store.uiContext.setStatus("b", "");
		assert.deepEqual(store.entries(), []);
		assert.equal(changes, 4);
	});

	it("ignores empty keys and caps the number of rows", () => {
		let changes = 0;
		const store = createExtensionStatusStore(() => {
			changes += 1;
		});
		store.uiContext.setStatus("", "ignored");
		assert.deepEqual(store.entries(), []);
		assert.equal(changes, 0);
		for (let i = 0; i < 20; i += 1) store.uiContext.setStatus(`k${i}`, `v${i}`);
		assert.equal(store.entries().length, 16);
	});
});
