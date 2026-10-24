// 宿主连接模式：sdk（网关自建 AgentSession）或 bridge（连接原生 Pi 实例）。
// 按宿主持久化；切换不 Fork、不搬历史，只决定 live 操作路由到哪个执行入口。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HostMode = "sdk" | "bridge";

export class HostModeStore {
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	read(): HostMode {
		try {
			const value = JSON.parse(readFileSync(this.file, "utf8")) as { mode?: unknown };
			return value.mode === "bridge" ? "bridge" : "sdk";
		} catch {
			return "sdk";
		}
	}

	write(mode: HostMode): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
		renameSync(tmp, this.file);
	}
}
