import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OWNER_SESSION_COOKIE, validateOwnerSession, type AuthenticatedOwnerSession } from "./owner-auth.ts";
import { runtimeMode } from "./runtime.ts";

function cookieValue(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === OWNER_SESSION_COOKIE) return value.join("=");
	}
	return undefined;
}

export function requestOwnerSession(request: Request, touch = false): AuthenticatedOwnerSession | null {
	const session = validateOwnerSession(cookieValue(request.headers.get("cookie")), { touch });
	if (!session) return null;
	const forwardedId = request.headers.get("x-lh-session-id");
	if (forwardedId && forwardedId !== session.id) return null;
	return session;
}

export function requireOwnerRequest(request: Request): AuthenticatedOwnerSession | null {
	if (runtimeMode() !== "hosted") return null;
	return requestOwnerSession(request);
}

export async function requireOwnerPage(): Promise<void> {
	if (runtimeMode() !== "hosted") return;
	const cookieJar = await cookies();
	if (!validateOwnerSession(cookieJar.get(OWNER_SESSION_COOKIE)?.value, { touch: true })) redirect("/login");
}
