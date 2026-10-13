import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCredential } from "../src/credentials.ts";

const TOKEN = "A".repeat(43);
const CODE = "b".repeat(43);

function queryOf(params: Record<string, string>): URLSearchParams {
	return new URLSearchParams(params);
}

describe("credential extraction", () => {
	it("extracts a long-lived token from the Authorization header", () => {
		const credential = extractCredential({ authorization: `Bearer ${TOKEN}` }, queryOf({}));
		assert.deepEqual(credential, { kind: "token", value: TOKEN });
	});

	it("is case-insensitive for the Bearer scheme", () => {
		const credential = extractCredential({ authorization: `bearer ${TOKEN}` }, queryOf({}));
		assert.deepEqual(credential, { kind: "token", value: TOKEN });
	});

	it("rejects malformed Authorization values", () => {
		assert.equal(extractCredential({ authorization: `Bearer ${"A".repeat(42)}` }, queryOf({})), undefined);
		assert.equal(extractCredential({ authorization: `Bearer ${"A".repeat(44)}` }, queryOf({})), undefined);
		assert.equal(extractCredential({ authorization: `Bearer ${"A".repeat(42)}=` }, queryOf({})), undefined);
		assert.equal(extractCredential({ authorization: `Basic ${TOKEN}` }, queryOf({})), undefined);
		assert.equal(extractCredential({ authorization: `Bearer +/${"A".repeat(41)}` }, queryOf({})), undefined);
	});

	it("extracts token and pairing credentials from the WebSocket subprotocol", () => {
		assert.deepEqual(extractCredential({ "sec-websocket-protocol": `pi-mobile-v1, pi-auth.${TOKEN}` }, queryOf({})), {
			kind: "token",
			value: TOKEN,
		});
		assert.deepEqual(extractCredential({ "sec-websocket-protocol": `pi-mobile-v1,pi-pair.${CODE}` }, queryOf({})), {
			kind: "pairing",
			value: CODE,
		});
	});

	it("rejects subprotocol secrets that are not 43-char base64url", () => {
		assert.equal(extractCredential({ "sec-websocket-protocol": "pi-auth.tooshort" }, queryOf({})), undefined);
		assert.equal(extractCredential({ "sec-websocket-protocol": "pi-pair.$pecial" }, queryOf({})), undefined);
	});

	it("accepts a pairing code from the query as a compatibility fallback", () => {
		const credential = extractCredential({}, queryOf({ pairingCode: CODE }));
		assert.deepEqual(credential, { kind: "pairing", value: CODE });
	});

	it("never accepts a long-lived token from the query", () => {
		assert.equal(extractCredential({}, queryOf({ token: TOKEN })), undefined);
		assert.equal(extractCredential({}, queryOf({ pairingCode: "invalid" })), undefined);
	});

	it("returns undefined without any credential material", () => {
		assert.equal(extractCredential({}, queryOf({})), undefined);
	});
});
