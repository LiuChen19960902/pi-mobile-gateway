// Network origin guards, ported from dsh-plugin-mobile-gateway (MIT).
//
// These preserve the original security properties:
// - The data-plane listener accepts private-network clients only (RFC1918,
//   RFC6598 CGNAT for mesh VPNs like Tailscale, IPv6 ULA/link-local), so a host
//   with a public address never exposes plaintext ws:// to the internet.
// - Management requests must be same-origin with an allow-listed Host, which
//   defeats CSRF and DNS rebinding against the localhost listener.
// - Pairing payloads may only point at ws:// for localhost/private hosts;
//   anything public must be wss://.

export function isLocalHostname(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (normalized === "localhost" || normalized === "::1") return true;
	const parts = normalized.split(".");
	return (
		parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
}

export function isPrivateNetworkHostname(hostname: string): boolean {
	let normalized =
		hostname
			.replace(/^\[|\]$/g, "")
			.split("%")[0]
			?.toLowerCase() ?? "";
	if (normalized.startsWith("::ffff:")) normalized = normalized.slice("::ffff:".length);
	if (isLocalHostname(normalized) || normalized.endsWith(".local")) return true;
	const rawParts = normalized.split(".");
	const octets = rawParts.map((part) => Number(part));
	if (
		rawParts.length === 4 &&
		rawParts.every((part) => /^\d{1,3}$/.test(part)) &&
		octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
	) {
		return (
			octets[0] === 10 ||
			(octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
			(octets[0] === 192 && octets[1] === 168) ||
			(octets[0] === 169 && octets[1] === 254) ||
			// RFC 6598 CGNAT (100.64.0.0/10): mesh VPNs such as Tailscale assign
			// node addresses from this range. A tailnet is a private network not
			// routable from the public internet, so plaintext ws:// over it keeps
			// the same threat properties as the RFC1918 ranges above.
			(octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127)
		);
	}
	// IPv6 ULA (fc00::/7) and link-local (fe80::/10).
	return /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(normalized);
}

/** True when the request carries no Origin or an Origin matching its Host. */
export function isSameOrigin(headers: { origin?: unknown; host?: unknown }): boolean {
	const origin = headers.origin;
	if (origin === undefined) return true;
	if (typeof origin !== "string" || typeof headers.host !== "string") return false;
	try {
		return new URL(origin).host === headers.host;
	} catch {
		return false;
	}
}

/** Hosts the localhost management plane is willing to serve. */
export function isAllowedLocalHost(host: unknown): boolean {
	if (typeof host !== "string" || host === "") return false;
	// 方括号优先："[::1]:port" 先整体剥；裸 IPv6（含多个冒号）不能按端口剥。
	const bracketed = /^\[(.+)\](?::\d+)?$/.exec(host);
	const hostname = (bracketed?.[1] ?? (/^[^:]*(:[^:]*)?$/.test(host) ? host.replace(/:\d+$/, "") : host)).toLowerCase();
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export type PublicUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalize a pairing publicUrl. Accepts ws:// and wss:// (http(s)
 * is upgraded for convenience), rejects embedded credentials, query strings and
 * fragments, and requires wss:// outside localhost/private networks.
 */
export function normalizePublicUrl(
	value: string | undefined,
	fallbackWsOrigin: string,
	wsPath: string,
): PublicUrlResult {
	let raw = typeof value === "string" ? value.trim() : "";
	if (raw === "") raw = fallbackWsOrigin + wsPath;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: "publicUrl must be a valid URL" };
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		return {
			ok: false,
			error: "publicUrl must use wss:// (ws:// is allowed only for localhost and private LAN addresses)",
		};
	}
	if (url.username || url.password || url.search || url.hash) {
		return { ok: false, error: "publicUrl must not contain credentials, query parameters, or a fragment" };
	}
	if (url.protocol === "ws:" && !isPrivateNetworkHostname(url.hostname)) {
		return { ok: false, error: "publicUrl must use wss:// outside localhost or a private LAN" };
	}
	// 根路径去尾斜杠："wss://gw.example.com" 与 "wss://gw.example.com/" 同一地址，
	// 统一无斜杠形式，免得客户端字符串比对失配。有路径时原样保留。
	const out = url.toString();
	return { ok: true, url: url.pathname === "/" ? out.slice(0, -1) : out };
}
