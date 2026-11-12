import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-hosted-subscriptions-"));
const savedEnv = {
	LH_RUNTIME: process.env.LH_RUNTIME,
	LH_AUTH_FILE: process.env.LH_AUTH_FILE,
	LH_DATA_DIR: process.env.LH_DATA_DIR,
	LH_DESKTOP_SERVER: process.env.LH_DESKTOP_SERVER,
	LH_DESKTOP_API_SECRET: process.env.LH_DESKTOP_API_SECRET,
};
process.env.LH_RUNTIME = "hosted";
process.env.LH_AUTH_FILE = path.join(directory, "keys", "auth.json");
process.env.LH_DATA_DIR = path.join(directory, "data");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { webSubscriptionOwner, webSubscriptionsEnabled } = await import("../src/server/web-subscriptions.ts");
const { subscriptionBrowserResponse, subscriptionControlsResponse } = await import("../src/server/web-subscription-http.ts");
const origin = "https://learn.invalid";

function request(command?: Record<string, unknown>, site = "same-origin") {
	return new Request(`${origin}/api/subscriptions`, {
		method: command ? "POST" : "GET",
		headers: {
			host: new URL(origin).host,
			origin,
			"sec-fetch-site": site,
			"x-learnharness-subscriptions": "1",
			"content-type": "application/json",
		},
		...(command ? { body: JSON.stringify(command) } : {}),
	});
}

after(async () => {
	webSubscriptionOwner().close();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(directory, { recursive: true, force: true });
});

test("hosted ChatGPT paste completion is routed; native status and controls stay disabled", async () => {
	assert.equal(webSubscriptionsEnabled(), true);
	const owner = webSubscriptionOwner();
	let nativeReads = 0;
	owner.native.status = async () => { nativeReads++; return []; };

	const loginResponse = await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "login" }));
	assert.equal(loginResponse.status, 200);
	const login = await loginResponse.json();
	assert.equal(login.value.pending, true);
	assert.equal(login.value.callbackPaste, true);
	assert.match(login.browserAction, /^\/api\/subscriptions\/browser\?id=/);

	const browser = await subscriptionBrowserResponse(new Request(new URL(login.browserAction, origin), {
		headers: { host: new URL(origin).host, "sec-fetch-site": "same-origin" },
	}));
	assert.equal(browser.status, 303);
	const authorize = new URL(browser.headers.get("location")!);
	const callback = new URL(authorize.searchParams.get("redirect_uri")!);
	assert.equal(callback.hostname, "127.0.0.1");
	assert.equal(callback.pathname, "/auth/callback");
	assert(Number(callback.port) >= 49152 && Number(callback.port) <= 65535);
	callback.searchParams.set("state", "wrong-state");

	const completed = await subscriptionControlsResponse(request({
		providerId: "chatgpt",
		op: "complete",
		callbackUrl: callback.toString(),
	}));
	assert.equal(completed.status, 200);
	const completion = await completed.json();
	assert.equal(completion.value.pending, true);
	assert.equal(completion.value.callbackPaste, true);
	assert.match(completion.value.error, /could not be verified/i);

	const crossOriginNative = await subscriptionControlsResponse(new Request(`${origin}/api/subscriptions`, {
		method: "POST",
		headers: {
			host: new URL(origin).host,
			origin: "https://attacker.invalid",
			"sec-fetch-site": "cross-site",
			"x-learnharness-subscriptions": "1",
			"content-type": "application/json",
		},
		body: JSON.stringify({ providerId: "xai", op: "consent", enabled: false }),
	}));
	assert.equal(crossOriginNative.status, 403);

	const native = await subscriptionControlsResponse(request({ providerId: "xai", op: "consent", enabled: false }));
	assert.equal(native.status, 404);
	assert.deepEqual(await native.json(), { error: "Hosted mode cannot connect this subscription." });
	const status = await subscriptionControlsResponse(request());
	assert.equal(status.status, 200);
	assert.deepEqual((await status.json()).native, []);
	assert.equal(nativeReads, 0);

	await subscriptionControlsResponse(request({ providerId: "chatgpt", op: "cancel" }));
});
