import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { LearningTargetRef } from "../../core/contracts/learning-target.ts";
import { LEARNER_LIMITS } from "../../core/contracts/learner.ts";
import { invalidInputResult } from "../tool-execute.ts";

const targetSchema = Type.Object({
	kind: Type.Literal("subject-skill"),
	mapId: Type.String(),
	skillId: Type.String(),
	skillRevision: Type.Integer({ minimum: 0 }),
});

export const notePatternSchema = Type.Object({
	subject: Type.String({ minLength: 1, maxLength: LEARNER_LIMITS.patternSubjectChars }),
	pattern: Type.String({ minLength: 1, maxLength: LEARNER_LIMITS.patternChars }),
	quote: Type.String({ minLength: 1, maxLength: LEARNER_LIMITS.patternQuoteChars }),
	target: Type.Optional(targetSchema),
});

export interface NotePatternToolInput {
	subject: string;
	pattern: string;
	quote: string;
	target?: LearningTargetRef;
}

export function notePatternTool(
	note: (input: NotePatternToolInput) => AgentToolResult | Promise<AgentToolResult>,
): AgentTool<typeof notePatternSchema> {
	return {
		name: "note_pattern",
		label: "note_pattern",
		description:
			"Record a specific recurring weakness shown in the learner's own words or submitted answer in this chat. " +
			"Quote a verbatim excerpt; whitespace differences are allowed. An optional target is informational only and does not affect evidence, routing, or familiarity. This records a practice pattern, not evidence or mastery.",
		parameters: notePatternSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems: string[] = [];
			if (!input.subject.trim() || input.subject.length > LEARNER_LIMITS.patternSubjectChars) {
				problems.push(`subject must be non-empty and at most ${LEARNER_LIMITS.patternSubjectChars} characters`);
			}
			if (!input.pattern.trim() || input.pattern.length > LEARNER_LIMITS.patternChars) {
				problems.push(`pattern must be non-empty and at most ${LEARNER_LIMITS.patternChars} characters`);
			}
			if (!input.quote.trim() || input.quote.length > LEARNER_LIMITS.patternQuoteChars) {
				problems.push(`quote must be non-empty and at most ${LEARNER_LIMITS.patternQuoteChars} characters`);
			}
			if (problems.length) return invalidInputResult("note_pattern", problems);
			return await note(input);
		},
	};
}
