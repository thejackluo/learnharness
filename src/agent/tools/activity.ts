import type { AgentTool } from "@earendil-works/pi-agent-core";
import { activityInputSchema, activityProblems, normalizeActivity, resolveTeachingStimulus, type TeachingStimulusRef } from "../../core/activity.ts";
import type { CaseComparisonActivityV1 } from "../../core/contracts/activity.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult } from "../tool-execute.ts";

/** Activities posted earlier in THIS turn (their results are not persisted
 *  until the turn ends). Per-request: one registry, one chat. */
export type PostedActivities = Map<string, CaseComparisonActivityV1>;

interface ActivityContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
}

export function activityTool(posted: PostedActivities): AgentTool<typeof activityInputSchema> {
	return {
		name: "activity",
		label: "activity",
		description:
			"Post an interactive compare-cases line plot the app renders itself from your finite data: an objective, instructions, " +
			"2–8 selectable cases, each with 1–4 series of precomputed (x, y) points, plus a useful text alternative. The learner " +
			"switches cases and sees the plot, a data table and the text change. Data only: no formulas, HTML, SVG, URLs or code. " +
			"It does not end your turn. To have the learner explain what they observed, pose ONE explain with " +
			"stimulus {kind: 'teaching-stimulus', toolCallId: <this call's id>}. Exploring is never evidence; only the explanation is assessed.",
		parameters: activityInputSchema,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const problems = activityProblems(input);
			if (problems.length > 0) return invalidInputResult("activity", problems);
			const activity = normalizeActivity(input);
			posted.set(toolCallId, activity);
			return {
				content: [{ type: "text", text: JSON.stringify({ posted: true, toolCallId, cases: activity.cases.map((c) => c.id), stimulus: { kind: "teaching-stimulus", toolCallId } }) }],
				details: activity as unknown as Record<string, never>,
			};
		},
	};
}

/** Pose-time check of an explanation's stimulus: the exact activity call,
 *  this chat, successful — posted this turn or persisted earlier. */
export function stimulusPoseProblem(ctx: ActivityContext, posted: PostedActivities, ref: TeachingStimulusRef | undefined): string | undefined {
	// A this-turn activity wins: its raw provider id may repeat an older one,
	// and settlement rewrites this reference to the activity's minted id
	// (server/pi/call-ids.ts).
	if (!ref || posted.has(ref.toolCallId)) return undefined;
	const resolved = resolveTeachingStimulus(ctx.chatStore.getChat(ctx.chatId)?.messages ?? [], ref);
	return resolved.ok ? undefined : `stimulus: ${resolved.problem}`;
}
