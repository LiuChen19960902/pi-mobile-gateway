import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

for (const legacy of [false, true]) {
	it(legacy ? "桥接包与旧路径、目录别名只加载一次" : "只登记本地桥接包即可由 Pi 发现入口", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-mobile-package-"));
		try {
			const packagePath = fileURLToPath(new URL("../bridge-extension", import.meta.url));
			const entryPath = join(packagePath, "src/index.ts");
			const aliasRoot = join(root, "bridge-alias");
			symlinkSync(packagePath, aliasRoot, "dir");
			const aliasPath = join(aliasRoot, "src/index.ts");
			writeFileSync(
				join(root, "settings.json"),
				JSON.stringify({ packages: [packagePath], extensions: legacy ? [entryPath, aliasPath] : [] }),
			);
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager: SettingsManager.create(root, root),
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();
			const result = loader.getExtensions();
			assert.deepEqual(result.errors, []);
			assert.equal(
				result.extensions.filter((extension) => realpathSync(extension.path) === realpathSync(entryPath)).length,
				1,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
