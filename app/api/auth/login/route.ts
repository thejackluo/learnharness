import {
	createOwnerSession,
	OWNER_SESSION_COOKIE,
	revokeOwnerSession,
	runtimeMode,
	validateOwnerSession,
	verifyOwnerPassphrase,
} from "@/src/server";

const BODY_LIMIT = 4 * 1024;
const WINDOW_MS = 60_000;
const CLIENT_LIMIT = 5;
const OWNER_LIMIT = 20;
const LIMITER_KEY = Symbol.for("lh.loginRateLimits");

type LoginRateLimits = { clients: Map<string, number[]>; owner: number[] };

function limits(): LoginRateLimits {
	const global = globalThis as typeof globalThis & { [LIMITER_KEY]?: LoginRateLimits };
	return (global[LIMITER_KEY] ??= { clients: new Map(), owner: [] });
}

function clientBucket(request: Request): string {
	const configured = Number(process.env.LH_TRUSTED_PROXY_HOPS ?? "0");
	if (!Number.isSafeInteger(configured) || configured < 1) return "direct";
	const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
	return chain[chain.length - configured] ?? "direct";
}

function retryAfter(events: number[], now: number): number {
	return Math.max(1, Math.ceil((events[0]! + WINDOW_MS - now) / 1000));
}

function reserveAttempt(request: Request): Response | (() => void) {
	const now = Date.now();
	const state = limits();
	state.owner = state.owner.filter((time) => now - time < WINDOW_MS);
	const key = clientBucket(request);
	const clientEvents = (state.clients.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
	state.clients.set(key, clientEvents);
	if (clientEvents.length >= CLIENT_LIMIT) {
		return Response.json({ error: "Too many attempts. Try again shortly." }, {
			status: 429,
			headers: { "Retry-After": String(retryAfter(clientEvents, now)), "Cache-Control": "no-store" },
		});
	}
	if (state.owner.length >= OWNER_LIMIT) {
		return Response.json({ error: "Too many attempts. Try again shortly." }, {
			status: 429,
			headers: { "Retry-After": String(retryAfter(state.owner, now)), "Cache-Control": "no-store" },
		});
	}
	clientEvents.push(now);
	state.owner.push(now);
	return () => {
		const currentClientEvents = state.clients.get(key);
		const clientIndex = currentClientEvents?.indexOf(now) ?? -1;
		if (currentClientEvents && clientIndex !== -1) currentClientEvents.splice(clientIndex, 1);
		const ownerIndex = state.owner.indexOf(now);
		if (ownerIndex !== -1) state.owner.splice(ownerIndex, 1);
	};
}

async function readLimitedBody(request: Request): Promise<string | null | "too-large"> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > BODY_LIMIT) return "too-large";
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > BODY_LIMIT) {
				await reader.cancel();
				return "too-large";
			}
			chunks.push(value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		return null;
	}
}

function presentedToken(request: Request): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === OWNER_SESSION_COOKIE) return value.join("=");
	}
	return undefined;
}

export async function POST(request: Request): Promise<Response> {
	if (runtimeMode() !== "hosted") {
		return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
	}
	const reservation = reserveAttempt(request);
	if (reservation instanceof Response) return reservation;
	const body = await readLimitedBody(request);
	if (body === "too-large") {
		return Response.json({ error: "Request body too large." }, { status: 413, headers: { "Cache-Control": "no-store" } });
	}
	let passphrase: unknown;
	try {
		passphrase = JSON.parse(body ?? "null")?.passphrase;
	} catch {
		passphrase = undefined;
	}
	if (typeof passphrase !== "string" || !(await verifyOwnerPassphrase(passphrase))) {
		return Response.json({ error: "Sign-in failed." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	}
	reservation();
	const presented = validateOwnerSession(presentedToken(request));
	if (presented) revokeOwnerSession(presented.id);
	const { token } = createOwnerSession();
	return Response.json(
		{ ok: true },
		{
			headers: {
				"Cache-Control": "no-store",
				"Set-Cookie": `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 60 * 60}`,
			},
		},
	);
}
