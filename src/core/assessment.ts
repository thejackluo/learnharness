import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AssessmentSpecV1, CriterionAward, CriterionOutcome } from "./contracts/assessment.ts";

const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$" });
const text = Type.String({ minLength: 1, maxLength: 4000 });
export const assessmentPartsSchema = Type.Array(Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	criteria: Type.Array(Type.Object({ id, description: text, maxPoints: Type.Number({ exclusiveMinimum: 0, maximum: 100 }), expectedEvidence: text }), { minItems: 1, maxItems: 8 }),
}), { minItems: 1, maxItems: 8 });

export const assessmentDisplayPartsSchema = Type.Array(Type.Object({
	id: Type.String(), label: Type.Optional(Type.String()), prompt: Type.String(),
	criteria: Type.Array(Type.Object({ id: Type.String(), description: Type.String(), maxPoints: Type.Number({ exclusiveMinimum: 0 }), expectedEvidence: Type.String() }), { minItems: 1 }),
}), { minItems: 1 });

export function assessmentSpecProblems(parts: unknown): string[] {
	if (parts === undefined) return [];
	if (!Value.Check(assessmentPartsSchema, parts)) return ["parts must contain 1–8 labelled prompts with bounded criteria and positive finite maxima"];
	const problems: string[] = [];
	const partIds = new Set<string>();
	const criterionIds = new Set<string>();
	for (const part of parts) {
		if (partIds.has(part.id)) problems.push(`duplicate part ${part.id}`);
		partIds.add(part.id);
		if (!part.prompt.trim()) problems.push("empty part prompt");
		for (const c of part.criteria) {
			if (criterionIds.has(c.id)) problems.push(`duplicate criterion ${c.id}`);
			criterionIds.add(c.id);
			if (!Number.isFinite(c.maxPoints) || !c.description.trim() || !c.expectedEvidence.trim()) problems.push(`invalid criterion ${c.id}`);
		}
	}
	if (criterionIds.size > 32) problems.push("at most 32 criteria are allowed");
	return problems;
}

export function assessmentSpecOf(input: unknown): AssessmentSpecV1 | undefined {
	if (!input || typeof input !== "object" || !("parts" in input) || input.parts === undefined) return undefined;
	if (!Value.Check(assessmentDisplayPartsSchema, input.parts)) return undefined;
	const partIds = input.parts.map(p => p.id);
	const criteria = input.parts.flatMap(p => p.criteria);
	if (new Set(partIds).size !== partIds.length || new Set(criteria.map(c => c.id)).size !== criteria.length || criteria.some(c => !Number.isFinite(c.maxPoints))) return undefined;
	return { version: 1, parts: structuredClone(input.parts) as AssessmentSpecV1["parts"] };
}

export function criterionOutcome(award: number | null, max: number): CriterionOutcome {
	return award === null ? "unassessed" : award === max ? "met" : award > 0 ? "partial" : "not_met";
}

export function evaluationProblems(spec: AssessmentSpecV1, awards: readonly CriterionAward[]): string[] {
	const criteria = spec.parts.flatMap(p => p.criteria);
	const problems: string[] = [];
	if (!Array.isArray(awards) || awards.length !== criteria.length) return ["list every committed criterion exactly once"];
	const seen = new Set<string>();
	for (const a of awards) {
		if (!a || typeof a !== "object") { problems.push("invalid criterion award"); continue; }
		const c = criteria.find(c => c.id === a.criterionId);
		if (!c || seen.has(a.criterionId)) problems.push("unknown or duplicate criterion");
		seen.add(a.criterionId);
		if (a.award !== null && (typeof a.award !== "number" || !Number.isFinite(a.award) || a.award < 0 || (c && a.award > c.maxPoints))) problems.push("award outside committed bounds");
		if (typeof a.feedback !== "string" || !a.feedback.trim() || a.feedback.length > 4000) problems.push("feedback is required and bounded");
	}
	return problems;
}

export function scoreEvaluation(spec: AssessmentSpecV1, awards: readonly CriterionAward[]) {
	const problems = evaluationProblems(spec, awards);
	if (problems.length) throw new Error(problems.join("; "));
	const criteria = spec.parts.flatMap(p => p.criteria.map(c => {
		const a = awards.find(a => a.criterionId === c.id)!;
		return { ...a, partId: p.id, maxPoints: c.maxPoints, outcome: criterionOutcome(a.award, c.maxPoints) };
	}));
	const assessed = criteria.filter(c => c.award !== null);
	return { criteria, totals: { awarded: assessed.reduce((n, c) => n + c.award!, 0), assessedMax: assessed.reduce((n, c) => n + c.maxPoints, 0), max: criteria.reduce((n, c) => n + c.maxPoints, 0), assessedCount: assessed.length, criterionCount: criteria.length, complete: assessed.length === criteria.length } };
}
