import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";

export interface MapLinkSuggestionInput {
	mapId: string;
	skillId: string;
	reason: string;
}

export interface MapDraftSuggestionInput {
	subject: string;
	goal: string;
	framework?: string;
}

export const suggestMapLinkSchema = Type.Object({
	mapId: Type.String({ minLength: 1 }),
	skillId: Type.String({ minLength: 1 }),
	reason: Type.String({ maxLength: 200 }),
});

export const suggestMapDraftSchema = Type.Object({
	subject: Type.String({ minLength: 1, maxLength: 80 }),
	goal: Type.String({ minLength: 1, maxLength: 300 }),
	framework: Type.Optional(Type.String({ maxLength: 80 })),
});

export function suggestMapLinkTool(
	suggest: (input: MapLinkSuggestionInput) => AgentToolResult | Promise<AgentToolResult>,
): AgentTool<typeof suggestMapLinkSchema> {
	return {
		name: "suggest_map_link",
		label: "suggest_map_link",
		description: "Offer the learner a chip to link this chat to one of his saved map skills.",
		parameters: suggestMapLinkSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const normalized = {
				mapId: input.mapId.trim(),
				skillId: input.skillId.trim(),
				reason: input.reason.trim(),
			};
			if (!normalized.mapId || !normalized.skillId || !normalized.reason || input.reason.length > 200) {
				return invalidInputResult("suggest_map_link", ["mapId, skillId, and a reason of at most 200 characters are required."]);
			}
			return await suggest(normalized);
		},
	};
}

export function suggestMapDraftTool(
	suggest: (input: MapDraftSuggestionInput) => AgentToolResult | Promise<AgentToolResult>,
): AgentTool<typeof suggestMapDraftSchema> {
	return {
		name: "suggest_map_draft",
		label: "suggest_map_draft",
		description: "Offer the learner a chip to draft a map for a subject he wants to study.",
		parameters: suggestMapDraftSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const normalized = {
				subject: input.subject.trim(),
				goal: input.goal.trim(),
				...(input.framework === undefined ? {} : { framework: input.framework.trim() }),
			};
			if (
				!normalized.subject || normalized.subject.length > 80 ||
				!normalized.goal || normalized.goal.length > 300 ||
				(normalized.framework !== undefined && (!normalized.framework || normalized.framework.length > 80))
			) {
				return invalidInputResult("suggest_map_draft", ["subject (80), goal (300), and optional framework (80) must be non-empty after trimming and within their limits."]);
			}
			return await suggest(normalized);
		},
	};
}
