import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime, type PiSessionLike } from "../src/pi-runtime.ts";
import { createWorktree, listWorktrees, WorktreeOperations } from "../src/worktrees.ts";

const roots: string[] = [];
after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function root() {
	const p = mkdtempSync(join(tmpdir(), "mobile-worktree-test-"));
	roots.push(p);
	return p;
}
function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function repo() {
	const p = root();
	git(p, "init", "-b", "release/test");
	writeFileSync(join(p, "README.md"), "synthetic");
	git(p, "add", "README.md");
	git(p, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "seed");
	return p;
}
function fake(manager: SessionManager): PiSessionLike {
	const ctx = manager.buildSessionContext();
	return {
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		isStreaming: false,
		isCompacting: false,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.modelId } : undefined,
		thinkingLevel: ctx.thinkingLevel,
		subscribe: () => () => {},
		dispose: () => {},
		prompt: async () => {},
		abort: async () => {},
		clearQueue: () => ({ steering: [], followUp: [] }),
		setModel: async () => {},
		setThinkingLevel: () => {},
		setSessionName: () => {},
		compact: async () => {},
		navigateTree: async () => ({}),
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getContextUsage: () => undefined,
	};
}
test("Git discovers external worktrees, detached HEAD and dirty state", async () => {
	const p = repo();
	const target = join(root(), "same name");
	await createWorktree(p, "fix/example", "HEAD", target);
	const detached = join(root(), "detached");
	git(p, "worktree", "add", "--detach", detached, "HEAD");
	writeFileSync(join(p, "pending.txt"), "uncommitted");
	const rows = await listWorktrees(p);
	assert.equal(rows.worktrees.length, 3);
	assert.equal(rows.worktrees[0].main, true);
	assert.equal(rows.worktrees[0].branch, "release/test");
	assert.equal(rows.dirty, true);
	assert.equal(rows.worktrees.find((x) => x.path === detached)?.branch, null);
	assert.equal((await listWorktrees(root())).repoRoot, null);
	assert.equal(readFileSync(join(p, "pending.txt"), "utf8"), "uncommitted");
	await assert.rejects(createWorktree(p, "-bad", "HEAD", join(root(), "bad")), { code: "worktree-branch-invalid" });
	await assert.rejects(createWorktree(p, "fix/base", "--bad", join(root(), "bad")), { code: "worktree-base-invalid" });
	await assert.rejects(createWorktree(p, "fix/again", "HEAD", target), { code: "worktree-path-exists" });
});

test("an empty repository reports missing history and can create after its first commit", async () => {
	const p = root(),
		target = join(root(), "new-worktree");
	git(p, "init", "-b", "main");
	writeFileSync(join(p, "untracked.txt"), "keep this uncommitted");
	await assert.rejects(createWorktree(p, "fix/first", "HEAD", target), { code: "worktree-no-commits" });
	assert.equal((await listWorktrees(p)).worktrees.length, 1);
	assert.equal(git(p, "branch", "--list", "fix/first"), "");
	git(
		p,
		"-c",
		"user.name=Synthetic",
		"-c",
		"user.email=synthetic@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		"seed",
	);
	const result = await createWorktree(p, "fix/first", "HEAD", target);
	assert.equal(result.path, target);
	assert.equal(result.branch, "fix/first");
	assert.equal(readFileSync(join(p, "untracked.txt"), "utf8"), "keep this uncommitted");
	assert.equal(existsSync(join(target, "untracked.txt")), false);
	await assert.rejects(createWorktree(p, "fix/invalid", "not-a-real-ref", join(root(), "invalid")), {
		code: "worktree-base-invalid",
	});
});
test("continuation keeps complete tree, label and selected branch after reopen; source bytes unchanged", async () => {
	const p = repo(),
		state = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const manager = SessionManager.create(p, sessionDir);
	manager.appendModelChange("fixture", "model");
	manager.appendThinkingLevelChange("medium");
	const first = manager.appendMessage({ role: "user", content: "keep this branch", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "openai-completions",
		provider: "fixture",
		model: "model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const late = manager.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
	manager.appendLabelChange(first, "bookmark");
	const managers = new Map<string, SessionManager>();
	const runtime = new PiRuntime({
		sessionDir,
		agentDir: join(state, "agent"),
		sessionFactory: async ({ sessionManager }) => {
			managers.set(sessionManager.getSessionId(), sessionManager);
			return fake(sessionManager);
		},
	});
	try {
		const h = await runtime.openSession(manager.getSessionId());
		managers.get(h.session.sessionId)!.branch(first);
		const before = readFileSync(manager.getSessionFile()!, "utf8"),
			id = randomUUID();
		const result = await runtime.continueWorkspace(id, h.session.sessionId, target);
		assert.equal(result.status, "succeeded");
		assert.equal(result.targetSessionId, id);
		const opened = SessionManager.open(SessionManager.findById(target, id, sessionDir)!, sessionDir);
		assert.equal(opened.getCwd(), target);
		assert.equal(opened.getLabel(first), "bookmark");
		assert.ok(opened.getEntry(late));
		assert.ok(opened.getBranch().some((e) => e.id === first));
		assert.ok(!opened.getBranch().some((e) => e.id === late));
		assert.deepEqual(opened.buildSessionContext().model, { provider: "fixture", modelId: "model" });
		assert.equal(opened.buildSessionContext().thinkingLevel, "medium");
		assert.equal(readFileSync(manager.getSessionFile()!, "utf8"), before);
		assert.deepEqual(await runtime.continueWorkspace(id, h.session.sessionId, target), result);
		assert.equal((await runtime.listSessions()).filter((s) => s.id === id).length, 1);
		h.session.isStreaming = true;
		assert.equal((await runtime.continueWorkspace(randomUUID(), h.session.sessionId, target)).code, "worktree-busy");
		h.session.isStreaming = false;
		h.session.getFollowUpMessages = () => ["pending"];
		assert.equal((await runtime.continueWorkspace(randomUUID(), h.session.sessionId, target)).code, "worktree-queued");
	} finally {
		runtime.disposeAll();
	}
});
test("operation journal deduplicates concurrent writes and retains terminal results across restart", async () => {
	const p = root(),
		id = randomUUID();
	let n = 0;
	const ops = new WorktreeOperations(p),
		initial = { operationId: id, action: "create" as const, status: "pending" as const };
	const work = async () => {
		n++;
		await new Promise((r) => setTimeout(r, 20));
		return { ...initial, status: "succeeded" as const };
	};
	const [a, b] = await Promise.all([ops.run(id, "same", initial, work), ops.run(id, "same", initial, work)]);
	assert.deepEqual(a, b);
	assert.equal(n, 1);
	assert.equal(new WorktreeOperations(p).status(id).status, "succeeded");
	await assert.rejects(ops.run(id, "different", initial, work), { code: "worktree-operation-conflict" });
});

test("retry keeps its durable checkpoint while asynchronous startup is pending", async () => {
	const p = root(),
		id = randomUUID(),
		ops = new WorktreeOperations(p);
	const initial = {
		operationId: id,
		action: "continue" as const,
		status: "pending" as const,
		cwd: "/synthetic/target",
	};
	await ops.run(id, "same", initial, async () => {
		ops.checkpoint(id, { targetSessionId: id });
		throw new Error("synthetic startup failure");
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const retry = ops.run(
		id,
		"same",
		initial,
		async () => {
			await gate;
			return { ...initial, targetSessionId: id, status: "succeeded" as const };
		},
		true,
	);
	try {
		const restarted = new WorktreeOperations(p).status(id);
		assert.equal(restarted.status, "unknown");
		assert.equal(restarted.targetSessionId, id);
	} finally {
		release();
		await retry;
	}
});

test("failed target startup retries the same fork instead of generating copies", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const manager = SessionManager.create(source, sessionDir);
	manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "saved" }],
		api: "openai-completions",
		provider: "fixture",
		model: "model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	let fail = true;
	const runtime = new PiRuntime({
		sessionDir,
		agentDir: join(state, "agent"),
		sessionFactory: async ({ sessionManager }) => {
			if (sessionManager.getCwd() === target && fail) throw new Error("synthetic startup failure");
			return fake(sessionManager);
		},
	});
	try {
		const id = randomUUID();
		const first = await runtime.continueWorkspace(id, manager.getSessionId(), target);
		assert.equal(first.status, "failed");
		assert.equal(first.targetSessionId, id);
		const targetFile = SessionManager.findById(target, id, sessionDir)!;
		const beforeRetry = readFileSync(targetFile, "utf8");
		fail = false;
		const retry = await runtime.continueWorkspace(id, manager.getSessionId(), target, false, true);
		assert.equal(retry.status, "succeeded");
		assert.equal(retry.targetSessionId, id);
		assert.equal((await runtime.listSessions()).filter((s) => s.id === id).length, 1);
		assert.equal(readFileSync(targetFile, "utf8"), beforeRetry);
	} finally {
		runtime.disposeAll();
	}
});

test("source mutations are rejected while a continuation initializes its target", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const manager = SessionManager.create(source, sessionDir);
	const entry = manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "flush synthetic session", timestamp: 2 });
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const targetStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let clock = 0;
	const runtime = new PiRuntime({
		sessionDir,
		agentDir: join(state, "agent"),
		idleDisposeMs: 1,
		now: () => clock,
		sessionFactory: async ({ sessionManager }) => {
			if (sessionManager.getCwd() === target) {
				started();
				await gate;
			}
			return fake(sessionManager);
		},
	});
	try {
		const pending = runtime.continueWorkspace(randomUUID(), manager.getSessionId(), target);
		await targetStarted;
		clock = 10_000;
		runtime.sweep();
		assert.ok(runtime.peekSession(manager.getSessionId()));
		await assert.rejects(runtime.restartSession(manager.getSessionId()), { code: "worktree-busy" });
		await assert.rejects(runtime.setSessionName(manager.getSessionId(), "blocked"), { code: "worktree-busy" });
		await assert.rejects(runtime.putLabel(manager.getSessionId(), entry, "blocked"), { code: "worktree-busy" });
		release();
		assert.equal((await pending).status, "succeeded");
	} finally {
		release();
		runtime.disposeAll();
	}
});

test("an existing session with the requested UUID is never adopted or rewritten", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const manager = SessionManager.create(source, sessionDir);
	manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "flush synthetic session", timestamp: 2 });
	const id = randomUUID();
	const collision = SessionManager.forkFrom(manager.getSessionFile()!, target, sessionDir, { id });
	const file = collision.getSessionFile()!;
	const before = readFileSync(file, "utf8");
	const runtime = new PiRuntime({
		sessionDir,
		agentDir: join(state, "agent"),
		sessionFactory: async ({ sessionManager }) => fake(sessionManager),
	});
	try {
		const result = await runtime.continueWorkspace(id, manager.getSessionId(), target);
		assert.equal(result.code, "worktree-operation-conflict");
		assert.equal(readFileSync(file, "utf8"), before);
	} finally {
		runtime.disposeAll();
	}
});

test("a tree navigation already waiting in the SDK prevents continuation", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const manager = SessionManager.create(source, sessionDir);
	const first = manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((r) => {
			release = r;
		}),
		entered = new Promise<void>((r) => {
			started = r;
		});
	const runtime = new PiRuntime({
		sessionDir,
		agentDir: join(state, "agent"),
		sessionFactory: async ({ sessionManager }) => ({
			...fake(sessionManager),
			navigateTree: async () => {
				started();
				await gate;
				sessionManager.branch(first);
				return {};
			},
		}),
	});
	try {
		await runtime.openSession(manager.getSessionId());
		const navigation = runtime.switchBranch(manager.getSessionId(), first);
		await entered;
		assert.equal((await runtime.continueWorkspace(randomUUID(), manager.getSessionId(), target)).code, "worktree-busy");
		release();
		await navigation;
		assert.equal((await runtime.continueWorkspace(randomUUID(), manager.getSessionId(), target)).status, "succeeded");
	} finally {
		release();
		runtime.disposeAll();
	}
});

test("restart recovery refuses thinking downgrade and recovers only the unchanged model state", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions"),
		agentDir = join(state, "agent");
	const manager = SessionManager.create(source, sessionDir);
	manager.appendModelChange("fixture", "model");
	manager.appendThinkingLevelChange("medium");
	manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "flush synthetic session", timestamp: 2 });
	const id = randomUUID();
	const options = {
		sessionDir,
		agentDir,
		sessionFactory: async ({ sessionManager }: { sessionManager: SessionManager }) => fake(sessionManager),
	};
	const first = new PiRuntime(options);
	assert.equal((await first.continueWorkspace(id, manager.getSessionId(), target)).status, "succeeded");
	first.disposeAll();
	const journal = join(agentDir, "mobile-worktree-operations", id + ".json");
	const saved = JSON.parse(readFileSync(journal, "utf8"));
	saved.result.status = "pending";
	writeFileSync(journal, JSON.stringify(saved));
	const downgraded = new PiRuntime({
		...options,
		sessionFactory: async ({ sessionManager }) => ({ ...fake(sessionManager), thinkingLevel: "off" }),
	});
	try {
		assert.equal((await downgraded.worktreeStatus(id)).status, "unknown");
	} finally {
		downgraded.disposeAll();
	}
	const recovered = new PiRuntime(options);
	try {
		assert.equal((await recovered.worktreeStatus(id)).status, "succeeded");
	} finally {
		recovered.disposeAll();
	}
	// 用户已经自行打开目标并改了临时档位时，旧操作查询不能dispose其活跃运行器。
	saved.result.status = "pending";
	writeFileSync(journal, JSON.stringify(saved));
	const activeRuntime = new PiRuntime(options);
	try {
		const handle = await activeRuntime.openSession(id);
		let disposed = false;
		handle.session.dispose = () => {
			disposed = true;
		};
		handle.session.thinkingLevel = "off";
		handle.session.isStreaming = true;
		assert.equal((await activeRuntime.worktreeStatus(id)).status, "unknown");
		assert.equal(activeRuntime.peekSession(id), handle.session);
		assert.equal(disposed, false);
		handle.session.isStreaming = false;
	} finally {
		activeRuntime.disposeAll();
	}
});

test("project resources require explicit trust and trust is recorded only for the target", async () => {
	const state = root(),
		source = root(),
		target = root(),
		sessionDir = join(state, "sessions");
	const { mkdirSync } = await import("node:fs");
	const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
	mkdirSync(join(target, ".pi"));
	writeFileSync(join(target, ".pi", "settings.json"), "{}");
	const manager = SessionManager.create(source, sessionDir);
	manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "saved" }],
		api: "openai-completions",
		provider: "fixture",
		model: "model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const agentDir = join(state, "agent");
	const runtime = new PiRuntime({
		sessionDir,
		agentDir,
		sessionFactory: async ({ sessionManager }) => fake(sessionManager),
	});
	try {
		const id = randomUUID();
		await assert.rejects(runtime.continueWorkspace(id, manager.getSessionId(), target), {
			code: "worktree-trust-required",
		});
		assert.equal((await runtime.listSessions()).length, 1);
		assert.equal((await runtime.continueWorkspace(id, manager.getSessionId(), target, true)).status, "succeeded");
		const trust = new ProjectTrustStore(agentDir);
		assert.equal(trust.get(target), true);
		assert.equal(trust.get(source), null);
	} finally {
		runtime.disposeAll();
	}
});

test("real SDK reloads target resources and built-in read tool executes in target cwd", () => {
	const p = root();
	const runtimeUrl = new URL("../src/pi-runtime.ts", import.meta.url).href;
	const sdkUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
	const script = `
  import assert from 'node:assert/strict';
  import {mkdirSync,writeFileSync} from 'node:fs';
  import {join} from 'node:path';
  import {randomUUID} from 'node:crypto';
  import {SessionManager} from ${JSON.stringify(sdkUrl)};
  import {PiRuntime} from ${JSON.stringify(runtimeUrl)};
  globalThis.fetch=async()=>{throw new Error('network disabled in synthetic test')};
  const root=process.cwd(),agent=process.env.PI_CODING_AGENT_DIR;
  const source=join(root,'source'),target=join(root,'target'),sessions=join(root,'sessions');
  mkdirSync(agent,{recursive:true});
  writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'synthetic',models:[{id:'fixture-model',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:128}]}}}));
  writeFileSync(join(agent,'settings.json'),JSON.stringify({enabledModels:['fixture/fixture-model'],defaultProvider:'fixture',defaultModel:'fixture-model'}));
  for(const [cwd,name] of [[source,'source-only'],[target,'target-only']]){
   mkdirSync(join(cwd,'.agents','skills',name),{recursive:true});
   writeFileSync(join(cwd,'.agents','skills',name,'SKILL.md'),'---\\nname: '+name+'\\ndescription: Synthetic resource\\n---\\nOnly this cwd');
   writeFileSync(join(cwd,'AGENTS.md'),name+' synthetic instructions');
   writeFileSync(join(cwd,'marker.txt'),name+' marker');
  }
  const manager=SessionManager.create(source,sessions);
  manager.appendModelChange('fixture','fixture-model');manager.appendThinkingLevelChange('off');
  manager.appendMessage({role:'user',content:'synthetic saved question',timestamp:1});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'synthetic saved answer'}],api:'openai-completions',provider:'fixture',model:'fixture-model',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:2});
  const runtime=new PiRuntime({agentDir:agent,sessionDir:sessions});
  try{
   const result=await runtime.continueWorkspace(randomUUID(),manager.getSessionId(),target,true);
   assert.equal(result.status,'succeeded',JSON.stringify(result));
   const session=runtime.peekSession(result.targetSessionId);
   const skills=session.resourceLoader.getSkills().skills.map(x=>x.name);
   assert.ok(skills.includes('target-only'),JSON.stringify(skills));assert.ok(!skills.includes('source-only'));
   const contextFiles=JSON.stringify(session.resourceLoader.getAgentsFiles().agentsFiles);
   assert.ok(contextFiles.includes('target-only synthetic instructions'));
   assert.ok(!contextFiles.includes('source-only synthetic instructions'));
   const read=session.agent.state.tools.find(x=>x.name==='read');assert.ok(read);
   const output=await read.execute('synthetic-call',{path:'marker.txt'},new AbortController().signal);
   assert.ok(JSON.stringify(output).includes('target-only marker'));assert.ok(!JSON.stringify(output).includes('source-only marker'));
   console.log('REAL_SDK_TARGET_RESOURCES_AND_TOOL_CWD_PASS');
  }finally{runtime.disposeAll()}
 `;
	const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
		cwd: p,
		encoding: "utf8",
		timeout: 45_000,
		env: { ...process.env, HOME: p, PI_CODING_AGENT_DIR: join(p, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	});
	assert.ok(out.includes("REAL_SDK_TARGET_RESOURCES_AND_TOOL_CWD_PASS"));
});
