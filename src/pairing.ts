// Pairing payload: the single canonical wire representation carried by the QR
// code and by manual copy/paste. It is a strict unpadded Base64URL string
// encoding a small JSON envelope — never the long-lived credential itself.

export const PAIRING_PAYLOAD_VERSION = 1;

export interface PairingPayload {
	version: number;
	publicUrl: string;
	pairingCode: string;
	expiresAt: number;
}

const STRICT_BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encode a payload as the canonical unpadded Base64URL pairing text. */
export function encodePairingText(payload: PairingPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePairingText(
	text: string,
	now: () => number = Date.now,
): { ok: true; payload: PairingPayload } | { ok: false; reason: "format" | "json" | "schema" | "version" | "expired" } {
	// Strict decode: reject padding, plain base64, raw JSON and whitespace.
	if (typeof text !== "string" || text === "" || !STRICT_BASE64URL.test(text)) return { ok: false, reason: "format" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
	} catch {
		return { ok: false, reason: "json" };
	}
	if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "schema" };
	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.version !== "number" ||
		typeof candidate.publicUrl !== "string" ||
		typeof candidate.pairingCode !== "string"
	) {
		return { ok: false, reason: "schema" };
	}
	if (candidate.version !== PAIRING_PAYLOAD_VERSION) return { ok: false, reason: "version" };
	const expiresAt = candidate.expiresAt;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { ok: false, reason: "schema" };
	if (expiresAt <= now()) return { ok: false, reason: "expired" };
	return {
		ok: true,
		payload: {
			version: candidate.version,
			publicUrl: candidate.publicUrl,
			pairingCode: candidate.pairingCode,
			expiresAt,
		},
	};
}
