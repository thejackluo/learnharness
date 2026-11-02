import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	createOwnerAuth,
	makeOwnerVerifier,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	SESSION_TOUCH_INTERVAL_MS,
} from "../src/server/owner-auth.ts";
import { createOwnerStore } from "../src/store/owner.ts";

function tempOwnerStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-owner-auth-"));
	return { dir, store: createOwnerStore(dir) };
}

describe("owner authentication", () => {
	it("verifies passphrases and persists only hashed opaque sessions with private file modes", async () => {
		const { dir, store } = tempOwnerStore();
		try {
			await store.writeOwner(await makeOwnerVerifier("synthetic passphrase"));
			const auth = createOwnerAuth({ store });
			assert.equal(await auth.verifyPassphrase("synthetic passphrase"), true);
			assert.equal(await auth.verifyPassphrase("wrong synthetic passphrase"), false);
			const { id, token } = auth.createSession();
			const disk = fs.readFileSync(path.join(dir, "sessions.json"), "utf8");
			assert(!disk.includes(token));
			assert(disk.includes(id));
			assert.equal(fs.statSync(path.join(dir, "owner.json")).mode & 0o777, 0o600);
			assert.equal(fs.statSync(path.join(dir, "sessions.json")).mode & 0o777, 0o600);
			assert.equal(auth.validateSession(token)?.id, id);
			assert.equal(auth.validateSession(`${token}tampered`), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("expires idle and absolute sessions and throttles last-seen writes", async () => {
		const { dir, store } = tempOwnerStore();
		let now = 10_000;
		try {
			await store.writeOwner(await makeOwnerVerifier("synthetic passphrase"));
			const auth = createOwnerAuth({ store, now: () => now });
			const { token } = auth.createSession();
			now += SESSION_TOUCH_INTERVAL_MS - 1;
			assert.equal(auth.validateSession(token, { touch: true })?.lastSeenAt, 10_000);
			now++;
			assert.equal(auth.validateSession(token, { touch: true })?.lastSeenAt, now);
			now += SESSION_IDLE_MS + 1;
			assert.equal(auth.validateSession(token), null);

			now = 50_000;
			const absolute = auth.createSession();
			now += SESSION_ABSOLUTE_MS + 1;
			assert.equal(auth.validateSession(absolute.token), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("revokes a session and invalidates sessions after verifier rotation", async () => {
		const { dir, store } = tempOwnerStore();
		try {
			const first = await makeOwnerVerifier("synthetic passphrase", "revision-one");
			await store.writeOwner(first);
			const auth = createOwnerAuth({ store });
			const revoked = auth.createSession();
			auth.revokeSession(revoked.id);
			assert.equal(auth.validateSession(revoked.token), null);
			const rotated = auth.createSession();
			await store.writeOwner(await makeOwnerVerifier("rotated synthetic passphrase", "revision-two"));
			assert.equal(auth.validateSession(rotated.token), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the interoperable verifier format written by the passphrase CLI", async () => {
		const { dir, store } = tempOwnerStore();
		const script = path.resolve("scripts/owner-passphrase.mjs");
		try {
			execFileSync(process.execPath, [script, "--dir", dir], { input: "synthetic cli passphrase\n" });
			const auth = createOwnerAuth({ store });
			assert.equal(await auth.verifyPassphrase("synthetic cli passphrase"), true);
			assert.deepEqual(store.readSessions(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
