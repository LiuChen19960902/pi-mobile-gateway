// Read-only view of Pi's generated cache. No SDK internals or credential fields.
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";

export interface CatalogProvider {
	id: string;
	source: "models-store";
	readOnly: true;
	models: Array<{ id: string; name: string | null; contextWindow: number | null; maxTokens: number | null }>;
}

export async function readProviderCatalog(path: string): Promise<CatalogProvider[]> {
	// Pi writes this cache in place. Require two matching, parseable snapshots;
	// retry transient partial writes, never treat an invalid file as an empty catalog.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const first = await readFile(path, "utf8");
			await pause(20);
			const second = await readFile(path, "utf8");
			if (first !== second) throw new Error("cache changed");
			const data: unknown = JSON.parse(second);
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid cache");
			const result: CatalogProvider[] = [];
			for (const [id, value] of Object.entries(data)) {
				if (!value || typeof value !== "object" || !Array.isArray(value.models)) throw new Error("invalid provider");
				const models: CatalogProvider["models"] = [];
				for (const model of value.models) {
					if (!model || typeof model !== "object" || typeof model.id !== "string") throw new Error("invalid model");
					models.push({
						id: model.id,
						name: typeof model.name === "string" ? model.name : null,
						contextWindow: positiveNumber(model.contextWindow),
						maxTokens: positiveNumber(model.maxTokens),
					});
				}
				result.push({ id, source: "models-store", readOnly: true, models });
			}
			return result.sort((a, b) => a.id.localeCompare(b.id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			if (attempt === 2) throw new Error("models-store.json 读取失败，请稍后重试");
			await pause(30);
		}
	}
	return [];
}

function positiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
