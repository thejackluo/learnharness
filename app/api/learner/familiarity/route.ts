import { isSubjectMapId } from "@/src/core";
import { latestPlacementFor, learnerJsonResponse, listFamiliaritySuggestions, runtimeMode } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const mapId = params.get("mapId") ?? undefined;
	const chatId = params.get("chatId") ?? undefined;
	if (mapId !== undefined && !isSubjectMapId(mapId)) return learnerJsonResponse({ error: "Invalid mapId." }, 400);
	if (chatId !== undefined && !/^[A-Za-z0-9_-]+$/.test(chatId)) return learnerJsonResponse({ error: "Invalid chatId" }, 400);
	try {
		return learnerJsonResponse({
			...listFamiliaritySuggestions(mapId, chatId === undefined ? undefined : { placementChatId: chatId }),
			...(mapId ? { latestPlacement: latestPlacementFor(mapId) } : {}),
			runtimeMode: runtimeMode(),
		});
	} catch (error) {
		console.error("[learner familiarity] read failed:", error);
		return learnerJsonResponse({ error: "Unable to read familiarity suggestions." }, 500);
	}
}
