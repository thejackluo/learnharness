import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";

export const suggestFamiliaritySchema = Type.Object({ skillId: Type.String(), quote: Type.String() });

export function suggestFamiliarityTool(suggest: (input: { skillId: string; quote: string }) => AgentToolResult | Promise<AgentToolResult>): AgentTool<typeof suggestFamiliaritySchema> {
	return {
		name: "suggest_familiarity",
		label: "suggest_familiarity",
		description: "Suggest that a skill is likely known based only on the learner's own quoted words. This is not evidence.",
		parameters: suggestFamiliaritySchema,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!input.skillId.trim() || !input.quote.trim() || input.quote.length > 500) return invalidInputResult("suggest_familiarity", ["skillId and a quote of at most 500 characters are required."]);
			return await suggest(input);
		},
	};
}
