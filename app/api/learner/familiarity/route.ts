import { isSubjectMapId } from "@/src/core";
import { latestPlacementFor, learnerJsonResponse, listFamiliaritySuggestions, runtimeMode } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const mapId = new URL(request.url).searchParams.get("mapId") ?? undefined;
	if (mapId !== undefined && !isSubjectMapId(mapId)) return learnerJsonResponse({ error: "Invalid mapId." }, 400);
	try {
		return learnerJsonResponse({
			...listFamiliaritySuggestions(mapId),
			...(mapId ? { latestPlacement: latestPlacementFor(mapId) } : {}),
			runtimeMode: runtimeMode(),
		});
	} catch (error) {
		console.error("[learner familiarity] read failed:", error);
		return learnerJsonResponse({ error: "Unable to read familiarity suggestions." }, 500);
	}
}
