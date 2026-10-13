// Persistent paired-device registry for pi-mobile-gateway authentication.
//
// Security model (ported from dsh-plugin-mobile-gateway, MIT, by Clarklevis1995):
// - Long-lived device tokens carry 256 bits of entropy and are never written to
//   disk; only their SHA-256 digests are persisted.
// - Pairing codes are one-time, short-lived, and memory-only: a restart
//   invalidates every outstanding QR code without affecting paired devices.
// - Claiming a pairing code deletes it before any further work, so a claim is
//   single-use even when the socket upgrade later fails.
// - A valid pairing code authorizes credential rotation: re-pairing a client
//   that presents the same stable installation ID replaces the token on the
//   existing device row instead of duplicating it.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STORE_VERSION = 1;
const DEFAULT_PAIRING_TTL_MS = 30 * 60 * 1000;

export interface StoredDevice {
	id: string;
	name: string;
	clientDeviceId?: string;
	tokenHash: string;
	createdAt: number;
	lastSeenAt: number | null;
}

export interface PublicDevice {
	id: string;
	name: string;
	createdAt: number;
	lastSeenAt: number | null;
	online: boolean;
	connections: number;
}

interface Pairing {
	id: string;
	name: string;
	expiresAt: number;
}

export interface ClaimedPairing {
	device: PublicDevice;
	token: string;
}

export interface RegistryOptions {
	/** Lifetime of one-time pairing codes. Default: 30 minutes. */
	pairingTtlMs?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

export function digest(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const a = Buffer.from(left, "hex");
	const b = Buffer.from(right, "hex");
	return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/** Stable installation-level device ID presented by the client at pairing time. */
export function normalizeClientDeviceId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : undefined;
}

function publicDevice(device: StoredDevice, connections: number): PublicDevice {
	return {
		id: device.id,
		name: device.name,
		createdAt: device.createdAt,
		lastSeenAt: device.lastSeenAt || null,
		online: connections > 0,
		connections,
	};
}

export interface DeviceRegistry {
	list(): PublicDevice[];
	count(): number;
	createPairing(name: unknown): { id: string; name: string; expiresAt: number; code: string };
	claimPairing(code: string, clientDeviceId: string | undefined): ClaimedPairing | undefined;
	authenticate(token: string, clientDeviceId?: string | undefined): PublicDevice | undefined;
	connected(deviceId: string): boolean;
	disconnected(deviceId: string): void;
	revoke(deviceId: string): boolean;
	/** Register a handler invoked after each successful revoke, so enforcement
	 * points (e.g. the data plane) can close the revoked device's connections. */
	onRevoke(handler: (deviceId: string) => void): void;
}

export function createRegistry(file: string, options: RegistryOptions = {}): DeviceRegistry {
	const ttl = options.pairingTtlMs;
	const pairingTtlMs = typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0 ? ttl : DEFAULT_PAIRING_TTL_MS;
	const now = options.now ?? Date.now;
	let devices: StoredDevice[] = [];
	const pairings = new Map<string, Pairing>();
	const online = new Map<string, number>();
	const revokeHandlers: Array<(deviceId: string) => void> = [];

	/**
	 * 把候选设备列表原子写入磁盘；调用方在 save 成功返回后才把内存
	 * devices 提交为这份候选，保证写盘失败时内存与磁盘一致（都停在旧状态）。
	 */
	const save = (candidates: StoredDevice[]) => {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, devices: candidates }, null, 2), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	};

	const load = () => {
		let parsed: { version?: number; devices?: unknown };
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new Error(`failed to load device registry: ${(error as Error).message}`, { cause: error });
		}
		if (!Array.isArray(parsed.devices)) return;
		devices = parsed.devices.flatMap((row: unknown): StoredDevice[] => {
			if (typeof row !== "object" || row === null) return [];
			const candidate = row as Partial<StoredDevice>;
			if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
			const tokenHash = typeof candidate.tokenHash === "string" ? candidate.tokenHash : undefined;
			if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) return [];
			return [
				{
					id: candidate.id,
					name: candidate.name.slice(0, 80),
					clientDeviceId: normalizeClientDeviceId(candidate.clientDeviceId),
					tokenHash,
					createdAt: Number.isFinite(candidate.createdAt) ? (candidate.createdAt as number) : now(),
					lastSeenAt: Number.isFinite(candidate.lastSeenAt) ? (candidate.lastSeenAt as number) : null,
				},
			];
		});
		if (parsed.version !== STORE_VERSION) save(devices);
		else chmodSync(file, 0o600);
	};

	const prunePairings = () => {
		const current = now();
		for (const [codeHash, pairing] of pairings) {
			if (pairing.expiresAt <= current) pairings.delete(codeHash);
		}
	};

	load();

	return {
		list() {
			return devices.map((device) => publicDevice(device, online.get(device.id) || 0));
		},

		count() {
			return devices.length;
		},

		createPairing(name: unknown) {
			prunePairings();
			const code = randomBytes(32).toString("base64url");
			const pairing: Pairing = {
				id: randomUUID(),
				name: typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 80) : "未命名设备",
				expiresAt: now() + pairingTtlMs,
			};
			pairings.set(digest(code), pairing);
			return { ...pairing, code };
		},

		claimPairing(code: string, clientDeviceId: string | undefined) {
			prunePairings();
			if (typeof code !== "string" || code === "") return undefined;
			const codeHash = digest(code);
			const pairing = pairings.get(codeHash);
			if (!pairing) return undefined;
			// Delete before doing any further work: claiming is single-use even if
			// a later socket upgrade fails.
			pairings.delete(codeHash);
			const token = randomBytes(32).toString("base64url");
			let device = clientDeviceId
				? devices.find((candidate) => candidate.clientDeviceId === clientDeviceId)
				: undefined;
			if (device) {
				// A valid one-time pairing code authorizes credential rotation.
				// 轮换：候选快照携带新凭据，save 成功后才替换内存中的设备行。
				const index = devices.indexOf(device);
				const rotated = devices.slice();
				rotated[index] = { ...device, name: pairing.name, tokenHash: digest(token), clientDeviceId };
				save(rotated);
				devices = rotated;
				device = rotated[index];
			} else {
				device = {
					id: pairing.id,
					name: pairing.name,
					clientDeviceId,
					tokenHash: digest(token),
					createdAt: now(),
					lastSeenAt: null,
				};
				const appended = [...devices, device];
				save(appended);
				devices = appended;
			}
			return { device: publicDevice(device, 0), token };
		},

		authenticate(token: string, clientDeviceId?: string) {
			if (typeof token !== "string" || token === "") return undefined;
			const tokenHash = digest(token);
			const device = devices.find((candidate) => safeEqualHex(candidate.tokenHash, tokenHash));
			// Migration path for devices paired before installation IDs existed: a
			// valid long-lived token proves ownership, so bind the client's stable
			// ID without creating a new device row.
			if (device && clientDeviceId && !device.clientDeviceId) {
				const conflict = devices.some(
					(candidate) => candidate !== device && candidate.clientDeviceId === clientDeviceId,
				);
				if (!conflict) {
					// 绑定安装 ID：同样写盘成功后才提交内存。
					const index = devices.indexOf(device);
					const migrated = devices.slice();
					migrated[index] = { ...device, clientDeviceId };
					save(migrated);
					devices = migrated;
				}
			}
			return device ? publicDevice(device, online.get(device.id) || 0) : undefined;
		},

		connected(deviceId: string) {
			const device = devices.find((candidate) => candidate.id === deviceId);
			if (!device) return false;
			// lastSeen 更新同样先写盘后提交：失败时在线计数与 lastSeen 都保持原状。
			// 上游会直接关连接且 close 清理器尚未注册，不会有人误减计数。
			const index = devices.indexOf(device);
			const stamped = devices.slice();
			stamped[index] = { ...device, lastSeenAt: now() };
			save(stamped);
			devices = stamped;
			online.set(deviceId, (online.get(deviceId) || 0) + 1);
			return true;
		},

		disconnected(deviceId: string) {
			const count = online.get(deviceId) || 0;
			if (count <= 1) online.delete(deviceId);
			else online.set(deviceId, count - 1);
		},

		revoke(deviceId: string) {
			const index = devices.findIndex((candidate) => candidate.id === deviceId);
			if (index < 0) return false;
			// 先写盘再删内存：save 失败时设备与在线计数原样保留、onRevoke 不触发，
			// 失败的吊销不会伪装成成功；成功后才踢连接。
			const removed = devices.slice();
			removed.splice(index, 1);
			save(removed);
			devices = removed;
			online.delete(deviceId);
			for (const handler of revokeHandlers) handler(deviceId);
			return true;
		},

		onRevoke(handler: (deviceId: string) => void) {
			revokeHandlers.push(handler);
		},
	};
}
