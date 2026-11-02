import { keyValue } from "./keys.ts";

export interface SttMintResult {
	status: number;
	body: { token?: string; message?: string };
}

export interface SttTokenServiceOptions {
	fetcher?: typeof fetch;
	key?: () => string | undefined;
	now?: () => number;
}

const WINDOW_MS = 60_000;
const MINT_LIMIT = 10;

export function createSttTokenService(options: SttTokenServiceOptions = {}) {
	const fetcher = options.fetcher ?? fetch;
	const key = options.key ?? (() => keyValue("DEEPGRAM_API_KEY"));
	const now = options.now ?? Date.now;
	const buckets = new Map<string, number[]>();
	return {
		async mint(ownerId: string): Promise<SttMintResult> {
			const time = now();
			const recent = (buckets.get(ownerId) ?? []).filter((at) => time - at < WINDOW_MS);
			if (recent.length >= MINT_LIMIT) return { status: 429, body: { message: "Too many dictation token requests." } };
			buckets.set(ownerId, [...recent, time]);
			const secret = key();
			if (!secret) return { status: 503, body: { message: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." } };
			try {
				const response = await fetcher("https://api.deepgram.com/v1/auth/grant", {
					method: "POST",
					headers: { Authorization: `Token ${secret}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ttl_seconds: 300 }),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) {
					return { status: 502, body: { message: `Dictation token request failed (${response.status}).` } };
				}
				const data = await response.json() as { access_token?: unknown };
				if (typeof data.access_token !== "string" || !data.access_token) {
					return { status: 502, body: { message: "Dictation token provider returned an invalid response." } };
				}
				return { status: 200, body: { token: data.access_token } };
			} catch (error) {
				return {
					status: error instanceof Error && error.name === "TimeoutError" ? 504 : 502,
					body: { message: error instanceof Error && error.name === "TimeoutError" ? "Dictation token request timed out." : "Dictation token provider is unavailable." },
				};
			}
		},
	};
}

export const sttTokenService = createSttTokenService();
