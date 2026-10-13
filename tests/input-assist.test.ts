import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	completeAtToken,
	createInputAssist,
	findFd,
	InputAssistError,
	type InputResources,
	readInputContext,
	sessionInputResources,
} from "../src/input-assist.ts";
import type { PiSessionLike } from "../src/pi-runtime.ts";

const emptyResources: InputResources = {
	cwd: "/tmp",
	mode: "session",
	complete: true,
	skillCommandsEnabled: true,
	commands: [],
	shadowed: [],
	omitted: [],
};
const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-input-assist-"));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	return { root, cwd, clean: () => rmSync(root, { recursive: true, force: true }) };
}

describe("input assistance contracts", () => {
	it("requires one bounded context and rejects mixed or malformed identities", () => {
		assert.deepEqual(readInputContext({ sessionId: "s" }), { sessionId: "s" });
		assert.deepEqual(readInputContext({ cwd: "/tmp" }), { cwd: "/tmp" });
		for (const value of [
			{},
			{ cwd: " " },
			{ sessionId: "s", cwd: "/tmp" },
			{ sessionId: 1, cwd: "/tmp" },
			{ cwd: "/tmp\0x" },
			{ sessionId: "s".repeat(257) },
		]) {
			assert.throws(() => readInputContext(value), InputAssistError);
		}
	});

	it("suggests explicit-only skills, preserves argument hints, and removes extension-shadowed commands", () => {
		const session = {
			settingsManager: { getEnableSkillCommands: () => true },
			resourceLoader: {
				getSkills: () => ({ skills: [{ name: "audit", description: "Audit", disableModelInvocation: true }] }),
			},
			promptTemplates: [
				{
					name: "eval",
					description: "Evaluate",
					argumentHint: "[target]",
					content: "private body",
					filePath: "/private/prompt.md",
				},
				{ name: "review", description: "Hidden" },
			],
			extensionRunner: { getRegisteredCommands: () => [{ invocationName: "review" }] },
		} as unknown as PiSessionLike;
		const result = sessionInputResources(session, "/tmp/project");
		assert.deepEqual(
			result.commands.map((item) => item.name),
			["eval", "skill:audit"],
		);
		assert.equal(result.commands[0].argumentHint, "[target]");
		assert.equal(result.commands[1].disableModelInvocation, true);
		assert.deepEqual(result.shadowed, [{ name: "review", source: "prompt", by: "extension" }]);
		assert.ok(!JSON.stringify(result).includes("private"));
		const disabled = { ...session, settingsManager: { getEnableSkillCommands: () => false } };
		assert.deepEqual(
			sessionInputResources(disabled, "/tmp/project").commands.map((item) => item.name),
			["eval"],
		);
	});

	it("a template named skill:name stays shadowed even when skill suggestions are disabled", () => {
		const session = {
			settingsManager: { getEnableSkillCommands: () => false },
			resourceLoader: {
				getSkills: () => ({ skills: [{ name: "audit", description: "Audit", disableModelInvocation: false }] }),
			},
			promptTemplates: [
				{ name: "skill:audit", description: "Shadowed" },
				{ name: "skill:unknown", description: "Callable" },
			],
		} as unknown as PiSessionLike;
		const result = sessionInputResources(session, "/tmp");
		assert.deepEqual(
			result.commands.map((item) => item.name),
			["skill:unknown"],
		);
		assert.deepEqual(result.shadowed, [{ name: "skill:audit", source: "prompt", by: "skill" }]);
	});

	it("bad requests and errors retain query IDs without leaking internal paths", async () => {
		const frames: Record<string, unknown>[] = [];
		const service = createInputAssist(
			{
				inputCwd: async () => {
					throw new Error("private /home/user/config");
				},
				inputResources: async () => emptyResources,
			},
			(frame) => frames.push(frame),
			() => {},
		);
		await service.handle({ type: "input-completions", queryId: "bad", cwd: "/tmp", sessionId: "s", token: "@" });
		assert.equal(frames[0].code, "bad-request");
		assert.equal(frames[0].queryId, "bad");
		await service.handle({ type: "input-resources", queryId: "io", cwd: "/tmp" });
		assert.equal(frames[1].code, "internal");
		assert.equal(frames[1].queryId, "io");
		assert.ok(!JSON.stringify(frames).includes("/home/user"));
		service.close();
	});

	it("ignores superseded resources and errors but lets the independent completion lane reply", async () => {
		let finish!: (value: InputResources) => void;
		const waiting = new Promise<InputResources>((resolve) => {
			finish = resolve;
		});
		const frames: Record<string, unknown>[] = [];
		let calls = 0;
		const service = createInputAssist(
			{
				inputCwd: async () => "/tmp",
				inputResources: async () => (++calls === 1 ? waiting : emptyResources),
			},
			(frame) => frames.push(frame),
			() => {},
		);
		const first = service.handle({ type: "input-resources", queryId: "old", cwd: "/tmp" });
		await pause();
		await service.handle({ type: "input-completions", queryId: "clear", cwd: "/tmp", token: "" });
		await service.handle({ type: "input-resources", queryId: "new", cwd: "/tmp" });
		finish(emptyResources);
		await first;
		assert.deepEqual(
			frames.map((frame) => frame.queryId),
			["clear", "new"],
		);
		service.close();
	});

	it("times out with a correlated error and discards a later resource reply", async () => {
		let finish!: (value: InputResources) => void;
		const waiting = new Promise<InputResources>((resolve) => {
			finish = resolve;
		});
		const frames: Record<string, unknown>[] = [];
		const service = createInputAssist(
			{ inputCwd: async () => "/tmp", inputResources: async () => waiting },
			(frame) => frames.push(frame),
			() => {},
			{ timeoutMs: 20 },
		);
		const request = service.handle({ type: "input-resources", queryId: "slow", sessionId: "session-slow" });
		await pause(50);
		assert.equal(frames[0]?.code, "input-timeout");
		assert.equal(frames[0]?.queryId, "slow");
		assert.equal(frames[0]?.sessionId, "session-slow");
		finish(emptyResources);
		await request;
		assert.equal(frames.length, 1);
		service.close();
	});

	it("malformed replacement requests do not cancel a valid pending query", async () => {
		let finish!: (value: InputResources) => void;
		const waiting = new Promise<InputResources>((resolve) => {
			finish = resolve;
		});
		const frames: Record<string, unknown>[] = [];
		const service = createInputAssist(
			{ inputCwd: async () => "/tmp", inputResources: async () => waiting },
			(frame) => frames.push(frame),
			() => {},
		);
		const old = service.handle({ type: "input-resources", queryId: "old", cwd: "/tmp" });
		await pause();
		await service.handle({ type: "input-resources", queryId: "bad", cwd: "/tmp", sessionId: "s" });
		finish(emptyResources);
		await old;
		assert.deepEqual(
			frames.map((frame) => [frame.queryId, frame.kind]),
			[
				["bad", "error"],
				["old", "input-resources"],
			],
		);
		service.close();
	});

	it("superseded query errors do not replace the new result", async () => {
		let reject!: (reason: Error) => void;
		const waiting = new Promise<InputResources>((_resolve, fail) => {
			reject = fail;
		});
		let count = 0;
		const frames: Record<string, unknown>[] = [];
		const service = createInputAssist(
			{ inputCwd: async () => "/tmp", inputResources: async () => (++count === 1 ? waiting : emptyResources) },
			(frame) => frames.push(frame),
			() => {},
		);
		const old = service.handle({ type: "input-resources", queryId: "old", cwd: "/tmp" });
		await pause();
		await service.handle({ type: "input-resources", queryId: "new", cwd: "/tmp" });
		reject(new Error("old private failure"));
		await old;
		assert.deepEqual(
			frames.map((frame) => frame.queryId),
			["new"],
		);
		service.close();
	});
});

describe("Pi public @ completion", () => {
	it("preserves quoted directory cursors and file insertion semantics", async (t) => {
		const { cwd, clean } = fixture();
		t.after(clean);
		mkdirSync(join(cwd, "my folder"));
		writeFileSync(join(cwd, "my file.md"), "contents must not be returned");
		writeFileSync(join(cwd, ".hidden.md"), "hidden");
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "secret.md"), "secret");
		const fd = findFd();
		assert.ok(fd, "integration requires an already installed fd; never download during a query");
		const result = await completeAtToken(cwd, "@my", new AbortController().signal, fd);
		const file = result.items.find((item) => item.type === "file");
		const dir = result.items.find((item) => item.type === "directory");
		assert.equal(file?.insertText, '@"my file.md" ');
		assert.equal(file?.cursorOffset, file?.insertText.length);
		assert.equal(dir?.insertText, '@"my folder/"');
		assert.equal(dir?.cursorOffset, (dir?.insertText.length ?? 0) - 1);
		const quoted = await completeAtToken(cwd, '@"my', new AbortController().signal, fd);
		assert.ok(quoted.items.every((item) => item.consumeClosingQuote));
		const all = await completeAtToken(cwd, "@", new AbortController().signal, fd);
		assert.ok(all.items.some((item) => item.path === ".hidden.md"));
		assert.ok(all.items.every((item) => !item.path.startsWith(".git")));
		assert.ok(!JSON.stringify(result).includes("contents must not"));
	});

	it("uses scoped relative, parent and absolute paths and caps suggestions at 20", async (t) => {
		const { root, cwd, clean } = fixture();
		t.after(clean);
		mkdirSync(join(cwd, "docs"));
		writeFileSync(join(cwd, "docs", "guide.md"), "guide");
		writeFileSync(join(root, "parent.md"), "parent");
		const fd = findFd();
		assert.ok(fd);
		for (const [token, expected] of [
			["@docs/gu", "@docs/guide.md "],
			["@../par", "@../parent.md "],
			[`@${cwd}/docs/gu`, `@${cwd}/docs/guide.md `],
		]) {
			const result = await completeAtToken(cwd, token, new AbortController().signal, fd);
			assert.equal(result.prefix, token);
			assert.equal(result.items[0]?.insertText, expected);
		}
		for (let i = 0; i < 25; i++) writeFileSync(join(cwd, `item-${i}.txt`), "x");
		assert.equal((await completeAtToken(cwd, "@item", new AbortController().signal, fd)).items.length, 20);
	});

	it("reports unavailable fd and rejects malformed fragments without executing tools", async () => {
		await assert.rejects(
			completeAtToken("/tmp", "@", new AbortController().signal, undefined),
			(error: unknown) => error instanceof InputAssistError && error.code === "input-unavailable",
		);
		for (const token of ["normal", "@x\ny", `@${"x".repeat(2048)}`]) {
			await assert.rejects(completeAtToken("/tmp", token, new AbortController().signal, findFd()), InputAssistError);
		}
	});

	for (const action of ["replace", "close", "timeout"] as const) {
		it(`cancels the actual fd subprocess on ${action} and never emits its stale result`, async (t) => {
			const { root, cwd, clean } = fixture();
			t.after(clean);
			const pidFile = join(root, "fd.pid");
			const fd = join(root, "slow-fd");
			writeFileSync(
				fd,
				`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(()=>{},1000);\n`,
			);
			chmodSync(fd, 0o700);
			const frames: Record<string, unknown>[] = [];
			const service = createInputAssist(
				{ inputCwd: async () => cwd, inputResources: async () => emptyResources },
				(frame) => frames.push(frame),
				() => {},
				{ fdPath: fd, timeoutMs: action === "timeout" ? 200 : 3000 },
			);
			const pending = service.handle({ type: "input-completions", queryId: "old", cwd, token: "@" });
			for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await pause();
			assert.ok(existsSync(pidFile));
			const pid = Number(readFileSync(pidFile, "utf8"));
			if (action === "replace") await service.handle({ type: "input-completions", queryId: "clear", cwd, token: "" });
			if (action === "close") service.close();
			await pending;
			assert.throws(() => process.kill(pid, 0));
			assert.deepEqual(
				frames.map((frame) => [frame.queryId, frame.kind, frame.code]),
				action === "replace"
					? [["clear", "input-completions", undefined]]
					: action === "timeout"
						? [["old", "error", "input-timeout"]]
						: [],
			);
			service.close();
		});
	}
});

it("isolated SDK discovers previews without installation and expands Skills/Prompt through session.prompt", (t) => {
	const { root, cwd, clean } = fixture();
	t.after(clean);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const module = new URL("../src/input-assist.ts", import.meta.url).href;
	const runtimeModule = new URL("../src/pi-runtime.ts", import.meta.url).href;
	const script = `
		import assert from 'node:assert/strict';
		import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
		import { join } from 'node:path';
		import { previewInputResources, completeAtToken, findFd } from ${JSON.stringify(module)};
		import { PiRuntime } from ${JSON.stringify(runtimeModule)};
		globalThis.fetch = async () => { throw new Error('network is prohibited'); };
		const cwd = process.env.INPUT_ASSIST_TEST_CWD;
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		const make = (path, text) => { mkdirSync(path.slice(0,path.lastIndexOf('/')), {recursive:true}); writeFileSync(path,text); };
		make(join(agentDir,'skills/audit/SKILL.md'), '---\\nname: audit\\ndescription: audit test\\ndisable-model-invocation: true\\n---\\nAUDIT-BODY');
		make(join(agentDir,'prompts/eval.md'), '---\\ndescription: global version\\nargument-hint: "[target]"\\n---\\nEVAL $1 / $ARGUMENTS');
		make(join(cwd,'.pi/prompts/eval.md'), '---\\ndescription: project version\\n---\\nPROJECT $1');
		make(join(cwd,'.pi/prompts/review.md'), 'REVIEW-BODY');
		make(join(cwd,'.pi/skills/hidden/SKILL.md'), '---\\nname: hidden\\ndescription: hidden test\\n---\\nHIDDEN-BODY');
		writeFileSync(join(cwd,'.pi/settings.json'), JSON.stringify({skills:['-skills/hidden']}));
		const settings = {packages:['npm:input-assist-must-never-install'],enableSkillCommands:true};
		writeFileSync(join(agentDir,'settings.json'), JSON.stringify(settings));
		const before = readFileSync(join(agentDir,'settings.json'),'utf8');
		const preview = await previewInputResources(cwd, agentDir);
		assert.equal(preview.complete,false);
		assert.equal(preview.mode,'preview');
		assert.deepEqual(preview.omitted,['packages','extensions']);
		assert.equal(preview.commands.filter(c=>c.name==='eval').length,1);
		assert.equal(preview.commands.find(c=>c.name==='eval').description,'project version');
		assert.ok(!preview.commands.some(c=>c.name==='skill:hidden'));
		assert.ok(preview.commands.some(c=>c.name==='skill:audit' && c.disableModelInvocation));
		assert.ok(!JSON.stringify(preview).includes('AUDIT-BODY'));
		assert.equal(readFileSync(join(agentDir,'settings.json'),'utf8'),before);
		assert.ok(!existsSync(join(agentDir,'npm')));
		writeFileSync(join(agentDir,'settings.json'), JSON.stringify({enableSkillCommands:false, enabledModels:['synthetic/test']}));
		const hiddenPreview = await previewInputResources(cwd,agentDir);
		assert.ok(hiddenPreview.commands.every(c=>c.source!=='skill'));
		writeFileSync(join(agentDir,'models.json'), JSON.stringify({providers:{synthetic:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'synthetic-placeholder',models:[{id:'test',name:'Test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:256}]}}}));
		make(join(cwd,'.pi/extensions/shadow.ts'), 'export default function(pi) { pi.registerCommand("review", {description:"shadow", handler:async()=>{}}); }');
		const runtime = new PiRuntime({agentDir,sessionDir:join(process.env.HOME,'sessions')});
		try {
			const handle = await runtime.createSession(cwd);
			const resources = await runtime.inputResources({sessionId:handle.session.sessionId},cwd);
			assert.ok(resources.complete && resources.mode==='session');
			assert.ok(resources.commands.every(c=>c.source!=='skill' && c.name!=='review'));
			assert.ok(resources.shadowed.some(c=>c.name==='review'));
			const captured=[];
			handle.session.agent.prompt=async messages => { captured.push(...messages.filter(m=>m.role==='user')); };
			await handle.session.prompt('/skill:audit inspect');
			assert.ok(captured[0].content[0].text.includes('AUDIT-BODY'));
			assert.ok(captured[0].content[0].text.includes('inspect'));
			await handle.session.prompt('/eval "two words"');
			assert.ok(captured[1].content[0].text.includes('two words'));
			const prior=captured.length;
			await handle.session.prompt('/review args');
			assert.equal(captured.length,prior);
			let finishRun;
			const blocked = new Promise(resolve => {finishRun=resolve;});
			handle.session.agent.prompt=async()=>blocked;
			const running=handle.session.prompt('/eval running');
			for(let attempt=0;attempt<100 && !handle.session.isStreaming;attempt++) await new Promise(resolve=>setImmediate(resolve));
			assert.ok(handle.session.isStreaming);
			await handle.session.prompt('/eval queued',{streamingBehavior:'followUp'});
			assert.ok(handle.session.getFollowUpMessages()[0].includes('queued'));
			assert.ok(!handle.session.getFollowUpMessages()[0].startsWith('/eval'));
			await handle.session.prompt('/skill:audit queued-skill',{streamingBehavior:'steer'});
			assert.ok(handle.session.getSteeringMessages()[0].includes('AUDIT-BODY'));
			handle.session.clearQueue();
			finishRun();
			await running;
		} finally {runtime.disposeAll();}
		make(join(process.env.HOME,'notes/guide.md'),'home fixture');
		const home = await completeAtToken(cwd,'@~/notes/gu',new AbortController().signal,findFd());
		assert.equal(home.items[0].insertText,'@~/notes/guide.md ');
		console.log('SDK_AND_PREVIEW_PASS');
	`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, INPUT_ASSIST_TEST_CWD: cwd, PI_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(output.trim(), "SDK_AND_PREVIEW_PASS");
});
