import { decideSuggestions, learnerJsonResponse, learnerProfileWriteErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try { body = await request.json(); } catch { return learnerJsonResponse({ error: "Invalid JSON body." }, 400); }
	if (!body || typeof body !== "object" || Array.isArray(body)) return learnerJsonResponse({ error: "Body must be an object." }, 400);
	const value = body as Record<string, unknown>;
	if (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 2000 || value.ids.some((id) => typeof id !== "string" || !id.trim())) return learnerJsonResponse({ error: "ids must contain 1–2000 non-empty strings." }, 400);
	if (value.status !== "confirmed" && value.status !== "rejected") return learnerJsonResponse({ error: "status must be confirmed or rejected." }, 400);
	if (!Number.isInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return learnerJsonResponse({ error: "expectedRevision must be a non-negative integer." }, 400);
	try {
		const profile = decideSuggestions(value.ids as string[], value.status, value.expectedRevision as number);
		return learnerJsonResponse({ state: "ok", profile });
	} catch (error) {
		const mapped = learnerProfileWriteErrorResponse(error);
		if (mapped) return mapped;
		if (error instanceof Error && error.message.startsWith("Unknown familiarity suggestion id:")) return learnerJsonResponse({ error: error.message }, 400);
		console.error("[learner familiarity] decision failed:", error);
		return learnerJsonResponse({ error: "Unable to update familiarity suggestions." }, 500);
	}
}
