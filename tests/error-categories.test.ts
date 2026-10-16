import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyDirectoryError, createDirectory, DirectoryError, listDirectories } from "../src/host-fs.ts";

describe("safe filesystem error categories", () => {
	it("classifies OS causes without forwarding private paths or messages", () => {
		for (const [errno, expected] of [
			["EACCES", "directory-permission-denied"],
			["EPERM", "directory-permission-denied"],
			["ENOENT", "directory-not-found"],
			["ENOTDIR", "directory-not-directory"],
			["EROFS", "filesystem-read-only"],
			["ENOSPC", "storage-full"],
		]) {
			const result = classifyDirectoryError(Object.assign(new Error("private path and key"), { code: errno }));
			assert.equal(result?.code, expected);
			assert.ok(!result?.message.includes("private"));
		}
		assert.equal(classifyDirectoryError(new Error("unknown cause")), null);
		assert.equal(classifyDirectoryError({ code: "EIO" }), null);
	});
	it("distinguishes real missing, non-directory and name errors; keeps repeat creation idempotent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-error-categories-"));
		try {
			writeFileSync(join(dir, "file"), "fixture");
			for (const [operation, expected] of [
				[() => listDirectories(join(dir, "missing")), "directory-not-found"],
				[() => listDirectories(join(dir, "file")), "directory-not-directory"],
				[() => createDirectory(dir, "../bad"), "directory-name-invalid"],
				[() => createDirectory(dir, "file"), "directory-name-conflict"],
			] as const) {
				assert.throws(operation, (error: unknown) => error instanceof DirectoryError && error.code === expected);
			}
			assert.equal(createDirectory(dir, "new").created, true);
			assert.equal(createDirectory(dir, "new").created, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
