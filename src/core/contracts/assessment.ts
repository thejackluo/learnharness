import type { LearningTargetRef } from "./learning-target.ts";

export interface AssessmentCriterion {
	id: string;
	description: string;
	maxPoints: number;
	expectedEvidence: string;
}

export type AssessmentPartKind = "numeric" | "exact" | "structured" | "code";
export interface NumericUnit {
	symbol: string;
	factor: number;
}
export interface NumericTolerance {
	kind: "absolute" | "relative";
	value: number;
}
export type ExactNormalize = "nfkc-trim-casefold" | "nfkc-trim";
export interface StructuredField {
	id: string;
	label: string;
	kind: "line" | "paragraph";
}
export interface CodeTest {
	id: string;
	name: string;
	call: string;
	expected: string;
}
export interface CodeTestResult {
	testId: string;
	status: "pass" | "fail" | "error" | "timeout";
	actual?: string;
	error?: string;
	stdout?: string;
}
interface AssessmentPartBase {
	id: string;
	label?: string;
	prompt: string;
}
export type AssessmentPart =
	| (AssessmentPartBase & { kind?: undefined; criteria: AssessmentCriterion[] })
	| (AssessmentPartBase & { kind: "numeric"; answer: number; units: NumericUnit[]; tolerance: NumericTolerance; criteria: AssessmentCriterion[] })
	| (AssessmentPartBase & { kind: "exact"; accepted: string[]; normalize: ExactNormalize; criteria: AssessmentCriterion[] })
	| (AssessmentPartBase & { kind: "structured"; fields: StructuredField[]; criteria: AssessmentCriterion[] })
	| (AssessmentPartBase & { kind: "code"; language: "python"; starter: string; tests: CodeTest[]; timeLimitMs: number; criteria: AssessmentCriterion[] });
export interface AssessmentSpecV1 {
	version: 1;
	parts: AssessmentPart[];
	target?: LearningTargetRef;
	stimulus?: { kind: "teaching-stimulus"; messageId: string; toolCallId?: string };
}
export type AssessmentPartResponse =
	| { partId: string; kind: "numeric"; value: number; unit: string }
	| { partId: string; kind: "exact"; text: string }
	| { partId: string; kind: "structured"; fields: { id: string; text: string }[] }
	| { partId: string; kind: "code"; source: string; results: CodeTestResult[] };
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
	provenance: "deterministic" | "modelJudged" | "clientExecuted";
	spec: AssessmentSpecV1;
	criteria: (CriterionAward & { partId: string; maxPoints: number; outcome: CriterionOutcome })[];
	totals: AssessmentTotals;
	summary?: string;
}
