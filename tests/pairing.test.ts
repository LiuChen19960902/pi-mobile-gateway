import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePairingText, encodePairingText, type PairingPayload } from "../src/pairing.ts";

const payload: PairingPayload = {
	version: 1,
	publicUrl: "ws://203.0.113.10:3082/ws/mobile",
	pairingCode: "b".repeat(43),
	expiresAt: 2_000_000_000_000,
};

describe("pairing payload", () => {
	it("round-trips through the canonical Base64URL text", () => {
		const text = encodePairingText(payload);
		assert.ok(!text.includes("="));
		assert.match(text, /^[A-Za-z0-9_-]+$/);
		const decoded = decodePairingText(text, () => 1_000_000_000_000);
		assert.deepEqual(decoded, { ok: true, payload });
	});

	it("rejects non-Base64URL input: padding, base64, raw JSON, empty", () => {
		const padded = `${encodePairingText(payload)}=`;
		assert.equal(decodePairingText(padded, () => 1_000_000_000_000).ok, false);
		assert.equal(decodePairingText("{}", () => 1_000_000_000_000).ok, false);
		assert.equal(
			decodePairingText(JSON.stringify(payload), () => 1_000_000_000_000).ok,
			false,
			"raw JSON must not be accepted",
		);
		assert.equal(
			decodePairingText(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"), () => 1_000_000_000_000).ok,
			false,
			"standard base64 with padding must not be accepted",
		);
		assert.equal(decodePairingText("", () => 1_000_000_000_000).ok, false);
		assert.equal(decodePairingText(" has whitespace", () => 1_000_000_000_000).ok, false);
	});

	it("rejects payloads with an unknown version or missing fields", () => {
		const craft = (mutate: (p: PairingPayload) => Record<string, unknown>): string =>
			Buffer.from(JSON.stringify(mutate({ ...payload })), "utf8").toString("base64url");
		const now = () => 1_000_000_000_000;
		assert.equal(
			decodePairingText(
				craft((p) => ({ ...p, version: 2 })),
				now,
			).ok,
			false,
		);
		assert.equal(
			decodePairingText(
				craft((p) => ({ ...p, pairingCode: undefined })),
				now,
			).ok,
			false,
		);
		assert.equal(
			decodePairingText(
				craft((p) => ({ ...p, publicUrl: 42 })),
				now,
			).ok,
			false,
		);
		assert.equal(
			decodePairingText(
				craft((p) => ({ ...p, expiresAt: "soon" })),
				now,
			).ok,
			false,
		);
	});

	it("rejects expired payloads", () => {
		const text = encodePairingText({ ...payload, expiresAt: 1_500_000_000_000 });
		const decoded = decodePairingText(text, () => 1_600_000_000_000);
		assert.deepEqual(decoded, { ok: false, reason: "expired" });
	});
});
