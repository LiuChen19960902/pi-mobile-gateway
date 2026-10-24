import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { extractCredential } from "../src/credentials.ts";
import { createRegistry } from "../src/devices.ts";

const dirs: string[] = [];
function registryAt(now = () => 1_000_000, pairingTtlMs?: number) {
	const dir = mkdtempSync(join(tmpdir(), "pi-short-pair-"));
	dirs.push(dir);
	const file = join(dir, "devices.json");
	return { file, registry: createRegistry(file, { now, pairingTtlMs }) };
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("六位码保留开头 0，不能作为长期凭据", () => {
	assert.deepEqual(
		extractCredential({ "sec-websocket-protocol": "pi-mobile-v1,pi-pair.001234" }, new URLSearchParams()),
		{ kind: "pairing", value: "001234" },
	);
	assert.deepEqual(extractCredential({}, new URLSearchParams({ pairingCode: "001234" })), {
		kind: "pairing",
		value: "001234",
	});
	for (const code of ["12345", "1234567", "１２３４５６", "12a456"]) {
		assert.equal(extractCredential({ "sec-websocket-protocol": `pi-pair.${code}` }, new URLSearchParams()), undefined);
	}
	assert.equal(extractCredential({ authorization: "Bearer 001234" }, new URLSearchParams()), undefined);
	assert.equal(extractCredential({ "sec-websocket-protocol": "pi-auth.001234" }, new URLSearchParams()), undefined);
});

it("短码两分钟精确到期，期限不能超过长码", () => {
	let now = 1_000_000;
	const { registry } = registryAt(() => now);
	const pair = registry.createPairing("手机");
	assert.match(pair.shortCode, /^[0-9]{6}$/);
	assert.equal(pair.shortCodeExpiresAt, now + 120_000);
	now = pair.shortCodeExpiresAt;
	assert.equal(registry.claimPairing(pair.shortCode, "install-0001"), undefined);
	assert.ok(registry.claimPairing(pair.code, "install-0001"));
	const shorter = registryAt(() => now, 1_000).registry;
	const limited = shorter.createPairing("手机");
	assert.equal(limited.shortCodeExpiresAt, limited.expiresAt);
});

it("第五次错误使整个窗口作废，换猜测值或安装 ID 不重置预算", () => {
	const { registry } = registryAt();
	const pair = registry.createPairing("手机");
	for (let i = 1; i <= 5; i++) {
		const wrong = ((Number(pair.shortCode) + i) % 1_000_000).toString().padStart(6, "0");
		assert.equal(registry.claimPairing(wrong, `install-${i.toString().padStart(4, "0")}`), undefined);
	}
	assert.equal(registry.claimPairing(pair.shortCode, "install-0001"), undefined);
	assert.equal(registry.claimPairing(pair.code, "install-0001"), undefined);
	const next = registry.createPairing("新窗口");
	assert.ok(registry.claimPairing(next.shortCode, "install-0001"));
});

it("四次错误后正确码仍可领取，长短码均不可重放", () => {
	const { registry, file } = registryAt();
	const pair = registry.createPairing("手机");
	for (let i = 1; i <= 4; i++)
		registry.claimPairing(((Number(pair.shortCode) + i) % 1_000_000).toString().padStart(6, "0"), "install-0001");
	const claimed = registry.claimPairing(pair.shortCode, "install-0001");
	assert.ok(claimed);
	assert.match(claimed.token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(registry.claimPairing(pair.code, "install-0001"), undefined);
	assert.equal(registry.claimPairing(pair.shortCode, "install-0001"), undefined);
	assert.ok(registry.authenticate(claimed.token));
	assert.equal(registry.authenticate(pair.shortCode), undefined);
	const stored = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(Object.keys(stored).sort(), ["devices", "version"]);
	assert.equal(stored.devices[0].tokenHash.length, 64);
	assert.equal(stored.devices[0].shortCode, undefined);
	const second = registry.createPairing("第二次");
	assert.ok(registry.claimPairing(second.code, "install-0001"));
	assert.equal(registry.claimPairing(second.shortCode, "install-0001"), undefined);
});

it("新窗口替换旧短码，重启清除所有短码", () => {
	const { registry, file } = registryAt();
	const old = registry.createPairing("旧");
	const fresh = registry.createPairing("新");
	assert.notEqual(old.shortCode, fresh.shortCode);
	assert.equal(registry.claimPairing(old.shortCode, "install-0001"), undefined);
	assert.ok(registry.claimPairing(fresh.shortCode, "install-0001"));
	const outstanding = registry.createPairing("待配对");
	assert.equal(createRegistry(file).claimPairing(outstanding.shortCode, "install-0002"), undefined);
});
