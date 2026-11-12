const BLOCKED_APIS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"] as const;

function denyNetworkAccess(): never {
	throw new Error("Network and script loading are disabled in the Python worker.");
}

export function lockWorkerNetwork(scope: Record<string, unknown>): void {
	for (const api of BLOCKED_APIS) {
		Object.defineProperty(scope, api, { value: denyNetworkAccess, writable: false, configurable: false });
	}
	if ("WebTransport" in scope) {
		Object.defineProperty(scope, "WebTransport", { value: denyNetworkAccess, writable: false, configurable: false });
	}
	const navigator = scope.navigator;
	if (navigator && typeof navigator === "object" && "sendBeacon" in navigator) {
		Object.defineProperty(navigator, "sendBeacon", { value: denyNetworkAccess, writable: false, configurable: false });
	}
}
