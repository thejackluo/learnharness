import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTeachingStimulus, teachingStimulusRefOf } from "../../core/activity.ts";
import { assessmentSpecOf, evaluationProblems, modelJudgedSpec, scoreEvaluation } from "../../core/assessment.ts";
import type { AssessmentEvaluationV1 } from "../../core/contracts/assessment.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult } from "../tool-execute.ts";

export const evaluateInputSchema = Type.Object({
	sourceCallId: Type.String({ minLength: 1 }),
	responseId: Type.String({ minLength: 1 }),
	criteria: Type.Array(Type.Object({ criterionId: Type.String(), award: Type.Union([Type.Number({ description: "Points in increments of 0.01 (at most two decimal places)." }), Type.Null()]), feedback: Type.String({ minLength: 1, maxLength: 4000 }) }), { minItems: 1, maxItems: 32 }),
	summary: Type.Optional(Type.String({ maxLength: 4000 })),
});

export function evaluateTool(ctx: { chatId: string; chatStore: { getChat(id: string): { messages: LhMessage[] } | null } }): AgentTool<typeof evaluateInputSchema> {
	const evaluated = new Set<string>();
	return {
		name: "evaluate", label: "evaluate",
		description: "Record criterion awards and feedback for a submitted response to a committed explain, recall, or problem rubric. Reference the source tool call and the responseId supplied with the response. List every model-judged criterion exactly once; null means unassessed. Numeric and exact parts are already auto-graded by the app and must not be listed. Awards are bounded by the committed maxima. A response can be evaluated once. The server validates references and bounds, not the truth of the judgment.",
		parameters: evaluateInputSchema, executionMode: "sequential",
		execute: async (evaluationId, input: Static<typeof evaluateInputSchema>) => {
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const calls = messages.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall") : []);
			const source = calls.find(c => c.id === input.sourceCallId);
			const rubric = source && ["explain", "recall", "problem"].includes(source.name) ? assessmentSpecOf(source.arguments) : undefined;
			const spec = rubric ? modelJudgedSpec(rubric) : undefined;
			if (!source || !rubric) return invalidInputResult("evaluate", ["source must be a persisted rubric-bearing explain, recall, or problem call"]);
			if (!spec) return invalidInputResult("evaluate", ["this source has only auto-graded parts"]);
			const ref = source.name === "explain" ? teachingStimulusRefOf(source.arguments) : undefined;
			const stimulus = ref ? resolveTeachingStimulus(messages, ref) : undefined;
			if (stimulus && !stimulus.ok) return invalidInputResult("evaluate", [`source stimulus unavailable: ${stimulus.problem}`]);
			const attributedSpec = stimulus?.ok ? { ...spec, stimulus: { kind: stimulus.snapshot.kind, messageId: stimulus.snapshot.messageId, toolCallId: stimulus.snapshot.toolCallId } } : spec;
			const response = messages.find(m => m.id === input.responseId);
			const successfulSource = messages.some(m => m.role === "toolResult" && m.toolCallId === source.id && !m.isError);
			const answer = response?.role === "toolResult" ? response.details as { kind?: unknown; dismissed?: unknown } | undefined : undefined;
			const thinking = response?.role === "custom" && response.customType === "practice-thinking" ? response.details as { problemCallId?: unknown } : undefined;
			const validResponse = source.name === "problem"
				? thinking?.problemCallId === source.id
				: response?.role === "toolResult" && response.toolCallId === source.id && response.toolName === source.name && !response.isError && answer?.kind === "explain" && !answer.dismissed;
			if (!successfulSource || !validResponse) return invalidInputResult("evaluate", ["responseId must identify the submitted, non-dismissed response to this source"]);
			if (evaluated.has(input.responseId) || messages.some(m => m.role === "toolResult" && m.toolName === "evaluate" && !m.isError && (m.details as { responseId?: unknown } | undefined)?.responseId === input.responseId)) return invalidInputResult("evaluate", ["response already evaluated"]);
			const problems = evaluationProblems(attributedSpec, input.criteria);
			if (problems.length) return invalidInputResult("evaluate", problems);
			const evaluation: AssessmentEvaluationV1 = { version: 1, sourceCallId: source.id, responseId: input.responseId, evaluationId, provenance: "modelJudged", spec: attributedSpec, ...scoreEvaluation(attributedSpec, input.criteria), ...(input.summary ? { summary: input.summary } : {}) };
			evaluated.add(input.responseId);
			return { content: [{ type: "text", text: JSON.stringify({ evaluationId, responseId: input.responseId, ...evaluation.totals }) }], details: evaluation as unknown as Record<string, never> };
		},
	};
}
