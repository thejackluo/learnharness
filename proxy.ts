import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeMode } from "./src/core/runtime.ts";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { OWNER_SESSION_COOKIE, validateOwnerSession } from "./src/server/owner-auth.ts";

const PRIVATE_SESSION_ID_HEADER = "x-lh-session-id";

function csp(nonce: string): string {
	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self' wss://api.deepgram.com",
		"worker-src 'self' blob:",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

function withHostedHeaders(response: NextResponse, nonce: string): NextResponse {
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("Content-Security-Policy", csp(nonce));
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set("Referrer-Policy", "same-origin");
	response.headers.set("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=()");
	response.headers.set("X-Frame-Options", "DENY");
	response.headers.set("Strict-Transport-Security", "max-age=31536000");
	response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
	return response;
}

function hostedResponse(request: NextRequest, response?: NextResponse, sessionId?: string): NextResponse {
	const nonce = randomBytes(16).toString("base64");
	const requestHeaders = new Headers(request.headers);
	requestHeaders.delete(PRIVATE_SESSION_ID_HEADER);
	requestHeaders.set("x-nonce", nonce);
	requestHeaders.set("Content-Security-Policy", csp(nonce));
	if (sessionId) requestHeaders.set(PRIVATE_SESSION_ID_HEADER, sessionId);
	const result = response ?? NextResponse.next({ request: { headers: requestHeaders } });
	return withHostedHeaders(result, nonce);
}

function jsonError(status: number, error: string): NextResponse {
	return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isLoopbackHost(host: string | null): boolean {
	if (!host) return false;
	try {
		const hostname = new URL(`http://${host}`).hostname.toLowerCase();
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

function safeNext(pathAndSearch: string): string {
	if (
		!pathAndSearch.startsWith("/") ||
		pathAndSearch.startsWith("//") ||
		pathAndSearch.includes("\\") ||
		/[\u0000-\u001f\u007f]/.test(pathAndSearch)
	) return "/";
	return pathAndSearch;
}

function passiveGet(pathname: string): boolean {
	return pathname === "/api/events" ||
		/^\/api\/chats\/[^/]+\/stream$/.test(pathname) ||
		pathname === "/api/activity" ||
		pathname === "/api/jobs" ||
		pathname === "/api/graph/status";
}

function sameOriginWrite(request: NextRequest, publicOrigin: string | undefined): boolean {
	const origin = request.headers.get("origin");
	if (!publicOrigin || origin !== publicOrigin) return false;
	const fetchSite = request.headers.get("sec-fetch-site");
	return fetchSite === null || fetchSite === "same-origin";
}

export function proxy(request: NextRequest): NextResponse {
	const resolved = resolveRuntimeMode(process.env);
	if ("error" in resolved) return jsonError(503, "Runtime configuration is invalid.");
	const mode = resolved.mode;
	const pathname = request.nextUrl.pathname;

	if (mode === "desktop") {
		if (pathname.startsWith("/api") && !desktopAPIAuthorized(request.headers)) {
			return jsonError(403, "Desktop API access requires the trusted LearnHarness window.");
		}
		return NextResponse.next();
	}

	if (mode === "local") {
		if (!isLoopbackHost(request.headers.get("host"))) {
			return pathname.startsWith("/api")
				? jsonError(403, "Local access is restricted to loopback hosts.")
				: new NextResponse("Local access is restricted to loopback hosts.", { status: 403 });
		}
		return NextResponse.next();
	}

	const publicOrigin = process.env.LH_PUBLIC_ORIGIN;
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD" && !sameOriginWrite(request, publicOrigin)) {
		return hostedResponse(request, jsonError(403, "Same-origin request required."));
	}
	const isPublic =
		(method === "GET" && pathname === "/login") ||
		(method === "POST" && pathname === "/api/auth/login") ||
		(method === "GET" && pathname === "/api/health");
	if (isPublic) return hostedResponse(request);

	const token = request.cookies.get(OWNER_SESSION_COOKIE)?.value;
	const session = validateOwnerSession(token, { touch: !(method === "GET" && passiveGet(pathname)) });
	if (!session) {
		if (pathname.startsWith("/api")) {
			return hostedResponse(request, jsonError(401, "Sign in required."));
		}
		const location = new URL("/login", publicOrigin ?? "https://invalid.invalid");
		location.searchParams.set("next", safeNext(`${pathname}${request.nextUrl.search}`));
		return hostedResponse(request, NextResponse.redirect(location, 303));
	}
	return hostedResponse(request, undefined, session.id);
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|siwc/|worklets/).*)"],
};
