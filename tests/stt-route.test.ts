import assert from "node:assert/strict";
import { test } from "node:test";

test("STT token route is POST-only, same-origin, and never cacheable", async () => {
	const previousRuntime = process.env.LH_RUNTIME;
	const previousKey = process.env.DEEPGRAM_API_KEY;
	process.env.LH_RUNTIME = "local";
	delete process.env.DEEPGRAM_API_KEY;
	try {
		const route = await import("../app/api/stt/token/route.ts");
		const get = route.GET();
		assert.equal(get.status, 405);
		assert.equal(get.headers.get("Allow"), "POST");
		assert.equal(get.headers.get("Cache-Control"), "no-store");

		const crossOrigin = await route.POST(new Request("http://localhost/api/stt/token", {
			method: "POST",
			headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" },
			body: "{}",
		}));
		assert.equal(crossOrigin.status, 403);
		assert.equal(crossOrigin.headers.get("Cache-Control"), "no-store");

		const sameOrigin = await route.POST(new Request("http://localhost/api/stt/token", {
			method: "POST",
			headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
			body: "{}",
		}));
		assert.equal(sameOrigin.status, 503);
		assert.equal(sameOrigin.headers.get("Cache-Control"), "no-store");
	} finally {
		if (previousRuntime === undefined) delete process.env.LH_RUNTIME;
		else process.env.LH_RUNTIME = previousRuntime;
		if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
		else process.env.DEEPGRAM_API_KEY = previousKey;
	}
});
