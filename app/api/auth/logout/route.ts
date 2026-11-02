import {
	closeSessionStreams,
	OWNER_SESSION_COOKIE,
	requireOwnerRequest,
	revokeOwnerSession,
	runtimeMode,
} from "@/src/server";

export async function POST(request: Request): Promise<Response> {
	if (runtimeMode() !== "hosted") {
		return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
	}
	const session = requireOwnerRequest(request);
	if (!session) {
		return Response.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	}
	revokeOwnerSession(session.id);
	closeSessionStreams(session.id);
	return new Response(null, {
		status: 204,
		headers: {
			"Cache-Control": "no-store",
			"Set-Cookie": `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
		},
	});
}
