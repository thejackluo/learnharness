import { Type } from "typebox";
import { Value } from "typebox/value";
import { healEncodedArguments } from "./argument-heal.ts";
import type { AssessmentSpecV1, CriterionAward, CriterionOutcome } from "./contracts/assessment.ts";

const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$" });
const text = Type.String({ minLength: 1, maxLength: 4000 });
export const assessmentPartsSchema = Type.Array(Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	criteria: Type.Array(Type.Object({ id, description: text, maxPoints: Type.Number({ exclusiveMinimum: 0, maximum: 100, description: "Points in increments of 0.01 (at most two decimal places)." }), expectedEvidence: text }), { minItems: 1, maxItems: 8 }),
}), { minItems: 1, maxItems: 8 });

export const assessmentDisplayPartsSchema = Type.Array(Type.Object({
	id: Type.String(), label: Type.Optional(Type.String()), prompt: Type.String(),
	criteria: Type.Array(Type.Object({ id: Type.String(), description: Type.String(), maxPoints: Type.Number({ exclusiveMinimum: 0 }), expectedEvidence: Type.String() }), { minItems: 1 }),
}), { minItems: 1 });

function hasHundredthPrecision(points: number): boolean {
	const hundredths = Math.round(points * 100);
	return Number.isFinite(points) && (points === 0 || hundredths !== 0) && Math.abs(points * 100 - hundredths) < 1e-9;
}

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
			if (!hasHundredthPrecision(c.maxPoints)) problems.push(`criterion ${c.id} maxPoints must use increments of 0.01`);
			if (!c.description.trim() || !c.expectedEvidence.trim()) problems.push(`invalid criterion ${c.id}`);
		}
	}
	if (criterionIds.size > 32) problems.push("at most 32 criteria are allowed");
	return problems;
}

export function assessmentSpecOf(input: unknown): AssessmentSpecV1 | undefined {
	if (!input || typeof input !== "object" || !("parts" in input) || input.parts === undefined) return undefined;
	const healed = healEncodedArguments(input, Type.Object({ parts: assessmentDisplayPartsSchema })) as { parts: unknown };
	const parts = structuredClone(healed.parts);
	Value.Convert(assessmentDisplayPartsSchema, parts);
	if (!Value.Check(assessmentDisplayPartsSchema, parts)) return undefined;
	const partIds = parts.map(p => p.id);
	const criteria = parts.flatMap(p => p.criteria);
	if (new Set(partIds).size !== partIds.length || new Set(criteria.map(c => c.id)).size !== criteria.length || criteria.some(c => !Number.isFinite(c.maxPoints))) return undefined;
	return { version: 1, parts };
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
		if (a.award !== null && (typeof a.award !== "number" || !hasHundredthPrecision(a.award) || a.award < 0 || (c && a.award > c.maxPoints))) problems.push("award must be within committed bounds in increments of 0.01");
		if (typeof a.feedback !== "string" || !a.feedback.trim() || a.feedback.length > 4000) problems.push("feedback is required and bounded");
	}
	return problems;
}

export function sumAssessmentPoints(points: readonly number[]): number {
	return points.reduce((sum, points) => sum + Math.round(points * 100), 0) / 100;
}

export function scoreEvaluation(spec: AssessmentSpecV1, awards: readonly CriterionAward[]) {
	const problems = evaluationProblems(spec, awards);
	if (problems.length) throw new Error(problems.join("; "));
	const criteria = spec.parts.flatMap(p => p.criteria.map(c => {
		const a = awards.find(a => a.criterionId === c.id)!;
		return { ...a, partId: p.id, maxPoints: c.maxPoints, outcome: criterionOutcome(a.award, c.maxPoints) };
	}));
	const assessed = criteria.filter(c => c.award !== null);
	return { criteria, totals: { awarded: sumAssessmentPoints(assessed.map(c => c.award!)), assessedMax: sumAssessmentPoints(assessed.map(c => c.maxPoints)), max: sumAssessmentPoints(criteria.map(c => c.maxPoints)), assessedCount: assessed.length, criterionCount: criteria.length, complete: assessed.length === criteria.length } };
}
