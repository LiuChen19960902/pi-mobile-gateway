import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiProviderStore } from "../src/pi-store.ts";
import { readProviderCatalog } from "../src/provider-catalog.ts";

test("catalog exposes only display fields and never enters editable provider config", async () => {
	const root = await mkdtemp(join(tmpdir(), "r21-catalog-"));
	try {
		const path = join(root, "models-store.json");
		const cache = JSON.stringify({
			same: {
				etag: "secret-etag",
				models: [
					{
						id: "m",
						name: "Cache",
						contextWindow: 1000,
						headers: { Authorization: "Bearer secret" },
						apiKey: "hidden",
						baseUrl: "https://secret/",
						unknown: "secret",
					},
				],
			},
		});
		await writeFile(path, cache);
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({ providers: { same: { models: [{ id: "m", name: "Editable" }] } } }),
		);
		const store = new PiProviderStore({ path: join(root, "models.json") });
		assert.deepEqual(await store.listCatalog(), [
			{
				id: "same",
				source: "models-store",
				readOnly: true,
				models: [{ id: "m", name: "Cache", contextWindow: 1000, maxTokens: null }],
			},
		]);
		assert.equal((await store.list())[0].models[0].name, "Editable");
		await store.put({ id: "same", models: [{ id: "m", name: "Edited" }] });
		assert.equal(await readFile(path, "utf8"), cache);
		assert.equal((await store.list())[0].models[0].name, "Edited");
		await store.remove("same");
		assert.equal(await readFile(path, "utf8"), cache);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing cache is empty; torn or invalid cache is retried without silent empty success", async () => {
	const root = await mkdtemp(join(tmpdir(), "r21-catalog-"));
	try {
		const path = join(root, "models-store.json");
		assert.deepEqual(await readProviderCatalog(path), []);
		await writeFile(path, "{");
		await assert.rejects(readProviderCatalog(path), /读取失败/);
		await writeFile(path, "[]");
		await assert.rejects(readProviderCatalog(path), /读取失败/);
		await writeFile(path, "{");
		const reading = readProviderCatalog(path);
		await writeFile(path, JSON.stringify({ cached: { models: [] } }));
		assert.equal((await reading)[0].id, "cached");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
