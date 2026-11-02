import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

const root = mkdtempSync(path.join(tmpdir(), "lh-hosted-proxy-"));
mkdirSync(path.join(root, "owner"));
process.env.LH_RUNTIME = "hosted";
process.env.LH_PUBLIC_ORIGIN = "https://lh.invalid";
process.env.LH_OWNER_DIR = path.join(root, "owner");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const [{ proxy, config }, { unstable_doesMiddlewareMatch: doesProxyMatch }, { createOwnerStore }, { createOwnerAuth, makeOwnerVerifier, OWNER_SESSION_COOKIE }] =
	await Promise.all([
		import("../proxy.ts"),
		import("next/experimental/testing/server"),
		import("../src/store/owner.ts"),
		import("../src/server/owner-auth.ts"),
	]);
const ownerStore = createOwnerStore(path.join(root, "owner"));
await ownerStore.writeOwner(await makeOwnerVerifier("synthetic hosted passphrase"));
const ownerAuth = createOwnerAuth({ store: ownerStore });
const session = ownerAuth.createSession();

after(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.LH_RUNTIME;
	delete process.env.LH_PUBLIC_ORIGIN;
	delete process.env.LH_OWNER_DIR;
});

test("hosted proxy redirects anonymous pages safely and returns no-store JSON for APIs", async () => {
	const page = proxy(new NextRequest("https://lh.invalid/chat/abc?prompt=lesson"));
	assert.equal(page.status, 303);
	const location = new URL(page.headers.get("location")!);
	assert.equal(location.origin, "https://lh.invalid");
	assert.equal(location.pathname, "/login");
	assert.equal(location.searchParams.get("next"), "/chat/abc?prompt=lesson");
	assert.equal(page.headers.get("cache-control"), "private, no-store");
	assert.match(page.headers.get("content-security-policy") ?? "", /nonce-/);

	const api = proxy(new NextRequest("https://lh.invalid/api/jobs"));
	assert.equal(api.status, 401);
	assert.deepEqual(await api.json(), { error: "Sign in required." });
	assert.equal(api.headers.get("cache-control"), "private, no-store");
});

test("hosted learner profile routes require a session and same-origin writes", () => {
	const anonymous = proxy(new NextRequest("https://lh.invalid/api/learner/profile"));
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.headers.get("cache-control"), "private, no-store");

	const crossOrigin = proxy(new NextRequest("https://lh.invalid/api/learner/profile", {
		method: "PUT",
		headers: { origin: "https://elsewhere.invalid" },
	}));
	assert.equal(crossOrigin.status, 403);
	assert.equal(crossOrigin.headers.get("cache-control"), "private, no-store");
});

test("hosted public login and health routes allow HEAD without a session", () => {
	for (const url of ["https://lh.invalid/login", "https://lh.invalid/api/health"]) {
		const response = proxy(new NextRequest(url, { method: "HEAD" }));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-security-policy") ?? "", /nonce-/);
	}
});

test("RSC and prefetched private pages redirect with origin-locked, sanitized next values", () => {
	const requestHeaders: Record<string, string>[] = [{ rsc: "1" }, { "next-router-prefetch": "1" }];
	for (const headers of requestHeaders) {
		const response = proxy(new NextRequest("https://lh.invalid/chat/new?prompt=lesson", { headers }));
		assert.equal(response.status, 303);
		const location = new URL(response.headers.get("location")!);
		assert.equal(location.origin, "https://lh.invalid");
		assert.equal(location.searchParams.get("next"), "/chat/new?prompt=lesson");
	}
	const protocolRelative = proxy(new NextRequest("https://lh.invalid//evil.invalid"));
	const location = new URL(protocolRelative.headers.get("location")!);
	assert.equal(location.origin, "https://lh.invalid");
	assert.equal(location.searchParams.get("next"), "/");
	const externalHost = proxy(new NextRequest("https://evil.invalid/private"));
	assert.equal(new URL(externalHost.headers.get("location")!).origin, "https://lh.invalid");
});

test("hosted proxy rejects unsafe requests without exact public origin", () => {
	for (const origin of [undefined, "null", "https://elsewhere.invalid"]) {
		const headers = new Headers();
		if (origin !== undefined) headers.set("origin", origin);
		const response = proxy(new NextRequest("https://lh.invalid/api/settings", { method: "POST", headers }));
		assert.equal(response.status, 403);
	}
});

test("hosted proxy strips forged session headers and forwards only the cookie session", () => {
	const publicRoute = proxy(new NextRequest("https://lh.invalid/api/auth/login", {
		method: "POST",
		headers: { origin: "https://lh.invalid", "x-lh-session-id": "forged-session" },
	}));
	assert.equal(publicRoute.headers.get("x-middleware-request-x-lh-session-id"), null);

	const privateRoute = proxy(new NextRequest("https://lh.invalid/api/jobs", {
		headers: {
			cookie: `${OWNER_SESSION_COOKIE}=${session.token}`,
			"x-lh-session-id": "forged-session",
		},
	}));
	assert.equal(privateRoute.headers.get("x-middleware-request-x-lh-session-id"), session.id);
	const desktopHeader = proxy(new NextRequest("https://lh.invalid/api/settings", {
		headers: { "x-lh-desktop-api-secret": "synthetic-forgery" },
	}));
	assert.equal(desktopHeader.status, 401);
});

test("passive hosted GETs do not touch sessions; active GETs do", () => {
	const current = ownerStore.readSessions().find((entry) => entry.id === session.id)!;
	const stale = { ...current, createdAt: Date.now() - 120_000, lastSeenAt: Date.now() - 120_000 };
	ownerStore.writeSessions(ownerStore.readSessions().map((entry) => entry.id === session.id ? stale : entry));
	proxy(new NextRequest("https://lh.invalid/api/events", {
		headers: { cookie: `${OWNER_SESSION_COOKIE}=${session.token}` },
	}));
	assert.equal(ownerStore.readSessions().find((entry) => entry.id === session.id)?.lastSeenAt, stale.lastSeenAt);
	proxy(new NextRequest("https://lh.invalid/api/settings", {
		headers: { cookie: `${OWNER_SESSION_COOKIE}=${session.token}` },
	}));
	assert.ok(ownerStore.readSessions().find((entry) => entry.id === session.id)!.lastSeenAt > stale.lastSeenAt);
});

function appRoutePaths(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return appRoutePaths(file);
		if (entry.name !== "page.tsx" && entry.name !== "route.ts") return [];
		const segments = path.relative(path.resolve("app"), path.dirname(file))
			.split(path.sep)
			.filter((segment) => !/^\(.+\)$/.test(segment))
			.map((segment) => /^\[.+\]$/.test(segment) ? "test-param" : segment);
		return [`/${segments.join("/")}`.replace(/\/$/, segments.length ? "" : "/")];
	});
}

test("hosted proxy matcher covers every app page and API route while excluding static paths", () => {
	for (const route of appRoutePaths(path.resolve("app"))) {
		assert(doesProxyMatch({ config, nextConfig: {}, url: `https://lh.invalid${route}` }), `Proxy does not match ${route}`);
	}
	assert(!doesProxyMatch({ config, nextConfig: {}, url: "https://lh.invalid/_next/static/chunk.js" }));
	assert(!doesProxyMatch({ config, nextConfig: {}, url: "https://lh.invalid/fonts/OFL.txt" }));
});
