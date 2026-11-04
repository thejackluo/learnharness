import { learnerJsonResponse, readLearnerEvidence } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try {
		const url = new URL(request.url);
		const cursor = url.searchParams.get("cursor") ?? undefined;
		const rawLimit = url.searchParams.get("limit");
		const limit = rawLimit === null ? undefined : Number(rawLimit);
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			return learnerJsonResponse({ error: "limit must be a positive integer" }, 400);
		}
		return learnerJsonResponse(readLearnerEvidence({ cursor, limit }));
	} catch (error) {
		console.error("[learner evidence] read failed:", error);
		return learnerJsonResponse({ error: "Unable to read learner evidence." }, 500);
	}
}
