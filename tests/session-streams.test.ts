import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { closeSessionStreams, guardStream } from "../src/server/session-streams.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("logout closes a registered owner stream", async () => {
	const response = new Response(new ReadableStream<Uint8Array>({ start() {} }));
	const guarded = guardStream(response, "session-logout", () => true, 60_000);
	const reader = guarded.body!.getReader();
	const pending = reader.read();
	closeSessionStreams("session-logout");
	assert.equal((await pending).done, true);
});

test("periodic session validation closes expired streams without touching them", async () => {
	let active = true;
	const guarded = guardStream(
		new Response(new ReadableStream<Uint8Array>({ start() {} })),
		"session-expiry",
		() => active,
		5,
	);
	const reader = guarded.body!.getReader();
	const pending = reader.read();
	active = false;
	await tick();
	assert.equal((await pending).done, true);
});

test("logout route revokes the owner session and closes its events stream", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "lh-stream-logout-"));
	const ownerDir = path.join(root, "owner");
	mkdirSync(ownerDir);
	const previousRuntime = process.env.LH_RUNTIME;
	const previousOwnerDir = process.env.LH_OWNER_DIR;
	process.env.LH_RUNTIME = "hosted";
	process.env.LH_OWNER_DIR = ownerDir;
	try {
		const [{ POST }, { createOwnerAuth, makeOwnerVerifier, OWNER_SESSION_COOKIE }, { createOwnerStore }] = await Promise.all([
			import("../app/api/auth/logout/route.ts"),
			import("../src/server/owner-auth.ts"),
			import("../src/store/owner.ts"),
		]);
		const store = createOwnerStore(ownerDir);
		await store.writeOwner(await makeOwnerVerifier("synthetic owner passphrase"));
		const auth = createOwnerAuth({ store });
		const session = auth.createSession();
		const guarded = guardStream(new Response(new ReadableStream<Uint8Array>({ start() {} })), session.id, () => true, 60_000);
		const reader = guarded.body!.getReader();
		const pending = reader.read();
		const response = await POST(new Request("https://lh.invalid/api/auth/logout", {
			method: "POST",
			headers: {
				cookie: `${OWNER_SESSION_COOKIE}=${session.token}`,
				"x-lh-session-id": session.id,
			},
		}));
		assert.equal(response.status, 204);
		assert.equal(auth.validateSession(session.token), null);
		assert.equal((await pending).done, true);
	} finally {
		if (previousRuntime === undefined) delete process.env.LH_RUNTIME;
		else process.env.LH_RUNTIME = previousRuntime;
		if (previousOwnerDir === undefined) delete process.env.LH_OWNER_DIR;
		else process.env.LH_OWNER_DIR = previousOwnerDir;
		rmSync(root, { recursive: true, force: true });
	}
});
