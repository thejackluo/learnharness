#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next/standalone");
const passphrase = "synthetic hosted smoke passphrase";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hosted-smoke-"));
const servers = new Set();
let logs = "";

async function freePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function provision(directory) {
	for (const child of ["data", "keys", "owner"]) fs.mkdirSync(path.join(directory, child), { recursive: true });
	execFileSync(process.execPath, [path.join(root, "scripts/owner-passphrase.mjs"), "--dir", path.join(directory, "owner")], {
		input: `${passphrase}\n`,
		env: { ...process.env, LH_OWNER_DIR: path.join(directory, "owner") },
		stdio: ["pipe", "ignore", "pipe"],
	});
}

function start(directory, port) {
	const env = {
		...process.env,
		NODE_ENV: "production",
		LH_RUNTIME: "hosted",
		LH_PUBLIC_ORIGIN: "https://lh.invalid",
		LH_DATA_DIR: path.join(directory, "data"),
		LH_AUTH_FILE: path.join(directory, "keys/auth.json"),
		LH_OWNER_DIR: path.join(directory, "owner"),
		HOSTNAME: "127.0.0.1",
		PORT: String(port),
		NEXT_MANUAL_SIG_HANDLE: "true",
		NEXT_TELEMETRY_DISABLED: "1",
	};
	const child = spawn(process.execPath, ["server.js"], { cwd: standalone, env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", (data) => { logs += data.toString(); });
	child.stderr.on("data", (data) => { logs += data.toString(); });
	servers.add(child);
	child.once("exit", () => servers.delete(child));
	return { child, base: `http://127.0.0.1:${port}` };
}

async function waitForServer(server, shouldStart = true) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.child.exitCode !== null && shouldStart) throw new Error(`Server exited early (${server.child.exitCode}).\n${logs}`);
		try {
			const response = await fetch(`${server.base}/api/health`, { signal: AbortSignal.timeout(500) });
			if (shouldStart && response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (shouldStart) throw new Error(`Server did not start.\n${logs}`);
}

async function stop(server, signal = "SIGTERM") {
	if (server.child.exitCode !== null) return server.child.exitCode;
	server.child.kill(signal);
	const [code, exitSignal] = await once(server.child, "exit");
	return signal === "SIGKILL" ? exitSignal : code;
}

async function login(base, address = "127.0.0.1") {
	const response = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { Origin: "https://lh.invalid", "Content-Type": "application/json", "X-Forwarded-For": address },
		body: JSON.stringify({ passphrase }),
	});
	assert.equal(response.status, 200, `Owner login failed: ${await response.clone().text()}`);
	const setCookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? "";
	assert.match(setCookie, /;\s*Path=\//i);
	assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
	assert.match(setCookie, /;\s*Secure(?:;|$)/i);
	assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i);
	const cookie = setCookie.match(/__Host-lh_session=[^;\s]+/)?.[0];
	assert.ok(cookie, "owner login sets a session cookie");
	return cookie;
}

function assertNonce(response, html) {
	const csp = response.headers.get("content-security-policy") ?? "";
	const nonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
	assert.ok(nonce, "CSP has a script nonce");
	const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
	assert.ok(scripts.length > 0, "page contains script tags");
	for (const [, attributes] of scripts) {
		const scriptNonce = attributes.match(/\bnonce=["']([^"']+)["']/i)?.[1];
		assert.equal(scriptNonce, nonce, "every script carries the CSP nonce");
	}
}

async function page(base, pathname, cookie) {
	const response = await fetch(`${base}${pathname}`, {
		redirect: "manual",
		headers: cookie ? { Cookie: cookie } : {},
	});
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const html = await response.text();
	return { response, html };
}

async function api(base, pathname, cookie, init = {}) {
	return fetch(`${base}${pathname}`, {
		...init,
		headers: {
			...(init.headers ?? {}),
			...(cookie ? { Cookie: cookie } : {}),
			...(init.method && init.method !== "GET" ? { Origin: "https://lh.invalid" } : {}),
		},
	});
}

try {
	assert.ok(fs.existsSync(path.join(standalone, "server.js")), "build the standalone server first");
	const data = path.join(temp, "primary");
	provision(data);
	let port = await freePort();
	let server = start(data, port);
	await waitForServer(server);
	const anonRoot = await page(server.base, "/");
	assert.equal(anonRoot.response.status, 303);
	assert.match(anonRoot.response.headers.get("location") ?? "", /\/login/);
	assert.ok(anonRoot.response.headers.get("content-security-policy"));
	const anonLogin = await page(server.base, "/login");
	assert.equal(anonLogin.response.status, 200);
	assertNonce(anonLogin.response, anonLogin.html);
	assert.equal((await fetch(`${server.base}/api/chats`)).status, 401);
	for (const pathname of ["/", "/login"]) {
		const head = await fetch(`${server.base}${pathname}`, { method: "HEAD", redirect: "manual" });
		assert.ok(head.status < 500);
	}
	assert.equal((await fetch(`${server.base}/api/health`, { method: "HEAD" })).status, 200);
	for (let attempt = 1; attempt <= 6; attempt++) {
		const response = await fetch(`${server.base}/api/auth/login`, {
			method: "POST",
			headers: { Origin: "https://lh.invalid", "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.44" },
			body: JSON.stringify({ passphrase: "wrong synthetic passphrase" }),
		});
		assert.equal(response.status, attempt === 6 ? 429 : 401);
	}
	assert.equal(await stop(server), 0, "manual SIGTERM handler exits cleanly");

	server = start(data, await freePort());
	await waitForServer(server);
	const cookie = await login(server.base);
	for (const pathname of ["/", "/login"]) {
		const rendered = await page(server.base, pathname, cookie);
		assert.equal(rendered.response.status, 200);
		assertNonce(rendered.response, rendered.html);
	}
	const crossOrigin = await fetch(`${server.base}/api/chats`, {
		method: "POST",
		headers: { Origin: "https://evil.invalid", "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ title: "must reject" }),
	});
	assert.equal(crossOrigin.status, 403);
	const stt = await api(server.base, "/api/stt/token", cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	assert.equal(stt.status, 503);

	const created = await api(server.base, "/api/chats", cookie, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "hosted-persistence-smoke" }),
	});
	assert.equal(created.status, 200);
	const chat = await created.json();
	assert.ok(chat.id);
	const settings = await api(server.base, "/api/settings/general", cookie, {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdate: false }),
	});
	assert.equal(settings.status, 200);
	const key = await api(server.base, "/api/keys/OPENAI_API_KEY", cookie, {
		method: "PUT", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: "sk-synthetic-hosted-smoke-0123456789abcdef" }),
	});
	assert.equal(key.status, 200);
	const form = new FormData();
	form.append("files", new File(["synthetic bounded note"], "smoke.txt", { type: "text/plain" }));
	const imported = await api(server.base, "/api/graph/import", cookie, { method: "POST", body: form });
	const importResult = await imported.json();
	assert.equal(importResult.results?.[0]?.code, "models_not_configured");

	const logout = await api(server.base, "/api/auth/logout", cookie, { method: "POST" });
	assert.equal(logout.status, 204);
	assert.equal((await api(server.base, "/api/chats", cookie)).status, 401);
	const persistentCookie = await login(server.base);
	const contender = start(data, await freePort());
	const contenderExit = await Promise.race([
		once(contender.child, "exit").then(([code]) => code),
		new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
	]);
	assert.notEqual(contenderExit, "timeout", "a second process cannot acquire the writer lock");
	assert.notEqual(contender.child.exitCode, 0, "writer-lock contention exits the second process");
	assert.equal(await stop(server, "SIGKILL"), "SIGKILL");
	server = start(data, await freePort());
	await waitForServer(server);
	const chats = await (await api(server.base, "/api/chats", persistentCookie)).json();
	assert.ok(chats.chats.some((item) => item.id === chat.id));
	const statuses = await (await api(server.base, "/api/keys", persistentCookie)).json();
	assert.ok(statuses.keys.some((item) => item.id === "OPENAI_API_KEY"));
	const persistedSettings = await (await api(server.base, "/api/settings", persistentCookie)).json();
	assert.equal(persistedSettings.settings.general.autoUpdate, false);

	const isolated = path.join(temp, "isolated");
	provision(isolated);
	const freshServer = start(isolated, await freePort());
	await waitForServer(freshServer);
	const freshCookie = await login(freshServer.base, "192.0.2.55");
	const empty = await (await api(freshServer.base, "/api/chats", freshCookie)).json();
	assert.deepEqual(empty.chats, []);
	assert.equal(await stop(freshServer), 0);
	console.log("Hosted standalone smoke passed (CSP nonces, auth, origin checks, import refusal, locks, persistence, isolation).");
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	if (logs) console.error(logs);
	process.exitCode = 1;
} finally {
	for (const child of servers) {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await once(child, "exit").catch(() => {});
		}
	}
	fs.rmSync(temp, { recursive: true, force: true });
}
