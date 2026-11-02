import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "lh-stt-route-"));
const ownerDirectory = path.join(root, "owner");
const dataDirectory = path.join(root, "data");
const authFile = path.join(root, "missing-auth.json");
mkdirSync(ownerDirectory);
mkdirSync(dataDirectory);
const previousEnvironment = {
	LH_RUNTIME: process.env.LH_RUNTIME,
	LH_OWNER_DIR: process.env.LH_OWNER_DIR,
	LH_DATA_DIR: process.env.LH_DATA_DIR,
	LH_AUTH_FILE: process.env.LH_AUTH_FILE,
	LH_PUBLIC_ORIGIN: process.env.LH_PUBLIC_ORIGIN,
	DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
};
process.env.LH_RUNTIME = "hosted";
process.env.LH_OWNER_DIR = ownerDirectory;
process.env.LH_DATA_DIR = dataDirectory;
process.env.LH_AUTH_FILE = authFile;
process.env.LH_PUBLIC_ORIGIN = "https://lh.invalid";
delete process.env.DEEPGRAM_API_KEY;

const [{ GET, POST }, { OWNER_SESSION_COOKIE, createOwnerSession, makeOwnerVerifier }, { ownerStore }] = await Promise.all([
	import("../app/api/stt/token/route.ts"),
	import("../src/server/owner-auth.ts"),
	import("../src/store/owner.ts"),
]);
await ownerStore.writeOwner(await makeOwnerVerifier("synthetic owner passphrase"));

after(() => {
	rmSync(root, { recursive: true, force: true });
	for (const [name, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("STT token route is POST-only, same-origin, and never cacheable", async () => {
	const get = GET();
	assert.equal(get.status, 405);
	assert.equal(get.headers.get("Allow"), "POST");
	assert.equal(get.headers.get("Cache-Control"), "no-store");

	const crossOrigin = await POST(new Request("https://lh.invalid/api/stt/token", {
		method: "POST",
		headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" },
		body: "{}",
	}));
	assert.equal(crossOrigin.status, 403);
	assert.equal(crossOrigin.headers.get("Cache-Control"), "no-store");

	const sameOrigin = await POST(new Request("https://lh.invalid/api/stt/token", {
		method: "POST",
		headers: {
			Origin: "https://lh.invalid",
			"Sec-Fetch-Site": "same-origin",
		},
		body: "{}",
	}));
	assert.equal(sameOrigin.status, 401);
	assert.equal(sameOrigin.headers.get("Cache-Control"), "no-store");
});

test("hosted STT token mint limit is shared across owner sessions", async () => {
	assert.equal(process.env.DEEPGRAM_API_KEY, undefined);
	const sessionA = createOwnerSession();
	const request = (token: string) => POST(new Request("https://lh.invalid/api/stt/token", {
		method: "POST",
		headers: {
			Origin: "https://lh.invalid",
			cookie: `${OWNER_SESSION_COOKIE}=${token}`,
		},
		body: "{}",
	}));

	for (let i = 0; i < 10; i++) assert.equal((await request(sessionA.token)).status, 503);
	const sessionB = createOwnerSession();
	assert.notEqual(sessionB.id, sessionA.id);
	assert.equal((await request(sessionB.token)).status, 429);
});
