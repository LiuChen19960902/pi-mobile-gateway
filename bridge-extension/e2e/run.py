#!/usr/bin/env python3
"""桥接扩展合成验证的外层运行器。

用法（在网关仓库根目录）：
    uv run --no-project python bridge-extension/e2e/run.py [--name attach] [--negative drop-partial|fake-abort]

每次运行创建新的编号目录，冻结被测源码与 SHA256，在 bwrap 的独立 PID/网络/文件系统
视图中启动 tmux + 真实 Pi CLI（合成 Provider/工具），结束后回收自己的 tmux 服务。
"""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNS = HERE / "runs"
SOURCES = {
    "bridge-extension/index.ts": REPO / "bridge-extension/src/index.ts",
    "bridge-extension/workspace.ts": REPO / "bridge-extension/src/workspace.ts",
    "bridge-extension/entries.ts": REPO / "bridge-extension/src/entries.ts",
    "bridge-extension/editor.ts": REPO / "bridge-extension/src/editor.ts",
    "bridge-extension/registry.ts": REPO / "bridge-extension/src/registry.ts",
    "bridge-extension/protocol.ts": REPO / "bridge-extension/src/protocol.ts",
    "fixture.ts": HERE / "fixture.ts",
    "observer.ts": HERE / "observer.ts",
    "foreign-editor.ts": HERE / "foreign-editor.ts",
    "driver.mjs": HERE / "driver.mjs",
}

parser = argparse.ArgumentParser()
parser.add_argument("--name", default="e2e")
parser.add_argument("--negative", choices=["drop-partial", "fake-abort", "drop-tree-draft-protection", "drop-input-expansion", "drop-workspace-draft", "drop-image-body"])
parser.add_argument("--compact", action="store_true")
parser.add_argument("--tree", action="store_true")
parser.add_argument("--input", action="store_true")
parser.add_argument("--workspace", action="store_true")
parser.add_argument("--image", action="store_true")
parser.add_argument("--foreign", action="store_true")
parser.add_argument("--timeout", type=int, default=180)
args = parser.parse_args()

RUNS.mkdir(parents=True, exist_ok=True)
attempt = 1
while (RUNS / f"{args.name}-{attempt}").exists():
    attempt += 1
run = RUNS / f"{args.name}-{attempt}"
src = run / "src"
src.mkdir(parents=True)
(run / "state").mkdir()
for relative, origin in SOURCES.items():
    target = src / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(origin, target)

if args.negative == "drop-image-body":
    path = src / "bridge-extension/index.ts"
    text = path.read_text()
    old = "pi.sendUserMessage(content, { deliverAs: request.deliverAs, expandPromptTemplates });"
    assert text.count(old) == 1
    path.write_text(text.replace(old, 'pi.sendUserMessage(typeof content === "string" ? content : content.filter(block => block.type !== "image"), { deliverAs: request.deliverAs, expandPromptTemplates });'))
elif args.negative == "drop-workspace-draft":
    path = src / "bridge-extension/workspace.ts"
    text = path.read_text()
    old = "const target = SessionManager.forkFrom"
    assert text.count(old) == 1
    path.write_text(text.replace(old, 'ctx.ui.setEditorText("");\n\tconst target = SessionManager.forkFrom'))
elif args.negative == "drop-partial":
    path = src / "bridge-extension/index.ts"
    text = path.read_text()
    old = "\t\t\tpartial,\n\t\t\ttools: [...tools.values()],"
    assert text.count(old) == 1, "negative anchor (partial) not found"
    path.write_text(text.replace(old, "\t\t\tpartial: null,\n\t\t\ttools: [...tools.values()],"))
elif args.negative == "drop-tree-draft-protection":
    path = src / "bridge-extension/index.ts"
    text = path.read_text()
    old = "own.restoreNavigationFill(before, editorText);"
    assert text.count(old) == 1, "negative anchor (tree draft) not found"
    path.write_text(text.replace(old, "void before;"))
elif args.negative == "drop-input-expansion":
    path = src / "bridge-extension/index.ts"
    text = path.read_text()
    old = "pi.sendUserMessage(content, { deliverAs: request.deliverAs, expandPromptTemplates });"
    assert text.count(old) == 1, "negative anchor (input expansion) not found"
    path.write_text(text.replace(old, "pi.sendUserMessage(content, { deliverAs: request.deliverAs, expandPromptTemplates: false });"))
elif args.negative == "fake-abort":
    path = src / "bridge-extension/index.ts"
    text = path.read_text()
    old = "const abortResult = stopContext?.abort();"
    assert text.count(old) == 1, "negative anchor (abort) not found"
    path.write_text(text.replace(old, "const abortResult = undefined; /* negative: acknowledge without aborting */"))

files = sorted(p for p in src.rglob("*") if p.is_file())
hashes = {str(p.relative_to(src)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
(run / "source-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")

node_root = Path(shutil.which("node") or sys.exit("node not found")).resolve().parent.parent
cmd = [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind",
    "/etc/group",
    "/etc/group",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--ro-bind",
    str(node_root),
    "/runtime",
    "--bind",
    str(run),
    "/work",
    "--ro-bind",
    str(REPO / "node_modules"),
    "/work/node_modules",
    "--setenv",
    "PATH",
    "/runtime/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "TERM",
    "xterm-256color",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "HOME",
    "/work/state/home",
    "--setenv",
    "PI_CODING_AGENT_DIR",
    "/work/state/agent",
    "--setenv",
    "PI_MOBILE_BRIDGE_ROOT",
    "/work/state/bridge",
    "--setenv",
    "PI_OFFLINE",
    "1",
    "--setenv",
    "PI_SKIP_VERSION_CHECK",
    "1",
    "--setenv",
    "E2E_ROOT",
    "/work/state",
    "--setenv",
    "E2E_IMAGE",
    "1" if args.image else "0",
    "--setenv",
    "E2E_WORKSPACE",
    "1" if args.workspace else "0",
    "--setenv",
    "E2E_INPUT",
    "1" if args.input else "0",
    "--setenv",
    "E2E_TREE",
    "1" if args.tree else "0",
    "--setenv",
    "E2E_COMPACT",
    "1" if args.compact else "0",
    "--setenv",
    "E2E_FOREIGN",
    "1" if args.foreign else "0",
    "--setenv",
    "E2E_OBSERVE_FILE",
    "/work/state/observe.json",
    "--chdir",
    "/work",
    "--",
    "/runtime/bin/node",
    "/work/src/driver.mjs",
]
started = time.monotonic()
process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
try:
    output, _ = process.communicate(timeout=args.timeout)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    output, _ = process.communicate(timeout=10)
elapsed = round(time.monotonic() - started, 2)
(run / "run.log").write_text(output)

registry = run / "state/bridge/registry"
leftovers = sorted(p.name for p in registry.glob("*.json")) if registry.exists() else []
meta = {
    "rc": process.returncode,
    "seconds": elapsed,
    "negative": args.negative,
    "hostHomeMounted": False,
    "externalNetwork": False,
    "sourceSha256": hashes,
    "exited": process.poll() is not None,
    "registryLeftovers": leftovers,
}
(run / "run-meta.json").write_text(json.dumps(meta, indent=2) + "\n")
print("\n".join(output.splitlines()[-60:]))
print(json.dumps({"run": str(run), **meta}))
raise SystemExit(process.returncode)
