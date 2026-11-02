import type { LearningTargetRef } from "./learning-target.ts";

export interface AssessmentCriterion {
	id: string;
	description: string;
	maxPoints: number;
	expectedEvidence: string;
}
export interface AssessmentPart {
	id: string;
	label?: string;
	prompt: string;
	criteria: AssessmentCriterion[];
}
export interface AssessmentSpecV1 {
	version: 1;
	parts: AssessmentPart[];
	target?: LearningTargetRef;
	stimulus?: { kind: "teaching-stimulus"; messageId: string; toolCallId?: string };
}
export type CriterionOutcome = "met" | "partial" | "not_met" | "unassessed";
export interface CriterionAward {
	criterionId: string;
	award: number | null;
	feedback: string;
}
export interface AssessmentTotals {
	awarded: number;
	assessedMax: number;
	max: number;
	assessedCount: number;
	criterionCount: number;
	complete: boolean;
}
export interface AssessmentEvaluationV1 {
	version: 1;
	sourceCallId: string;
	responseId: string;
	evaluationId: string;
	provenance: "deterministic" | "modelJudged";
	spec: AssessmentSpecV1;
	criteria: (CriterionAward & { partId: string; maxPoints: number; outcome: CriterionOutcome })[];
	totals: AssessmentTotals;
	summary?: string;
}
