import { requireOwnerRequest, runtimeMode, sttTokenService } from "@/src/server";

export const dynamic = "force-dynamic";

function response(body: { token?: string; message?: string }, status: number, extra: HeadersInit = {}): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

function methodNotAllowed(): Response {
	return response({ message: "Method not allowed." }, 405, { Allow: "POST" });
}

function sameOrigin(request: Request, hosted: boolean): boolean {
	const expected = hosted ? process.env.LH_PUBLIC_ORIGIN : new URL(request.url).origin;
	if (!expected || request.headers.get("origin") !== expected) return false;
	const fetchSite = request.headers.get("sec-fetch-site");
	return fetchSite === null || (hosted ? fetchSite === "same-origin" : fetchSite !== "cross-site");
}

export function GET(): Response {
	return methodNotAllowed();
}

export function HEAD(): Response {
	return methodNotAllowed();
}

export function OPTIONS(): Response {
	return methodNotAllowed();
}

export async function POST(request: Request): Promise<Response> {
	const mode = runtimeMode();
	const hosted = mode === "hosted";
	if (!sameOrigin(request, hosted)) return response({ message: "Same-origin request required." }, 403);
	const session = hosted ? requireOwnerRequest(request) : null;
	if (hosted && !session) return response({ message: "Sign in required." }, 401);
	const result = await sttTokenService.mint(hosted ? "owner" : mode);
	return response(result.body, result.status);
}
