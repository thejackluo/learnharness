import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { acquireWriterLock } from "../src/server/writer-lock.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

describe("hosted writer lock", () => {
	it("rejects a second same-process lock and releases cleanly", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-writer-lock-"));
		const lock = await acquireWriterLock(dir);
		try {
			await assert.rejects(acquireWriterLock(dir), /This LearnHarness process already holds the writer lock/);
		} finally {
			await lock.release();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("synchronously releases only its own lock for process-exit cleanup", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-writer-exit-"));
		const lock = await acquireWriterLock(dir);
		try {
			lock.releaseSync();
			assert.equal(fs.existsSync(path.join(dir, ".lh-writer.sock")), false);
			const replacement = await acquireWriterLock(dir);
			await replacement.release();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a live writer lock held by a separate process", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-writer-live-"));
		const source = `import { acquireWriterLock } from ${JSON.stringify(path.join(REPO_ROOT, "src/server/writer-lock.ts"))}; await acquireWriterLock(${JSON.stringify(dir)}); console.log("LOCK_READY"); setInterval(() => {}, 1000);`;
		const child = spawn(process.execPath, ["--import", TSX_LOADER, "--eval", source], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				let output = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					output += chunk;
					if (output.includes("LOCK_READY")) resolve();
				});
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`lock child exited before ready (${code})`)));
			});
			await assert.rejects(acquireWriterLock(dir), /Another LearnHarness process holds this data directory/);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recovers a stale socket after the lock holder is killed", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-writer-kill-"));
		const source = `import { acquireWriterLock } from ${JSON.stringify(path.join(REPO_ROOT, "src/server/writer-lock.ts"))}; await acquireWriterLock(${JSON.stringify(dir)}); console.log("LOCK_READY"); setInterval(() => {}, 1000);`;
		const child = spawn(process.execPath, ["--import", TSX_LOADER, "--eval", source], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				let output = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					output += chunk;
					if (output.includes("LOCK_READY")) resolve();
				});
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`lock child exited before ready (${code})`)));
			});
			child.kill("SIGKILL");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			const lock = await acquireWriterLock(dir);
			await lock.release();
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
