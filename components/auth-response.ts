import type { RuntimeMode } from "@/src/core";

export function redirectOnUnauthorized(response: Response, mode: RuntimeMode | undefined): boolean {
	if (response.status !== 401 || mode !== "hosted" || typeof window === "undefined") return false;
	if (window.location.pathname !== "/login") window.location.assign("/login");
	return true;
}

export function installUnauthorizedRedirect(mode: RuntimeMode): () => void {
	if (mode !== "hosted" || typeof window === "undefined") return () => {};
	const original = window.fetch;
	window.fetch = async (...args) => {
		const response = await original(...args);
		redirectOnUnauthorized(response, mode);
		return response;
	};
	return () => {
		if (window.fetch !== original) window.fetch = original;
	};
}
