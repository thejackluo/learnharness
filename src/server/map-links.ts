import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ChatRecord, SubjectMapV1 } from "../core/contracts.ts";
import { projectSavedMapsContext } from "../core/map-links.ts";
import { isSubjectMapId } from "../core/subject-map.ts";
import { invalidInputResult } from "../agent/tool-execute.ts";
import type { MapDraftSuggestionInput, MapLinkSuggestionInput } from "../agent/tools/map-links.ts";
import { stores } from "./stores.ts";

type MapSuggestionChat = Pick<ChatRecord, "kind" | "placement" | "target" | "messages" | "mapSuggestionDecisions">;
type ToolResult = Extract<ChatRecord["messages"][number], { role: "toolResult" }>;

function availableMaps(): SubjectMapV1[] {
	return stores.subjectMapStore.list()
		.filter((summary) => summary.state === "ok")
		.map((summary) => stores.subjectMapStore.read(summary.id))
		.filter((read): read is Extract<typeof read, { state: "ok" }> => read.state === "ok")
		.map((read) => read.map);
}

export function savedMapsContextFor(record: MapSuggestionChat): string | null {
	if (record.kind === "practice" || record.placement) return null;
	try {
		return projectSavedMapsContext(record, availableMaps());
	} catch (error) {
		console.error("[map links] context read failed:", error);
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function successfulResults(record: ChatRecord, toolName: "suggest_map_link" | "suggest_map_draft"): ToolResult[] {
	return record.messages.filter((message): message is ToolResult =>
		message.role === "toolResult" && message.toolName === toolName && !message.isError && isRecord(message.details),
	);
}

function invalid(toolName: string, problem: string): AgentToolResult {
	return invalidInputResult(toolName, [problem]);
}

export function suggestMapLinkFromChat(
	chatId: string,
	input: MapLinkSuggestionInput,
	offeredThisTurn?: Set<string>,
): AgentToolResult {
	const mapId = typeof input.mapId === "string" ? input.mapId.trim() : "";
	const skillId = typeof input.skillId === "string" ? input.skillId.trim() : "";
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (!mapId || !skillId || !reason || reason.length > 200) {
		return invalid("suggest_map_link", "mapId, skillId, and a reason of at most 200 characters are required.");
	}
	if (!isSubjectMapId(mapId)) return invalid("suggest_map_link", "mapId must name an available saved map.");

	const record = stores.chatStore.getChat(chatId);
	if (!record) return invalid("suggest_map_link", "The chat is unavailable.");
	const turnKey = `${mapId}\u0000${skillId}`;
	if (offeredThisTurn?.has(turnKey)) return invalid("suggest_map_link", "This skill already has a pending suggestion in this chat.");

	let read;
	try {
		read = stores.subjectMapStore.read(mapId);
	} catch {
		return invalid("suggest_map_link", "The saved map is unavailable.");
	}
	if (read.state !== "ok") return invalid("suggest_map_link", "mapId must name an available saved map.");
	const skill = read.map.skills.find((candidate) => candidate.id === skillId);
	if (!skill) return invalid("suggest_map_link", "skillId must name a current skill in the saved map.");
	if (record.target?.mapId === mapId && record.target.skillId === skillId) {
		return invalid("suggest_map_link", "This chat is already linked to that skill.");
	}

	const decisions = new Map((record.mapSuggestionDecisions ?? []).map(({ callId, decision }) => [callId, decision]));
	for (const message of successfulResults(record, "suggest_map_link")) {
		if (!isRecord(message.details) || message.details.mapId !== mapId || message.details.skillId !== skillId) continue;
		const decision = decisions.get(message.toolCallId);
		if (decision === "dismissed") return invalid("suggest_map_link", "That skill was already declined in this chat.");
		if (!decision) return invalid("suggest_map_link", "That skill already has a pending suggestion in this chat.");
	}

	offeredThisTurn?.add(turnKey);
	return {
		content: [{
			type: "text",
			text: `Offered the learner a chip to link this chat to '${read.map.title}' → '${skill.title}'. Nothing is linked unless he accepts; until then don't treat it as the session target or set onTarget. Continue your reply normally.`,
		}],
		details: {
			mapId,
			mapTitle: read.map.title,
			skillId,
			skillTitle: skill.title,
			skillRevision: skill.revision,
			reason,
		},
	};
}

export function suggestMapDraftFromChat(
	chatId: string,
	input: MapDraftSuggestionInput,
	suggestedThisTurn?: Set<string>,
): AgentToolResult {
	const subject = typeof input.subject === "string" ? input.subject.trim() : "";
	const goal = typeof input.goal === "string" ? input.goal.trim() : "";
	const framework = input.framework === undefined ? undefined : typeof input.framework === "string" ? input.framework.trim() : "";
	if (
		!subject || subject.length > 80 ||
		!goal || goal.length > 300 ||
		(framework !== undefined && (!framework || framework.length > 80))
	) {
		return invalid("suggest_map_draft", "subject (80), goal (300), and optional framework (80) must be non-empty after trimming and within their limits.");
	}
	const record = stores.chatStore.getChat(chatId);
	if (!record) return invalid("suggest_map_draft", "The chat is unavailable.");
	const subjectKey = subject.toLowerCase();
	if (suggestedThisTurn?.has(subjectKey)) {
		return invalid("suggest_map_draft", "A map draft for that subject was already suggested in this chat.");
	}
	for (const message of successfulResults(record, "suggest_map_draft")) {
		if (isRecord(message.details) && typeof message.details.subject === "string" && message.details.subject.trim().toLowerCase() === subjectKey) {
			return invalid("suggest_map_draft", "A map draft for that subject was already suggested in this chat.");
		}
	}
	suggestedThisTurn?.add(subjectKey);
	return {
		content: [{
			type: "text",
			text: "Offered a chip that opens the map drafter prefilled with this goal; he reviews any draft before it is saved. Continue your reply normally.",
		}],
		details: { subject, goal, ...(framework === undefined ? {} : { framework }) },
	};
}

export function mapSuggestionCallbacksForChat(chatId: string) {
	const offeredThisTurn = new Set<string>();
	const draftsThisTurn = new Set<string>();
	return {
		suggestMapLink: (input: MapLinkSuggestionInput) => suggestMapLinkFromChat(chatId, input, offeredThisTurn),
		suggestMapDraft: (input: MapDraftSuggestionInput) => suggestMapDraftFromChat(chatId, input, draftsThisTurn),
	};
}

export interface MapSuggestionFeatures {
	savedMapsContext: string | null;
	suggestMapLink?: (input: MapLinkSuggestionInput) => AgentToolResult;
	suggestMapDraft?: (input: MapDraftSuggestionInput) => AgentToolResult;
}

export function mapSuggestionFeaturesForChat(record: MapSuggestionChat, chatId: string): MapSuggestionFeatures {
	if (record.kind === "practice" || record.placement) return { savedMapsContext: null };
	const savedMapsContext = savedMapsContextFor(record);
	const callbacks = mapSuggestionCallbacksForChat(chatId);
	return {
		savedMapsContext,
		...(savedMapsContext ? { suggestMapLink: callbacks.suggestMapLink } : {}),
		suggestMapDraft: callbacks.suggestMapDraft,
	};
}
