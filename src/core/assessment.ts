import { Type } from "typebox";
import { Value } from "typebox/value";
import { healEncodedArguments } from "./argument-heal.ts";
import type {
	AssessmentEvaluationV1,
	AssessmentPart,
	AssessmentPartResponse,
	AssessmentSpecV1,
	CriterionAward,
	CriterionOutcome,
	ExactNormalize,
	NumericTolerance,
} from "./contracts/assessment.ts";

const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$" });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const points = Type.Number({ exclusiveMinimum: 0, maximum: 100, description: "Points in increments of 0.01 (at most two decimal places)." });
const criterion = Type.Object({ id, description: text, maxPoints: points, expectedEvidence: text });
const freePart = Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	kind: Type.Optional(Type.Literal("free", { description: "A free-response part graded against its criteria." })),
	criteria: Type.Array(criterion, { minItems: 1, maxItems: 8 }),
});
const numericPart = Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	kind: Type.Literal("numeric", { description: "A number with a declared unit, graded deterministically by the app." }),
	answer: Type.Number({ description: "The committed answer in the canonical first unit. Must be finite; expressions are not evaluated." }),
	units: Type.Array(Type.Object({
		symbol: Type.String({ minLength: 1, maxLength: 20, description: "A unit symbol the learner may select or type; unit parsing is not performed." }),
		factor: Type.Number({ exclusiveMinimum: 0, description: "Conversion factor to the canonical first unit. The first unit must have factor 1." }),
	}), { minItems: 1, maxItems: 12, description: "Declared units. The first unit is canonical and has factor 1." }),
	tolerance: Type.Object({
		kind: Type.Union([Type.Literal("absolute"), Type.Literal("relative")], { description: "Absolute distance or a fraction of the absolute answer." }),
		value: Type.Number({ minimum: 0, description: "Nonnegative tolerance; relative tolerance is a fraction (0.01 means 1%)." }),
	}),
	points,
});
const exactPart = Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	kind: Type.Literal("exact", { description: "A response matched against accepted text after the declared normalization." }),
	accepted: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20, description: "Accepted answers; whitespace-only entries are invalid after normalization." }),
	normalize: Type.Union([Type.Literal("nfkc-trim-casefold"), Type.Literal("nfkc-trim")], { description: "NFKC normalization and trimming, optionally with case folding." }),
	points,
});
const structuredPart = Type.Object({
	id,
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	prompt: text,
	kind: Type.Literal("structured", { description: "A free-response part with named fields, graded against criteria." }),
	fields: Type.Array(Type.Object({
		id,
		label: Type.String({ minLength: 1, maxLength: 120, description: "Visible, accessible label for this answer field." }),
		kind: Type.Union([Type.Literal("line"), Type.Literal("paragraph")], { description: "Single-line input or paragraph textarea." }),
	}), { minItems: 1, maxItems: 8, description: "Named fields the learner fills in; field ids must be unique within this part." }),
	criteria: Type.Array(criterion, { minItems: 1, maxItems: 8 }),
});

export const freeAssessmentPartsSchema = Type.Array(freePart, { minItems: 1, maxItems: 8 });
export const assessmentPartsSchema = Type.Array(Type.Union([freePart, numericPart, exactPart, structuredPart]), { minItems: 1, maxItems: 8 });

const displayCriterion = Type.Object({
	id: Type.String(),
	description: Type.String(),
	maxPoints: Type.Number({ exclusiveMinimum: 0 }),
	expectedEvidence: Type.String(),
});
const displayBase = {
	id: Type.String(),
	label: Type.Optional(Type.String()),
	prompt: Type.String(),
};
const displayFreePart = Type.Object({
	...displayBase,
	kind: Type.Optional(Type.Literal("free")),
	criteria: Type.Array(displayCriterion, { minItems: 1 }),
});
const displayNumericPart = Type.Object({
	...displayBase,
	kind: Type.Literal("numeric"),
	answer: Type.Number(),
	units: Type.Array(Type.Object({ symbol: Type.String(), factor: Type.Number() }), { minItems: 1 }),
	tolerance: Type.Object({ kind: Type.Union([Type.Literal("absolute"), Type.Literal("relative")]), value: Type.Number() }),
	points: Type.Number(),
});
const displayExactPart = Type.Object({
	...displayBase,
	kind: Type.Literal("exact"),
	accepted: Type.Array(Type.String(), { minItems: 1 }),
	normalize: Type.Union([Type.Literal("nfkc-trim-casefold"), Type.Literal("nfkc-trim")]),
	points: Type.Number(),
});
const displayStructuredPart = Type.Object({
	...displayBase,
	kind: Type.Literal("structured"),
	fields: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), kind: Type.Union([Type.Literal("line"), Type.Literal("paragraph")]) }), { minItems: 1 }),
	criteria: Type.Array(displayCriterion, { minItems: 1 }),
});
export const assessmentDisplayPartsSchema = Type.Array(
	Type.Union([displayFreePart, displayNumericPart, displayExactPart, displayStructuredPart]),
	{ minItems: 1 },
);

function hasHundredthPrecision(value: number): boolean {
	const hundredths = Math.round(value * 100);
	return Number.isFinite(value) && (value === 0 || hundredths !== 0) && Math.abs(value * 100 - hundredths) < 1e-9;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isAutoGradedPart(part: AssessmentPart): part is Extract<AssessmentPart, { kind: "numeric" | "exact" }> {
	return part.kind === "numeric" || part.kind === "exact";
}

function partCriteria(part: unknown): Array<{ id: string; description: string; maxPoints: number; expectedEvidence: string }> {
	if (!isRecord(part)) return [];
	if (part.kind === "numeric" && typeof part.answer === "number" && Array.isArray(part.units) && isRecord(part.tolerance)) {
		const canonical = part.units[0];
		if (!isRecord(canonical) || typeof canonical.symbol !== "string") return [];
		const tolerance = part.tolerance as unknown as NumericTolerance;
		const maxPoints = part.points as number;
		const allowed = tolerance.kind === "relative"
			? `within ${Number((tolerance.value * 100).toPrecision(8))}% relative`
			: `±${tolerance.value} absolute`;
		return [{
			id: part.id as string,
			description: "Correct value and unit",
			maxPoints,
			expectedEvidence: `${part.answer} ${canonical.symbol} (${allowed})`,
		}];
	}
	if (part.kind === "exact" && Array.isArray(part.accepted) && typeof part.normalize === "string") {
		return [{
			id: part.id as string,
			description: "Exact answer",
			maxPoints: part.points as number,
			expectedEvidence: `Accepted: ${(part.accepted as string[]).join(", ")} (${part.normalize})`,
		}];
	}
	return Array.isArray(part.criteria) ? part.criteria as Array<{ id: string; description: string; maxPoints: number; expectedEvidence: string }> : [];
}

function normalizedPart(raw: Record<string, unknown>): AssessmentPart | undefined {
	if (raw.kind === "free" || raw.kind === undefined) {
		const { kind: _kind, ...free } = raw;
		if (!Value.Check(displayFreePart, free)) return undefined;
		return free as unknown as AssessmentPart;
	}
	if (raw.kind === "numeric") {
		if (!Value.Check(displayNumericPart, raw)) return undefined;
		const criteria = partCriteria(raw);
		const { points: _points, ...normalized } = raw;
		return { ...normalized, criteria } as unknown as AssessmentPart;
	}
	if (raw.kind === "exact") {
		if (!Value.Check(displayExactPart, raw)) return undefined;
		const criteria = partCriteria(raw);
		const { points: _points, ...normalized } = raw;
		return { ...normalized, criteria } as unknown as AssessmentPart;
	}
	if (raw.kind === "structured") {
		if (!Value.Check(displayStructuredPart, raw)) return undefined;
		return raw as unknown as AssessmentPart;
	}
	return undefined;
}

export function assessmentSpecProblems(parts: unknown): string[] {
	if (parts === undefined) return [];
	if (!Value.Check(assessmentPartsSchema, parts)) return ["parts must contain 1–8 labelled prompts with bounded criteria and positive finite maxima"];
	const problems: string[] = [];
	const partIds = new Set<string>();
	const criterionIds = new Set<string>();
	const candidates = parts as Array<Record<string, unknown>>;
	for (const part of candidates) {
		const partId = part.id as string;
		if (partIds.has(partId)) problems.push(`duplicate part ${partId}`);
		partIds.add(partId);
		if (!(part.prompt as string).trim()) problems.push("empty part prompt");
		if (part.kind === "numeric") {
			const units = part.units as Array<{ symbol: string; factor: number }>;
			if (!Number.isFinite(part.answer)) problems.push(`numeric part ${partId} answer must be finite`);
			if (units[0]?.factor !== 1) problems.push(`numeric part ${partId} first unit factor must be 1`);
			const symbols = new Set<string>();
			for (const unit of units) {
				if (!Number.isFinite(unit.factor) || unit.factor <= 0) problems.push(`numeric part ${partId} unit factors must be finite and positive`);
				const symbol = unit.symbol.normalize("NFKC").trim();
				if (!symbol) problems.push(`numeric part ${partId} unit symbols must not be blank`);
				if (symbols.has(symbol)) problems.push(`numeric part ${partId} unit symbols must be unique`);
				symbols.add(symbol);
			}
			const tolerance = part.tolerance as { kind: string; value: number };
			if (!Number.isFinite(tolerance.value) || tolerance.value < 0) problems.push(`numeric part ${partId} tolerance must be finite and nonnegative`);
			if (!hasHundredthPrecision(part.points as number)) problems.push(`numeric part ${partId} points must use increments of 0.01`);
		} else if (part.kind === "exact") {
			const normalize = part.normalize as ExactNormalize;
			if ((part.accepted as string[]).some(answer => !normalizeExact(answer, normalize))) problems.push(`exact part ${partId} accepted answers must not be blank after normalization`);
			if (!hasHundredthPrecision(part.points as number)) problems.push(`exact part ${partId} points must use increments of 0.01`);
		} else {
			if (part.kind === "structured") {
				const fieldIds = new Set<string>();
				for (const field of part.fields as Array<{ id: string }>) {
					if (fieldIds.has(field.id)) problems.push(`duplicate structured field ${field.id} in part ${partId}`);
					fieldIds.add(field.id);
				}
			}
			for (const c of part.criteria as Array<{ id: string; description: string; maxPoints: number; expectedEvidence: string }>) {
				if (criterionIds.has(c.id)) problems.push(`duplicate criterion ${c.id}`);
				criterionIds.add(c.id);
				if (!hasHundredthPrecision(c.maxPoints)) problems.push(`criterion ${c.id} maxPoints must use increments of 0.01`);
				if (!c.description.trim() || !c.expectedEvidence.trim()) problems.push(`invalid criterion ${c.id}`);
			}
		}
	}
	for (const part of candidates) {
		if (part.kind === "numeric" || part.kind === "exact") {
			const partId = part.id as string;
			if (criterionIds.has(partId)) problems.push(`duplicate criterion ${partId}`);
			criterionIds.add(partId);
		}
	}
	if (criterionIds.size > 32) problems.push("at most 32 criteria are allowed");
	return problems;
}

export function assessmentSpecOf(input: unknown): AssessmentSpecV1 | undefined {
	if (!isRecord(input) || !("parts" in input) || input.parts === undefined) return undefined;
	const healed = healEncodedArguments(input, Type.Object({ parts: assessmentDisplayPartsSchema })) as { parts: unknown };
	const rawParts = structuredClone(healed.parts);
	Value.Convert(assessmentDisplayPartsSchema, rawParts);
	if (!Value.Check(assessmentDisplayPartsSchema, rawParts) || !Array.isArray(rawParts)) return undefined;
	const parts = rawParts.map(part => isRecord(part) ? normalizedPart(part) : undefined);
	if (parts.some(part => !part)) return undefined;
	const normalized = parts as AssessmentPart[];
	const partIds = normalized.map(part => part.id);
	const criterionIds = normalized.flatMap(part => part.criteria.map(c => c.id));
	if (
		new Set(partIds).size !== partIds.length ||
		new Set(criterionIds).size !== criterionIds.length ||
		criterionIds.some(id => !Number.isFinite(normalized.flatMap(p => p.criteria).find(c => c.id === id)?.maxPoints))
	) return undefined;
	if (normalized.some(part => part.kind === "numeric" && (
		!Number.isFinite(part.answer) ||
		part.units[0]?.factor !== 1 ||
		part.units.some(unit => !Number.isFinite(unit.factor) || unit.factor <= 0 || !unit.symbol.normalize("NFKC").trim()) ||
		new Set(part.units.map(unit => unit.symbol.normalize("NFKC").trim())).size !== part.units.length ||
		!Number.isFinite(part.tolerance.value) || part.tolerance.value < 0
	))) return undefined;
	if (normalized.some(part => part.kind === "exact" && part.accepted.some(answer => !normalizeExact(answer, part.normalize)))) return undefined;
	if (normalized.some(part => part.kind === "structured" && new Set(part.fields.map(field => field.id)).size !== part.fields.length)) return undefined;
	return { version: 1, parts: normalized };
}

function specSubset(spec: AssessmentSpecV1, parts: AssessmentPart[]): AssessmentSpecV1 | undefined {
	return parts.length ? { version: 1, parts, ...(spec.target ? { target: spec.target } : {}), ...(spec.stimulus ? { stimulus: spec.stimulus } : {}) } : undefined;
}

export function autoGradedSpec(spec: AssessmentSpecV1): AssessmentSpecV1 | undefined {
	return specSubset(spec, spec.parts.filter(isAutoGradedPart));
}

export function modelJudgedSpec(spec: AssessmentSpecV1): AssessmentSpecV1 | undefined {
	return specSubset(spec, spec.parts.filter(part => !isAutoGradedPart(part)));
}

export function specNeedsSharedText(spec: AssessmentSpecV1): boolean {
	return spec.parts.some(part => part.kind === undefined);
}

export function normalizeExact(value: string, mode: ExactNormalize): string {
	const normalized = value.normalize("NFKC").trim();
	return mode === "nfkc-trim-casefold" ? normalized.toUpperCase().toLowerCase() : normalized;
}

type NumericPart = Extract<AssessmentPart, { kind: "numeric" }>;
type ExactPart = Extract<AssessmentPart, { kind: "exact" }>;

export function gradeNumeric(part: NumericPart, value: number, unit: string): CriterionAward {
	const normalizedUnit = typeof unit === "string" ? unit.normalize("NFKC").trim() : "";
	const selected = part.units.find(candidate => candidate.symbol.normalize("NFKC").trim() === normalizedUnit);
	const criterion = part.criteria[0]!;
	if (!normalizedUnit || !selected) return { criterionId: criterion.id, award: 0, feedback: "Unit: missing or not one of the listed units." };
	if (!Number.isFinite(value)) return { criterionId: criterion.id, award: 0, feedback: "Value: expected a finite number." };
	const canonical = value * selected.factor;
	if (!Number.isFinite(canonical)) return { criterionId: criterion.id, award: 0, feedback: "Value: outside the committed tolerance." };
	const tolerance = part.tolerance.kind === "relative"
		? part.answer === 0 ? 1e-9 : part.tolerance.value * Math.abs(part.answer)
		: part.tolerance.value;
	const slack = 1e-12 * Math.max(1, Math.abs(part.answer), Math.abs(canonical));
	if (Math.abs(canonical - part.answer) > tolerance + slack) return { criterionId: criterion.id, award: 0, feedback: "Value: outside the committed tolerance." };
	return { criterionId: criterion.id, award: criterion.maxPoints, feedback: "Correct." };
}

export function gradeExact(part: ExactPart, value: string): CriterionAward {
	const accepted = new Set(part.accepted.map(answer => normalizeExact(answer, part.normalize)));
	const criterion = part.criteria[0]!;
	return accepted.has(normalizeExact(value, part.normalize))
		? { criterionId: criterion.id, award: criterion.maxPoints, feedback: "Correct." }
		: { criterionId: criterion.id, award: 0, feedback: "Not an accepted answer." };
}

export function partResponseProblems(spec: AssessmentSpecV1, responses: unknown): string[] {
	const typed = spec.parts.filter(part => part.kind !== undefined);
	if (!typed.length) return responses === undefined || Array.isArray(responses) && responses.length === 0 ? [] : ["partResponses must be absent or empty when no typed parts are committed"];
	if (!Array.isArray(responses)) return ["partResponses must be an array"];
	if (responses.length !== typed.length) return ["provide exactly one response for every typed part"];
	const known = new Map(typed.map(part => [part.id, part]));
	const seen = new Set<string>();
	const problems: string[] = [];
	for (const response of responses) {
		if (!isRecord(response) || typeof response.partId !== "string" || !known.has(response.partId)) {
			problems.push("partResponses contains an unknown partId");
			continue;
		}
		if (seen.has(response.partId)) problems.push(`duplicate response for part ${response.partId}`);
		seen.add(response.partId);
		const part = known.get(response.partId)!;
		if (response.kind !== part.kind) {
			problems.push(`response kind does not match part ${part.id}`);
			continue;
		}
		if (part.kind === "numeric") {
			if (typeof response.value !== "number" || !Number.isFinite(response.value)) problems.push(`numeric response for ${part.id} must be finite`);
			if (typeof response.unit !== "string" || response.unit.length > 20) problems.push(`numeric response unit for ${part.id} must be at most 20 characters`);
		} else if (part.kind === "exact") {
			if (typeof response.text !== "string" || !response.text.trim() || response.text.length > 200) problems.push(`exact response for ${part.id} must be nonblank and at most 200 characters`);
		} else {
			if (!Array.isArray(response.fields)) {
				problems.push(`structured response for ${part.id} must contain fields`);
				continue;
			}
			const declared = new Map(part.fields.map(field => [field.id, field]));
			const seenFields = new Set<string>();
			for (const field of response.fields) {
				if (!isRecord(field) || typeof field.id !== "string" || !declared.has(field.id)) {
					problems.push(`structured response for ${part.id} contains an unknown field`);
					continue;
				}
				if (seenFields.has(field.id)) problems.push(`duplicate structured response field ${field.id}`);
				seenFields.add(field.id);
				const definition = declared.get(field.id)!;
				const maxLength = definition.kind === "line" ? 500 : 4000;
				if (typeof field.text !== "string" || field.text.length > maxLength) problems.push(`structured field ${field.id} text must be at most ${maxLength} characters`);
			}
			if (seenFields.size !== declared.size) problems.push(`structured response for ${part.id} must include every declared field exactly once`);
			if (!response.fields.some(field => isRecord(field) && typeof field.text === "string" && field.text.trim())) {
				problems.push(`structured response for ${part.id} must contain at least one nonblank field`);
			}
		}
	}
	if (seen.size !== known.size) problems.push("partResponses must include every typed part exactly once");
	return problems;
}

export function autoEvaluate(
	spec: AssessmentSpecV1,
	responses: unknown,
	ids: { sourceCallId: string; responseId: string },
): AssessmentEvaluationV1 | undefined {
	const graded = autoGradedSpec(spec);
	if (!graded || partResponseProblems(spec, responses).length) return undefined;
	const byPart = new Map((responses as AssessmentPartResponse[]).map(response => [response.partId, response]));
	const awards = graded.parts.map(part => {
		const response = byPart.get(part.id)!;
		return part.kind === "numeric"
			? gradeNumeric(part, (response as Extract<AssessmentPartResponse, { kind: "numeric" }>).value, (response as Extract<AssessmentPartResponse, { kind: "numeric" }>).unit)
			: gradeExact(part as ExactPart, (response as Extract<AssessmentPartResponse, { kind: "exact" }>).text);
	});
	return {
		version: 1,
		sourceCallId: ids.sourceCallId,
		responseId: ids.responseId,
		evaluationId: `auto:${ids.responseId}`,
		provenance: "deterministic",
		spec: graded,
		...scoreEvaluation(graded, awards),
	};
}

export function partResponsesFromDraft(
	spec: AssessmentSpecV1,
	drafts: Record<string, Record<string, string>> | undefined,
): { responses: AssessmentPartResponse[]; complete: boolean } {
	const responses: AssessmentPartResponse[] = [];
	let complete = true;
	for (const part of spec.parts) {
		if (part.kind === "numeric") {
			const draft = drafts?.[part.id] ?? {};
			const valueText = draft.value?.trim() ?? "";
			const value = valueText ? Number(valueText) : Number.NaN;
			if (!Number.isFinite(value)) complete = false;
			else responses.push({ partId: part.id, kind: "numeric", value, unit: draft.unit?.trim() ?? "" });
		} else if (part.kind === "exact") {
			const text = drafts?.[part.id]?.text ?? "";
			if (!text.trim()) complete = false;
			else responses.push({ partId: part.id, kind: "exact", text });
		} else if (part.kind === "structured") {
			const draft = drafts?.[part.id] ?? {};
			const fields = part.fields.map(field => ({ id: field.id, text: draft[field.id] ?? "" }));
			if (!fields.some(field => field.text.trim())) complete = false;
			responses.push({ partId: part.id, kind: "structured", fields });
		}
	}
	return { responses, complete };
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

export function sumAssessmentPoints(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
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
