import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createRegistry } from "../src/devices.ts";

const dirs: string[] = [];
function tempDeviceFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mgw-devices-"));
	dirs.push(dir);
	return join(dir, "devices.json");
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("device registry: pairing codes", () => {
	it("creates single-use codes with 256-bit entropy and a TTL", () => {
		const file = tempDeviceFile();
		const current = 1_000_000;
		const registry = createRegistry(file, { now: () => current, pairingTtlMs: 60_000 });
		const pairing = registry.createPairing("我的手机");
		assert.match(pairing.code, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(pairing.name, "我的手机");
		assert.equal(pairing.expiresAt, current + 60_000);
	});

	it("uses a default name when none is given", () => {
		const registry = createRegistry(tempDeviceFile());
		const pairing = registry.createPairing(undefined);
		assert.equal(pairing.name, "未命名设备");
	});

	it("expires outstanding pairing codes", () => {
		let current = 1_000_000;
		const registry = createRegistry(tempDeviceFile(), { now: () => current, pairingTtlMs: 1_000 });
		const pairing = registry.createPairing("手机");
		current += 2_000;
		assert.equal(registry.claimPairing(pairing.code, "install-0001"), undefined);
	});

	it("is single-use: a second claim fails even after a successful one", () => {
		const registry = createRegistry(tempDeviceFile());
		const pairing = registry.createPairing("手机");
		const first = registry.claimPairing(pairing.code, "install-0001");
		assert.ok(first);
		assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(registry.claimPairing(pairing.code, "install-0001"), undefined);
	});
});

describe("device registry: devices and tokens", () => {
	it("claims create a device and only token digests are persisted", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const pairing = registry.createPairing("手机");
		const claimed = registry.claimPairing(pairing.code, "install-0001");
		assert.ok(claimed);
		assert.equal(registry.count(), 1);
		const raw = JSON.parse(readFileSync(file, "utf8")) as {
			devices: Array<{ tokenHash?: string; token?: string }>;
		};
		assert.equal(raw.devices.length, 1);
		assert.equal(raw.devices[0]?.tokenHash?.length, 64);
		assert.ok(!("token" in (raw.devices[0] ?? {})));
	});

	it("re-pairing with the same installation ID rotates the token without duplicating", () => {
		const registry = createRegistry(tempDeviceFile());
		const first = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(first);
		const second = registry.claimPairing(registry.createPairing("新手机名").code, "install-0001");
		assert.ok(second);
		assert.notEqual(second.token, first.token);
		assert.equal(registry.count(), 1);
		assert.equal(registry.list()[0]?.name, "新手机名");
		// The old token must stop working.
		assert.equal(registry.authenticate(first.token), undefined);
		assert.ok(registry.authenticate(second.token));
	});

	it("rejects invalid tokens", () => {
		const registry = createRegistry(tempDeviceFile());
		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);
		assert.equal(registry.authenticate("x".repeat(43)), undefined);
		assert.equal(registry.authenticate(""), undefined);
	});

	it("revoking removes the device and invalidates its token", () => {
		const registry = createRegistry(tempDeviceFile());
		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);
		assert.equal(registry.revoke(claimed.device.id), true);
		assert.equal(registry.count(), 0);
		assert.equal(registry.authenticate(claimed.token), undefined);
		assert.equal(registry.revoke(claimed.device.id), false);
	});
});

describe("device registry: persistence", () => {
	it("keeps devices across restarts while outstanding pairing codes are lost", () => {
		const file = tempDeviceFile();
		const first = createRegistry(file);
		const pairing = first.createPairing("手机");
		const claimed = first.claimPairing(pairing.code, "install-0001");
		assert.ok(claimed);
		const second = createRegistry(file);
		assert.equal(second.count(), 1);
		assert.ok(second.authenticate(claimed.token));
		// Memory-only pairing codes must not survive a restart.
		const fresh = second.createPairing("备用机");
		const third = createRegistry(file);
		assert.equal(third.claimPairing(fresh.code, "install-0002"), undefined);
	});

	it("binds the installation ID on first authenticated connect (migration path)", () => {
		const file = tempDeviceFile();
		const first = createRegistry(file);
		// Claim without an installation ID, as an early client would.
		const claimed = first.claimPairing(first.createPairing("手机").code, undefined);
		assert.ok(claimed);
		const second = createRegistry(file);
		const device = second.authenticate(claimed.token, "install-0001");
		assert.ok(device);
		assert.equal(second.list()[0]?.connections, 0);
	});
});

describe("device registry: persistence failure consistency", () => {
	// 确定性失败注入：把注册表文件挪走，在原路径放一个同名目录，
	// 使 save() 的 renameSync 稳定命中 EISDIR（不依赖 chmod/root 行为）。
	function breakSave(file: string): void {
		renameSync(file, `${file}.bak`);
		mkdirSync(file);
	}
	function restoreSave(file: string): void {
		rmdirSync(file);
		renameSync(`${file}.bak`, file);
	}

	it("新增设备的 claim 写盘失败时内存不变，恢复后重试成功", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const first = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(first);
		breakSave(file);
		assert.throws(() => registry.claimPairing(registry.createPairing("第二台").code, "install-0002"));
		// 内存保持原状：只有一个设备，原 token 仍然有效
		assert.equal(registry.count(), 1);
		assert.ok(registry.authenticate(first.token, "install-0001"));
		restoreSave(file);
		// 从磁盘重载也应看到同样的状态：一个设备、认得 tokenA
		const reloaded = createRegistry(file);
		assert.equal(reloaded.count(), 1);
		assert.ok(reloaded.authenticate(first.token, "install-0001"));
		// 重试同一流程（新配对码 + 新安装 ID）：成功且两端一致
		const retried = registry.claimPairing(registry.createPairing("第二台").code, "install-0002");
		assert.ok(retried);
		assert.equal(registry.count(), 2);
		const after = createRegistry(file);
		assert.equal(after.count(), 2);
		assert.ok(after.authenticate(first.token, "install-0001"));
		assert.equal(after.authenticate(retried.token, "install-0002")?.name, "第二台");
	});

	it("轮换 token 的 claim 写盘失败时旧凭据不动，恢复后重试成功", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const first = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(first);
		breakSave(file);
		assert.throws(() => registry.claimPairing(registry.createPairing("新名字").code, "install-0001"));
		// 轮换完全未生效：旧 token 认得、名字与设备 ID 都没变
		assert.equal(registry.count(), 1);
		assert.ok(registry.authenticate(first.token));
		assert.equal(registry.list()[0]?.name, "手机");
		assert.equal(registry.list()[0]?.id, first.device.id);
		restoreSave(file);
		// 磁盘也还是旧凭据，重载后一致
		const reloaded = createRegistry(file);
		assert.ok(reloaded.authenticate(first.token));
		assert.equal(reloaded.list()[0]?.name, "手机");
		// 重试轮换：新旧 token 在内存和磁盘上都正确交替
		const second = registry.claimPairing(registry.createPairing("新名字").code, "install-0001");
		assert.ok(second);
		assert.equal(registry.authenticate(first.token), undefined);
		assert.ok(registry.authenticate(second.token));
		const after = createRegistry(file);
		assert.equal(after.count(), 1);
		assert.equal(after.authenticate(second.token)?.name, "新名字");
		assert.equal(after.authenticate(first.token), undefined);
	});

	it("revoke 写盘失败时抛错不伪装成功，恢复后重试成功", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);
		assert.equal(registry.connected(claimed.device.id), true);
		const revokedIds: string[] = [];
		registry.onRevoke((id) => revokedIds.push(id));
		breakSave(file);
		assert.throws(() => registry.revoke(claimed.device.id));
		// 失败的吊销不得触发 onRevoke、不得提前踢连接、不得删内存状态
		assert.deepEqual(revokedIds, []);
		assert.equal(registry.count(), 1);
		assert.ok(registry.authenticate(claimed.token));
		assert.equal(registry.list()[0]?.connections, 1);
		restoreSave(file);
		// 磁盘重载仍是 1 台设备
		const reloaded = createRegistry(file);
		assert.equal(reloaded.count(), 1);
		assert.ok(reloaded.authenticate(claimed.token));
		// 重试吊销：正常删除、触发 handler、落盘同步
		assert.equal(registry.revoke(claimed.device.id), true);
		assert.deepEqual(revokedIds, [claimed.device.id]);
		assert.equal(registry.count(), 0);
		const after = createRegistry(file);
		assert.equal(after.count(), 0);
		assert.equal(after.authenticate(claimed.token), undefined);
	});

	it("认证迁移写盘失败不留半提交状态，恢复后重试真正落到磁盘", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const claimed = registry.claimPairing(registry.createPairing("手机").code, undefined);
		assert.ok(claimed);
		breakSave(file);
		assert.throws(() => registry.authenticate(claimed.token, "install-0001"));
		// 内存照常可用：失败的迁移等于没有发生
		assert.ok(registry.authenticate(claimed.token));
		restoreSave(file);
		// 重试迁移后绑定必须真的写盘，而不是只存在于内存
		assert.ok(registry.authenticate(claimed.token, "install-0001"));
		const raw = JSON.parse(readFileSync(file, "utf8")) as { devices: Array<{ clientDeviceId?: string }> };
		assert.equal(raw.devices[0]?.clientDeviceId, "install-0001");
		const reloaded = createRegistry(file);
		assert.ok(reloaded.authenticate(claimed.token, "install-0001"));
	});

	it("connected 写盘失败时在线计数与 lastSeen 完整回退，恢复后重试成功", () => {
		const file = tempDeviceFile();
		const registry = createRegistry(file);
		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);
		breakSave(file);
		assert.throws(() => registry.connected(claimed.device.id));
		// 计数与 lastSeen 保持调用前的原状
		assert.equal(registry.list()[0]?.connections, 0);
		assert.equal(registry.list()[0]?.online, false);
		assert.equal(registry.list()[0]?.lastSeenAt, null);
		restoreSave(file);
		// 重试连接成功，且 lastSeen 真正写盘
		assert.equal(registry.connected(claimed.device.id), true);
		assert.equal(registry.list()[0]?.connections, 1);
		const raw = JSON.parse(readFileSync(file, "utf8")) as { devices: Array<{ lastSeenAt: number | null }> };
		assert.equal(typeof raw.devices[0]?.lastSeenAt, "number");
	});
});

describe("device registry: online accounting", () => {
	it("tracks concurrent connections per device", () => {
		const registry = createRegistry(tempDeviceFile());
		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);
		const id = claimed.device.id;
		assert.equal(registry.connected(id), true);
		assert.equal(registry.connected(id), true);
		assert.equal(registry.list()[0]?.online, true);
		assert.equal(registry.list()[0]?.connections, 2);
		registry.disconnected(id);
		assert.equal(registry.list()[0]?.connections, 1);
		registry.disconnected(id);
		assert.equal(registry.list()[0]?.online, false);
		registry.disconnected(id); // idempotent
		assert.equal(registry.list()[0]?.connections, 0);
		assert.ok(registry.list()[0]?.lastSeenAt);
	});
});
