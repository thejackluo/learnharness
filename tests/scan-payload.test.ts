import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanPayload } from "../scripts/scan-payload.mjs";

test("payload scanner rejects private filenames, learner records, lock files, and sentinels", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "lh-payload-scan-"));
	try {
		mkdirSync(path.join(root, "data", "chats"), { recursive: true });
		mkdirSync(path.join(root, "secrets"), { recursive: true });
		writeFileSync(path.join(root, "data", "chats", "one.json"), "{}");
		writeFileSync(path.join(root, "secrets", "owner.json"), "{}");
		writeFileSync(path.join(root, "secrets", "chatgpt-credentials.json"), "synthetic");
		writeFileSync(path.join(root, ".env.local"), "x");
		writeFileSync(path.join(root, ".lh-writer.sock"), "");
		writeFileSync(path.join(root, "bundle.js"), "left-SENTINEL-right");
		const issues = await scanPayload(root, ["SENTINEL"]);
		assert.equal(issues.length, 6);
		assert(issues.some((issue) => issue.includes("data/chats")));
		assert(issues.some((issue) => issue.includes("owner.json")));
		assert(issues.some((issue) => issue.includes("SENTINEL")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("payload scanner accepts clean trees and sentinels split across read chunks", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "lh-payload-scan-"));
	try {
		writeFileSync(path.join(root, "asset.js"), `${"a".repeat(64 * 1024)}SPLIT-SENTINEL`);
		assert.deepEqual(await scanPayload(root), []);
		assert.equal((await scanPayload(root, ["SPLIT-SENTINEL"])).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
