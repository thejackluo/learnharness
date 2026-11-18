import { emit } from "@/src/core";
import type { ChatRecord } from "@/src/core";
import { getChat, requireOwnerRequest, runtimeMode, stores, targetPanelFor } from "@/src/server";

const headers = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

type ToolResult = Extract<ChatRecord["messages"][number], { role: "toolResult" }>;

/** The session target advice and any placement completion state for the panel. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return json({ error: "Not found" }, 404);
	return json(targetPanelFor(chat));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
	if (runtimeMode() === "hosted" && !requireOwnerRequest(request)) {
		return json({ error: "Sign in required." }, 401);
	}
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return json({ error: "Not found" }, 404);
	if (chat.placement) return json({ error: "Map suggestions are unavailable in placement chats." }, 409);
	if (chat.kind === "practice") return json({ error: "Map suggestions are unavailable in practice chats." }, 409);

	const body = await request.json().catch(() => null);
	if (
		!isRecord(body) ||
		typeof body.callId !== "string" || !body.callId.trim() ||
		(body.decision !== "accept" && body.decision !== "dismiss")
	) {
		return json({ error: "Body must be { callId: string, decision: 'accept' | 'dismiss' }." }, 400);
	}
	const callId = body.callId;
	const toolResult = chat.messages.find((message): message is ToolResult =>
		message.role === "toolResult" && message.toolCallId === callId && !message.isError,
	);
	if (!toolResult || (toolResult.toolName !== "suggest_map_link" && toolResult.toolName !== "suggest_map_draft")) {
		return json({ error: "Map suggestion not found." }, 404);
	}
	if (chat.mapSuggestionDecisions?.some((decision) => decision.callId === callId)) {
		return json({ error: "A decision was already recorded for this suggestion." }, 409);
	}
	if (body.decision === "accept" && toolResult.toolName !== "suggest_map_link") {
		return json({ error: "Draft suggestions cannot be accepted as chat targets." }, 400);
	}

	const at = new Date().toISOString();
	if (body.decision === "dismiss") {
		stores.chatStore.recordMapSuggestionDecision(id, callId, "dismissed", at);
	} else {
		const details = isRecord(toolResult.details) ? toolResult.details : null;
		const mapId = details?.mapId;
		const skillId = details?.skillId;
		if (typeof mapId !== "string" || typeof skillId !== "string") {
			return json({ error: "This map suggestion is no longer available." }, 409);
		}
		const mapRead = stores.subjectMapStore.read(mapId);
		if (mapRead.state !== "ok") {
			return json({ error: "The saved map is gone or unavailable." }, 409);
		}
		const skill = mapRead.map.skills.find((candidate) => candidate.id === skillId);
		if (!skill) {
			const retired = mapRead.map.retired.some((candidate) => candidate.id === skillId);
			return json({ error: retired ? "This skill was retired and can no longer be linked." : "This skill is no longer in the saved map." }, 409);
		}
		stores.chatStore.linkTarget(id, {
			kind: "subject-skill",
			mapId,
			skillId,
			skillRevision: skill.revision,
		}, callId, at);
		stores.chatStore.recordMapSuggestionDecision(id, callId, "accepted", at);
	}
	emit("record-changed", { chatId: id });
	const updated = getChat(id);
	return updated ? json(targetPanelFor(updated)) : json({ error: "Not found" }, 404);
}
