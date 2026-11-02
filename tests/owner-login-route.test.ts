import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "lh-login-route-"));
mkdirSync(path.join(root, "owner"));
process.env.LH_RUNTIME = "hosted";
process.env.LH_OWNER_DIR = path.join(root, "owner");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const [{ POST }, { makeOwnerVerifier, createOwnerSession, validateOwnerSession }, { ownerStore }] = await Promise.all([
	import("../app/api/auth/login/route.ts"),
	import("../src/server/owner-auth.ts"),
	import("../src/store/owner.ts"),
]);

const limiterKey = Symbol.for("lh.loginRateLimits");
const global = globalThis as unknown as Record<PropertyKey, unknown>;

beforeEach(() => {
	delete global[limiterKey];
});

afterEach(() => {
	delete global[limiterKey];
});

after(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.LH_RUNTIME;
	delete process.env.LH_OWNER_DIR;
});

test("login enforces streamed size, generic errors, secure cookie, and session rotation", async () => {
	const verifier = await makeOwnerVerifier("synthetic owner passphrase");
	ownerStore.writeOwner(verifier);

	const oversized = await POST(new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ passphrase: "x".repeat(5000) }),
	}));
	assert.equal(oversized.status, 413);
	assert.equal(oversized.headers.get("cache-control"), "no-store");

	const malformed = await POST(new Request("http://localhost/api/auth/login", { method: "POST", body: "not-json" }));
	assert.equal(malformed.status, 401);
	assert.deepEqual(await malformed.json(), { error: "Sign-in failed." });

	const old = createOwnerSession();
	const login = await POST(new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { cookie: `__Host-lh_session=${old.token}`, "content-type": "application/json" },
		body: JSON.stringify({ passphrase: "synthetic owner passphrase" }),
	}));
	assert.equal(login.status, 200);
	assert.deepEqual(await login.json(), { ok: true });
	assert.equal(validateOwnerSession(old.token), null);
	const cookie = login.headers.get("set-cookie") ?? "";
	assert.match(cookie, /^__Host-lh_session=[A-Za-z0-9_-]+;/);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /Secure/);
	assert.match(cookie, /SameSite=Strict/);
	assert.match(cookie, /Path=\//);
	assert.match(cookie, /Max-Age=43200/);
	assert.equal(cookie.includes("Domain="), false);
});

test("login rate limits a client bucket and the owner-wide bucket", async () => {
	const previousHops = process.env.LH_TRUSTED_PROXY_HOPS;
	process.env.LH_TRUSTED_PROXY_HOPS = "1";
	const attempt = (ip: string) => POST(new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-for": ip },
		body: JSON.stringify({ passphrase: 42 }),
	}));
	try {
		for (let i = 0; i < 5; i++) assert.equal((await attempt("198.51.100.1")).status, 401);
		assert.equal((await attempt("198.51.100.1")).status, 429);
		for (const ip of ["198.51.100.2", "198.51.100.3", "198.51.100.4"]) {
			for (let i = 0; i < 5; i++) assert.equal((await attempt(ip)).status, 401);
		}
		const ownerLimited = await attempt("198.51.100.5");
		assert.equal(ownerLimited.status, 429);
		assert.ok(Number(ownerLimited.headers.get("retry-after")) > 0);
	} finally {
		if (previousHops === undefined) delete process.env.LH_TRUSTED_PROXY_HOPS;
		else process.env.LH_TRUSTED_PROXY_HOPS = previousHops;
	}
});

test("login reserves client attempts before concurrent passphrase verification", async () => {
	await ownerStore.writeOwner(await makeOwnerVerifier("synthetic owner passphrase"));
	const previousHops = process.env.LH_TRUSTED_PROXY_HOPS;
	process.env.LH_TRUSTED_PROXY_HOPS = "1";
	try {
		const responses = await Promise.all(Array.from({ length: 10 }, () => POST(new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
			body: JSON.stringify({ passphrase: "wrong passphrase" }),
		}))));
		assert.equal(responses.filter((response) => response.status === 401).length, 5);
		assert.equal(responses.filter((response) => response.status === 429).length, 5);
	} finally {
		if (previousHops === undefined) delete process.env.LH_TRUSTED_PROXY_HOPS;
		else process.env.LH_TRUSTED_PROXY_HOPS = previousHops;
	}
});

test("successful login releases its reserved attempt", async () => {
	await ownerStore.writeOwner(await makeOwnerVerifier("synthetic owner passphrase"));
	const previousHops = process.env.LH_TRUSTED_PROXY_HOPS;
	process.env.LH_TRUSTED_PROXY_HOPS = "1";
	const attempt = (passphrase: string) => POST(new Request("http://localhost/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.11" },
		body: JSON.stringify({ passphrase }),
	}));
	try {
		for (let i = 0; i < 4; i++) assert.equal((await attempt("wrong passphrase")).status, 401);
		assert.equal((await attempt("synthetic owner passphrase")).status, 200);
		assert.equal((await attempt("wrong passphrase")).status, 401);
		assert.equal((await attempt("wrong passphrase")).status, 429);
	} finally {
		if (previousHops === undefined) delete process.env.LH_TRUSTED_PROXY_HOPS;
		else process.env.LH_TRUSTED_PROXY_HOPS = previousHops;
	}
});
