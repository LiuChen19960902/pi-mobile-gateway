// Credential extraction for the data-plane WebSocket upgrade.
//
// Wire convention (see PROTOCOL.md):
//   first pair:       Authorization absent; Sec-WebSocket-Protocol: pi-mobile-v1, pi-pair.<one-time-code>
//                     + X-Pi-Device-ID header
//   later connects:   Authorization: Bearer <device-token>
//                     or Sec-WebSocket-Protocol: pi-mobile-v1, pi-auth.<device-token>
//
// Long-lived tokens are never accepted from the URL query: query strings end
// up in proxy logs, browser history and monitoring systems.

export type Credential = { kind: "pairing"; value: string } | { kind: "token"; value: string };

/** 256-bit base64url secret: 43 characters, no padding. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SUBPROTOCOL = "pi-mobile-v1";
const PAIR_PREFIX = "pi-pair.";
const AUTH_PREFIX = "pi-auth.";

export function extractCredential(
	headers: { authorization?: unknown; "sec-websocket-protocol"?: unknown },
	query: URLSearchParams,
): Credential | undefined {
	const authorization = headers.authorization;
	if (typeof authorization === "string") {
		const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization.trim());
		if (match) return { kind: "token", value: match[1] };
	}

	const protocols = headers["sec-websocket-protocol"];
	if (typeof protocols === "string" && protocols !== "") {
		for (const entry of protocols.split(",")) {
			const protocol = entry.trim();
			if (protocol.startsWith(AUTH_PREFIX)) {
				const value = protocol.slice(AUTH_PREFIX.length);
				if (SECRET_PATTERN.test(value)) return { kind: "token", value };
			}
			if (protocol.startsWith(PAIR_PREFIX)) {
				const value = protocol.slice(PAIR_PREFIX.length);
				if (SECRET_PATTERN.test(value)) return { kind: "pairing", value };
			}
		}
	}

	// Compatibility fallback: a one-time pairing code may arrive in the query.
	// Tokens must not.
	const pairing = query.get("pairingCode");
	if (pairing && SECRET_PATTERN.test(pairing)) return { kind: "pairing", value: pairing };

	return undefined;
}
