import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fetchProviderModels, joinProviderUrl, ProviderStatusStore, testProvider } from "../src/provider-test.ts";

/** 用一次性 fetch 替身跑 testProvider，返回结果并给出发出的请求。 */
async function withFetch(
	fake: (url: string, init: RequestInit) => Promise<Response> | Response,
	run: (result: Awaited<ReturnType<typeof testProvider>>, request: { url: string; init: RequestInit }) => void,
	input: Parameters<typeof testProvider>[0],
): Promise<void> {
	const original = globalThis.fetch;
	let seen: { url: string; init: RequestInit } | undefined;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		seen = { url: String(url), init: init ?? {} };
		return fake(String(url), init ?? {});
	}) as typeof fetch;
	try {
		const result = await testProvider(input);
		assert.ok(seen, "未发出请求");
		run(result, seen);
	} finally {
		globalThis.fetch = original;
	}
}

describe("joinProviderUrl：复刻 OpenAI SDK 的 baseURL + path 拼接", () => {
	it("baseUrl 以斜杠结尾时去掉 path 的首斜杠", () => {
		// 这正是用户把 baseUrl 填成 https://host/ 时的真实请求：落到站点首页。
		assert.equal(joinProviderUrl("https://h.example/", "/chat/completions"), "https://h.example/chat/completions");
	});

	it("baseUrl 带路径段时直接拼接（pi 要求 baseUrl 自带 /v1）", () => {
		assert.equal(joinProviderUrl("https://h.example/v1", "/chat/completions"), "https://h.example/v1/chat/completions");
		assert.equal(
			joinProviderUrl("https://h.example/v1/", "/chat/completions"),
			"https://h.example/v1/chat/completions",
		);
	});
});

describe("testProvider：把上游表现折算成可展示结论", () => {
	it("Anthropic 404 explains duplicate version segments without silently changing Pi's URL", async () => {
		await withFetch(
			() => new Response("{}", { status: 404 }),
			(result, request) => {
				assert.equal(result.ok, false);
				assert.equal(request.url, "https://h.example/v1/v1/messages");
				assert.match(result.error ?? "", /重复包含\/v1/);
				assert.doesNotMatch(result.error ?? "", /少了 \/v1/);
			},
			{ baseUrl: "https://h.example/v1", api: "anthropic-messages", modelId: "claude" },
		);
	});

	it("200 + JSON：判定连通", async () => {
		await withFetch(
			() => new Response('{"choices":[{"message":{"content":"pong"}}]}', { status: 200 }),
			(result, request) => {
				assert.equal(result.ok, true);
				assert.equal(result.httpStatus, 200);
				assert.equal(request.url, "https://h.example/v1/chat/completions");
				assert.equal(request.init.method, "POST");
				// max_tokens 不能取最小合法值：GLM 等上游要求 > 2，e2e 实测过小会把
				// “配置正确”误报成上游错误。
				const body = JSON.parse(String(request.init.body)) as { max_tokens?: number };
				assert.ok((body.max_tokens ?? 0) > 2, "max_tokens 应大于 2");
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("200 但 body 含 error 键：各种形态都要判失败（否则“测了也白测”）", async () => {
		for (const body of ['{"error":{"message":"rate limited"}}', '{"error":"rate limited"}', '{"error":{"code":500}}']) {
			await withFetch(
				() => new Response(body, { status: 200 }),
				(result) => {
					assert.equal(result.ok, false, `未识别错误响应：${body}`);
					assert.equal(result.error !== undefined, true);
				},
				{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
			);
		}
	});

	it("200 + 正常 JSON 不再依赖 error 子串猜测（只认 error 键）", async () => {
		// 顶层 message 字段且文本里出现 error 字样：不应误判为失败。
		await withFetch(
			() => new Response('{"model":"m1","message":"no errors here"}', { status: 200 }),
			(result) => assert.equal(result.ok, true),
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("超时与截断响应都归入可展示结论", async () => {
		await withFetch(
			() => {
				const error = new Error("The operation was aborted due to timeout");
				throw error;
			},
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /超时|无法连接/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
		// 超大 HTML：读取到上限即断（不抛错），仍应识别为“网页而不是 API 响应”。
		await withFetch(
			() => new Response(`<!doctype html>${"x".repeat(200_000)}`, { status: 200 }),
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /网页而不是 API 响应/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("200 但是网页 HTML：明确指向 baseUrl 少了路径段（本次真实故障）", async () => {
		await withFetch(
			() => new Response("<!doctype html><html><head><title>网关首页</title></head></html>", { status: 200 }),
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /网页而不是 API 响应/);
				assert.match(result.error ?? "", /\/v1/);
			},
			{ baseUrl: "https://h.example/", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("401/404/重定向/非 JSON 各有可操作文案", async () => {
		await withFetch(
			() => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /认证失败/);
				assert.match(result.error ?? "", /invalid api key/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "bad", modelId: "m1" },
		);
		await withFetch(
			() => new Response("not found", { status: 404 }),
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /端点不存在/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
		await withFetch(
			() =>
				new Response("", {
					status: 302,
					headers: { location: "https://h.example/login" },
				}),
			(result) => {
				assert.equal(result.ok, false);
				assert.match(result.error ?? "", /重定向/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("网络异常折算为临时失败，不抛错也不禁用 provider", async () => {
		await withFetch(
			() => {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
				});
			},
			(result) => {
				assert.equal(result.ok, false);
				assert.equal(result.failureKind, "transient");
				assert.match(result.error ?? "", /无法连接|超时/);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" },
		);
	});

	it("openai-responses 使用 Responses 端点与载荷，不误测 chat/completions", async () => {
		await withFetch(
			(url, init) => {
				const body = JSON.parse(String(init.body));
				const valid = url.endsWith("/responses") && Array.isArray(body.input) && body.max_output_tokens >= 16;
				return new Response(
					JSON.stringify(valid ? { output: [] } : { error: { message: "unsupported endpoint or payload" } }),
					{ status: valid ? 200 : 404 },
				);
			},
			(result, request) => {
				assert.equal(result.ok, true);
				assert.equal(request.url, "https://h.example/v1/responses");
				assert.equal((request.init.headers as Record<string, string>).authorization, "Bearer sk-x");
				const body = JSON.parse(String(request.init.body));
				assert.equal(body.model, "m1");
				assert.equal(body.store, false);
				assert.equal(body.input[0].role, "user");
				assert.equal(body.input[0].content[0].text, "ping");
				assert.equal("messages" in body, false);
				assert.equal("max_tokens" in body, false);
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", api: "openai-responses", modelId: "m1" },
		);
	});

	it("anthropic / google 协议走各自的端点与鉴权头", async () => {
		await withFetch(
			() => new Response("{}", { status: 200 }),
			(_result, request) => {
				// Anthropic SDK 自拼 /v1/messages（客户端 baseURL 不含 /v1）。
				assert.equal(request.url, "https://h.example/v1/messages");
				assert.equal((request.init.headers as Record<string, string>)["x-api-key"], "sk-x");
				assert.equal((request.init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
			},
			{ baseUrl: "https://h.example", apiKey: "sk-x", api: "anthropic-messages", modelId: "m1" },
		);
		await withFetch(
			() => new Response("{}", { status: 200 }),
			(_result, request) => {
				assert.equal(
					request.url,
					"https://h.example/v1/models/m1:generateContent".replace("m1", encodeURIComponent("m1")),
				);
				assert.equal((request.init.headers as Record<string, string>)["x-goog-api-key"], "sk-x");
			},
			{ baseUrl: "https://h.example/v1", apiKey: "sk-x", api: "google-generative-ai", modelId: "m1" },
		);
	});

	it("缺 baseUrl 协议或模型 id 时直接给结论，不发请求", async () => {
		assert.equal((await testProvider({ baseUrl: "ftp://x", modelId: "m1" })).ok, false);
		const noModel = await testProvider({ baseUrl: "https://h.example/v1", modelId: "  " });
		assert.equal(noModel.ok, false);
		assert.match(noModel.error ?? "", /模型 id/);
	});

	it("失败归因：配置类 vs 临时类（后者不得禁用 provider）", async () => {
		const kindOf = async (fake: () => Promise<Response> | Response, input: Parameters<typeof testProvider>[0]) => {
			let kind: string | undefined;
			await withFetch(
				fake,
				(result) => {
					assert.equal(result.ok, false);
					kind = result.failureKind;
				},
				input,
			);
			return kind;
		};
		const base = { baseUrl: "https://h.example/v1", apiKey: "sk-x", modelId: "m1" };
		// 超时 / 5xx / 429 → transient：上游问题，不得把 provider 标成未连通。
		assert.equal(
			await kindOf(() => {
				throw new Error("The operation was aborted due to timeout");
			}, base),
			"transient",
		);
		assert.equal(await kindOf(() => new Response("oops", { status: 503 }), base), "transient");
		assert.equal(await kindOf(() => new Response("slow down", { status: 429 }), base), "transient");
		// 配置类：网页 HTML / 404 / 401。
		assert.equal(await kindOf(() => new Response("<!doctype html><html></html>", { status: 200 }), base), "config");
		assert.equal(await kindOf(() => new Response("nf", { status: 404 }), base), "config");
		assert.equal(await kindOf(() => new Response("{}", { status: 401 }), base), "config");
	});
});

describe("ProviderStatusStore：只有“测过且失败”才算未激活", () => {
	it("无记录＝激活；失败＝未激活；成功恢复；删除清理；损坏文件回退激活", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mgw-provider-status-"));
		const path = join(dir, "provider-status.json");
		const store = new ProviderStatusStore(path);
		// 无记录（电脑上手工添加的 provider）必须视为激活，否则会被手机端隐藏。
		assert.equal(store.isActive("manual"), true);
		// 文件损坏：同样回退激活（fail-open，不隐藏既有配置）。
		writeFileSync(path, "{ not json");
		assert.equal(new ProviderStatusStore(path).isActive("broken"), true);

		store.set("relay", { ok: false, testedAt: "2026-09-17T00:00:00.000Z", error: "网页而不是 API 响应" });
		assert.equal(store.isActive("relay"), false);
		assert.match(store.get("relay")?.error ?? "", /网页/);

		store.set("relay", { ok: true, testedAt: "2026-09-17T01:00:00.000Z" });
		assert.equal(store.isActive("relay"), true);

		store.remove("relay");
		assert.equal(store.get("relay"), undefined);
		assert.equal(store.isActive("relay"), true);
		// 落盘格式：可被下一次进程读回。
		store.set("relay2", { ok: false, testedAt: "2026-09-17T02:00:00.000Z" });
		const reread = new ProviderStatusStore(path);
		assert.equal(reread.isActive("relay2"), false);
		assert.ok(readFileSync(path, "utf8").includes("relay2"));
	});
});

describe("fetchProviderModels", () => {
	const withFetch = async (
		handler: (url: string, headers: Record<string, string>) => Response,
		run: (calls: Array<{ url: string; headers: Record<string, string> }>) => Promise<void>,
	) => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({ url: String(url), headers });
			return handler(String(url), headers);
		}) as typeof fetch;
		try {
			await run(calls);
		} finally {
			globalThis.fetch = original;
		}
	};

	it("builds the per-protocol URL and auth header", async () => {
		// anthropic 的 baseUrl 不含 /v1（SDK 自己拼段），列模型端点是 /v1/models：
		// 漏了这一段会 404——正好复现"测试连接能过、拉取模型失败"（reviewer P1）。
		const cases = [
			{
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				url: "https://api.anthropic.com/v1/models?limit=100",
				header: "x-api-key",
				value: "sk-x",
			},
			{
				api: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				url: "https://generativelanguage.googleapis.com/v1beta/models",
				header: "x-goog-api-key",
				value: "sk-x",
			},
			{
				api: "openai-completions",
				baseUrl: "https://relay.example/v1",
				url: "https://relay.example/v1/models",
				header: "authorization",
				value: "Bearer sk-x",
			},
		];
		for (const testCase of cases) {
			await withFetch(
				() => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }),
				async (calls) => {
					const result = await fetchProviderModels({
						baseUrl: testCase.baseUrl,
						apiKey: "sk-x",
						api: testCase.api,
					});
					assert.equal(result.ok, true, testCase.api);
					assert.equal(calls[0].url, testCase.url, testCase.api);
					assert.equal(calls[0].headers[testCase.header], testCase.value, testCase.api);
				},
			);
		}
	});

	it("classifies 401 as config, 429/5xx as transient", async () => {
		await withFetch(
			() => new Response("nope", { status: 401 }),
			async () => {
				const result = await fetchProviderModels({ baseUrl: "https://relay.example/v1", apiKey: "bad" });
				assert.equal(result.ok, false);
				assert.equal(result.failureKind, "config");
				assert.match(String(result.error), /认证失败/);
			},
		);
		await withFetch(
			() => new Response("slow down", { status: 429 }),
			async () => {
				const result = await fetchProviderModels({ baseUrl: "https://relay.example/v1", apiKey: "k" });
				assert.equal(result.ok, false);
				assert.equal(result.failureKind, "transient");
			},
		);
		await withFetch(
			() => new Response("boom", { status: 503 }),
			async () => {
				const result = await fetchProviderModels({ baseUrl: "https://relay.example/v1", apiKey: "k" });
				assert.equal(result.ok, false);
				assert.equal(result.failureKind, "transient");
			},
		);
	});

	it("parses the three response shapes and rejects an empty list", async () => {
		const shapes: Array<[unknown, string[]]> = [
			[{ data: [{ id: "a" }, { id: "b" }] }, ["a", "b"]],
			// google 的 name 带 models/ 前缀
			[{ models: [{ name: "models/gemini-x" }] }, ["gemini-x"]],
			// 部分中转直接返回裸数组
			[[{ id: "c" }], ["c"]],
		];
		for (const [body, expected] of shapes) {
			await withFetch(
				() => new Response(JSON.stringify(body), { status: 200 }),
				async () => {
					const result = await fetchProviderModels({ baseUrl: "https://relay.example/v1", apiKey: "k" });
					assert.deepEqual(result.ids, expected);
				},
			);
		}
		await withFetch(
			() => new Response(JSON.stringify({ data: [] }), { status: 200 }),
			async () => {
				const result = await fetchProviderModels({ baseUrl: "https://relay.example/v1", apiKey: "k" });
				assert.equal(result.ok, false);
				assert.equal(result.failureKind, "config");
			},
		);
	});
});
