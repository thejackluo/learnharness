import assert from "node:assert/strict";
import test from "node:test";
import { lockWorkerNetwork } from "../components/worker-network-lockdown.ts";

test("Python worker network and script APIs are disabled and cannot be reassigned", () => {
	const scope: Record<string, unknown> = {
		fetch: () => "network",
		XMLHttpRequest: () => "network",
		WebSocket: () => "network",
		EventSource: () => "network",
		importScripts: () => "script",
		WebTransport: () => "network",
		navigator: { sendBeacon: () => true },
	};
	lockWorkerNetwork(scope);
	for (const api of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "WebTransport"]) {
		const blocked = scope[api] as () => never;
		assert.throws(blocked, /Network and script loading are disabled/);
		assert.throws(() => { scope[api] = () => "reassigned"; }, TypeError);
		assert.equal(scope[api], blocked);
	}
	const navigator = scope.navigator as Record<string, unknown>;
	const sendBeacon = navigator.sendBeacon as () => never;
	assert.throws(sendBeacon, /Network and script loading are disabled/);
	assert.throws(() => { navigator.sendBeacon = () => true; }, TypeError);
	assert.equal(navigator.sendBeacon, sendBeacon);

	const withoutOptionalApis: Record<string, unknown> = {};
	lockWorkerNetwork(withoutOptionalApis);
	assert.equal("WebTransport" in withoutOptionalApis, false);
	assert.equal("navigator" in withoutOptionalApis, false);
});
