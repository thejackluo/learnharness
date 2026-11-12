import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../config.ts";
import { CAPABILITY_REASONS, capabilitiesFor, resolveRuntimeMode } from "../src/core/runtime.ts";
import { validateHostedRuntime } from "../src/server/runtime.ts";
import { createOwnerStore } from "../src/store/owner.ts";

function ownerVerifier() {
	return {
		version: 1 as const,
		revision: "test-revision",
		scrypt: { N: 2 ** 15, r: 8, p: 1, keyLen: 32 },
		salt: Buffer.alloc(16).toString("base64"),
		hash: Buffer.alloc(32).toString("base64"),
	};
}

describe("runtime mode", () => {
	it("resolves desktop before local and fails closed on ambiguous or invalid configuration", () => {
		assert.deepEqual(resolveRuntimeMode({}), { mode: "local" });
		assert.deepEqual(resolveRuntimeMode({ LH_RUNTIME: "local" }), { mode: "local" });
		assert.deepEqual(resolveRuntimeMode({ LH_DESKTOP_SERVER: "1" }), { mode: "desktop" });
		assert.deepEqual(resolveRuntimeMode({ LH_DESKTOP_API_SECRET: "secret" }), { mode: "desktop" });
		assert.deepEqual(resolveRuntimeMode({ LH_RUNTIME: "hosted" }), { mode: "hosted" });
		assert("error" in resolveRuntimeMode({ LH_RUNTIME: "staging" }));
		assert("error" in resolveRuntimeMode({ LH_RUNTIME: "hosted", LH_DESKTOP_SERVER: "1" }));
		assert("error" in resolveRuntimeMode({ LH_RUNTIME: "hosted", LH_DESKTOP_API_SECRET: "secret" }));
	});

	it("keeps hosted ChatGPT subscription access separate from native subscription providers", () => {
		assert.deepEqual(Object.values(capabilitiesFor("hosted")), [false, false, false, false, false, false, true]);
		assert.deepEqual(Object.values(capabilitiesFor("local")), [true, true, true, true, true, true, true]);
		assert.equal(capabilitiesFor("hosted").subscriptions, false);
		assert.equal(capabilitiesFor("hosted").chatgptSubscription, true);
		assert.equal(capabilitiesFor("local").subscriptions, true);
		assert.equal(capabilitiesFor("local").chatgptSubscription, true);
		assert.equal(CAPABILITY_REASONS.subscriptions, "Hosted mode cannot connect this subscription.");
		assert.equal(CAPABILITY_REASONS.chatgptSubscription, "Hosted mode cannot connect this subscription.");
		assert(Object.isFrozen(capabilitiesFor("hosted")));
		assert(Object.isFrozen(capabilitiesFor("desktop")));
	});

	it("rejects missing, relative, nested, app-root, and noncanonical hosted configuration", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "lh-runtime-"));
		const data = path.join(base, "data");
		const owner = path.join(base, "owner");
		const keys = path.join(base, "keys");
		fs.mkdirSync(data);
		fs.mkdirSync(owner);
		fs.mkdirSync(keys);
		createOwnerStore(owner).writeOwner(ownerVerifier());
		const valid = {
			LH_RUNTIME: "hosted",
			LH_PUBLIC_ORIGIN: "https://lh.invalid",
			LH_DATA_DIR: data,
			LH_AUTH_FILE: path.join(keys, "auth.json"),
			LH_OWNER_DIR: owner,
		};
		try {
			assert.deepEqual(validateHostedRuntime(valid), []);
			assert(validateHostedRuntime({ ...valid, LH_PUBLIC_ORIGIN: "http://lh.invalid" }).some((p) => p.includes("LH_PUBLIC_ORIGIN")));
			assert(validateHostedRuntime({ ...valid, LH_PUBLIC_ORIGIN: "https://lh.invalid/path" }).some((p) => p.includes("LH_PUBLIC_ORIGIN")));
			assert(validateHostedRuntime({ ...valid, LH_DATA_DIR: "relative-data" }).some((p) => p.includes("LH_DATA_DIR")));
			assert(validateHostedRuntime({ ...valid, LH_OWNER_DIR: path.join(data, "owner") }).some((p) => p.includes("nested")));
			assert(validateHostedRuntime({ ...valid, LH_DATA_DIR: ROOT }).some((p) => p.includes("application directory")));
			assert(validateHostedRuntime({ ...valid, LH_OWNER_DIR: path.join(base, "missing-owner") }).some((p) => p.includes("owner.json")));
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
