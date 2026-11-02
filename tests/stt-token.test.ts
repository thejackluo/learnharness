import assert from "node:assert/strict";
import { test } from "node:test";
import { createSttTokenService } from "../src/server/stt-token.ts";

test("STT token service mints a token with the short upstream timeout", async () => {
	let request: RequestInit | undefined;
	const service = createSttTokenService({
		key: () => "synthetic-key",
		fetcher: async (_input, init) => {
			request = init;
			return Response.json({ access_token: "synthetic-token" });
		},
	});
	assert.deepEqual(await service.mint("owner-a"), { status: 200, body: { token: "synthetic-token" } });
	assert.equal(request?.signal instanceof AbortSignal, true);
	assert.equal(request?.headers && new Headers(request.headers).get("authorization"), "Token synthetic-key");
});

test("STT token service preserves keyless contract and never returns upstream details", async () => {
	const missing = createSttTokenService({ key: () => undefined });
	assert.equal((await missing.mint("owner-a")).status, 503);
	const rejected = createSttTokenService({
		key: () => "synthetic-key",
		fetcher: async () => new Response("sensitive upstream diagnostic", { status: 403 }),
	});
	const result = await rejected.mint("owner-a");
	assert.deepEqual(result, { status: 502, body: { message: "Dictation token request failed (403)." } });
	assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("STT token service caps each owner at ten requests per minute", async () => {
	let now = 0;
	const service = createSttTokenService({
		key: () => "synthetic-key",
		now: () => now,
		fetcher: async () => Response.json({ access_token: "token" }),
	});
	for (let i = 0; i < 10; i++) assert.equal((await service.mint("owner-a")).status, 200);
	assert.equal((await service.mint("owner-a")).status, 429);
	assert.equal((await service.mint("owner-b")).status, 200);
	now = 60_001;
	assert.equal((await service.mint("owner-a")).status, 200);
});
