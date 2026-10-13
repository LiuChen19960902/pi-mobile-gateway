import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isAllowedLocalHost,
	isLocalHostname,
	isPrivateNetworkHostname,
	isSameOrigin,
	normalizePublicUrl,
} from "../src/net-guards.ts";

describe("isPrivateNetworkHostname", () => {
	it("accepts loopback, RFC1918, link-local and IPv6 ULA addresses", () => {
		for (const host of [
			"127.0.0.1",
			"127.1.2.3",
			"::1",
			"localhost",
			"myhost.local",
			"10.0.0.5",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.11.160",
			"169.254.7.7",
			"100.64.0.0",
			"100.64.0.1",
			"100.77.3.4",
			"100.127.255.254",
			"100.127.255.255",
			"fd00::1",
			"fc12:3456::1",
			"fe80::1",
			"::ffff:192.168.44.10",
			"[fe80::1%eth0]",
		]) {
			assert.equal(isPrivateNetworkHostname(host), true, host);
		}
	});

	it("rejects public addresses", () => {
		for (const host of [
			"8.8.8.8",
			"1.2.3.4",
			"172.32.0.1",
			"192.169.0.1",
			"2001:db8::1",
			"example.com",
			"100.63.255.255",
			"100.128.0.0",
			"100.128.0.1",
			"10.0.0.",
			"10.0.0. ",
			"127.999.999.999",
		]) {
			assert.equal(isPrivateNetworkHostname(host), false, host);
		}
	});

	it("isLocalHostname accepts only loopback forms", () => {
		assert.equal(isLocalHostname("127.0.0.1"), true);
		assert.equal(isLocalHostname("::1"), true);
		assert.equal(isLocalHostname("localhost"), true);
		assert.equal(isLocalHostname("192.168.44.1"), false);
		assert.equal(isLocalHostname("127.999.999.999"), false);
		assert.equal(isLocalHostname("127.0.0."), false);
	});
});

describe("isSameOrigin", () => {
	it("accepts requests without an Origin header", () => {
		assert.equal(isSameOrigin({ host: "127.0.0.1:3083" }), true);
	});

	it("accepts matching Origin and Host", () => {
		assert.equal(isSameOrigin({ origin: "http://127.0.0.1:3083", host: "127.0.0.1:3083" }), true);
	});

	it("rejects mismatched or malformed Origin", () => {
		assert.equal(isSameOrigin({ origin: "http://evil.example.com", host: "127.0.0.1:3083" }), false);
		assert.equal(isSameOrigin({ origin: "http://127.0.0.1:3083", host: "localhost:3083" }), false);
		assert.equal(isSameOrigin({ origin: "::not a url::", host: "127.0.0.1:3083" }), false);
		assert.equal(isSameOrigin({ origin: 42, host: "127.0.0.1:3083" }), false);
	});
});

describe("isAllowedLocalHost", () => {
	it("accepts only loopback hosts with optional ports", () => {
		for (const host of ["127.0.0.1", "127.0.0.1:3083", "localhost", "localhost:3083", "[::1]", "[::1]:3083", "::1"]) {
			assert.equal(isAllowedLocalHost(host), true, host);
		}
	});

	it("rejects anything else (DNS rebinding defense)", () => {
		for (const host of ["evil.example.com", "evil.example.com:3083", "192.0.2.10:3083", "", undefined, 42]) {
			assert.equal(isAllowedLocalHost(host as string), false, String(host));
		}
	});
});

describe("normalizePublicUrl", () => {
	const fallbackOrigin = "ws://127.0.0.1:3082";

	it("falls back to the loopback data-plane URL", () => {
		const result = normalizePublicUrl(undefined, fallbackOrigin, "/ws/mobile");
		assert.deepEqual(result, { ok: true, url: "ws://127.0.0.1:3082/ws/mobile" });
	});

	it("upgrades http(s) schemes to ws(s)", () => {
		assert.deepEqual(normalizePublicUrl("http://127.0.0.1:3082/ws/mobile", fallbackOrigin, "/ws/mobile"), {
			ok: true,
			url: "ws://127.0.0.1:3082/ws/mobile",
		});
		assert.deepEqual(normalizePublicUrl("https://gw.example.com/ws/mobile", fallbackOrigin, "/ws/mobile"), {
			ok: true,
			url: "wss://gw.example.com/ws/mobile",
		});
	});

	it("strips the trailing slash of root-path URLs", () => {
		assert.deepEqual(normalizePublicUrl("wss://gw.example.com", fallbackOrigin, "/ws/mobile"), {
			ok: true,
			url: "wss://gw.example.com",
		});
		assert.deepEqual(normalizePublicUrl("wss://gw.example.com/", fallbackOrigin, "/ws/mobile"), {
			ok: true,
			url: "wss://gw.example.com",
		});
	});

	it("accepts ws:// only for localhost and private LANs", () => {
		assert.equal(normalizePublicUrl("ws://192.168.44.10:3082/ws/mobile", fallbackOrigin, "/ws/mobile").ok, true);
		assert.equal(normalizePublicUrl("ws://100.64.0.1:3082/ws/mobile", fallbackOrigin, "/ws/mobile").ok, true);
		assert.equal(normalizePublicUrl("ws://gw.example.com/ws/mobile", fallbackOrigin, "/ws/mobile").ok, false);
	});

	it("rejects non-ws schemes, embedded credentials, query and fragment", () => {
		for (const bad of [
			"ftp://example.com/ws/mobile",
			"ws://user:pass@192.0.2.10:3082/ws/mobile",
			"ws://192.0.2.10:3082/ws/mobile?token=x",
			"ws://192.0.2.10:3082/ws/mobile#frag",
			"::not a url::",
		]) {
			const result = normalizePublicUrl(bad, fallbackOrigin, "/ws/mobile");
			assert.equal(result.ok, false, bad);
		}
	});
});
