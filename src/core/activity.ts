import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
	ACTIVITY_LIMITS as L,
	type ActivityGuide,
	type CaseComparisonActivityV1,
	type TeachingStimulusSnapshot,
} from "./contracts/activity.ts";

const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$", description: "Short stable id (letters, digits, _ or -)." });
const label = Type.String({ minLength: 1, maxLength: L.label });
const prose = Type.String({ minLength: 1, maxLength: L.text });
const coordinate = Type.Number({ minimum: -L.magnitude, maximum: L.magnitude });
const axis = Type.Object(
	{ label, unit: Type.Optional(Type.String({ minLength: 1, maxLength: L.unit })) },
	{ additionalProperties: false },
);

/** The model-facing authoring schema. Closed objects: an unknown key (a
 *  url, html, svg, script or formula field) is rejected, never stripped. */
export const activityInputSchema = Type.Object(
	{
		kind: Type.Literal("case-comparison", { description: "The one supported activity kind: compare finite cases on one line plot." }),
		title: label,
		objective: Type.String({ minLength: 1, maxLength: L.text, description: "What the learner should notice or be able to explain." }),
		instructions: Type.String({ minLength: 1, maxLength: L.text, description: "What to do: which cases to switch between and what to look at." }),
		xAxis: axis,
		yAxis: axis,
		cases: Type.Array(
			Type.Object(
				{
					id,
					label,
					description: Type.Optional(prose),
					series: Type.Array(
						Type.Object(
							{
								id,
								label,
								points: Type.Array(Type.Object({ x: coordinate, y: coordinate }, { additionalProperties: false }), {
									minItems: 2,
									maxItems: L.points,
								}),
							},
							{ additionalProperties: false },
						),
						{ minItems: 1, maxItems: L.series },
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 2, maxItems: L.cases, description: `2–${L.cases} selectable cases; each lists its series of precomputed points.` },
		),
		textAlternative: Type.String({
			minLength: 1,
			maxLength: L.text,
			description: "A useful prose description of what changes across the cases, for learners who cannot see the plot. Describe, do not conclude for them.",
		}),
	},
	{ additionalProperties: false },
);
export type ActivityInput = Static<typeof activityInputSchema>;

const BYTE_LIMIT = 64 * 1024;

/** Every reason the input is not a renderable activity; [] = valid. */
export function activityProblems(input: unknown): string[] {
	let size: number;
	try {
		size = new TextEncoder().encode(JSON.stringify(input) ?? "").length;
	} catch {
		return ["activity must be plain JSON data"];
	}
	if (size > BYTE_LIMIT) return [`activity exceeds ${BYTE_LIMIT} bytes`];
	if (!Value.Check(activityInputSchema, input)) {
		const first = [...Value.Errors(activityInputSchema, input)][0];
		return [`activity is not valid declarative data${first ? ` (${first.instancePath || "/"}: ${first.message})` : ""}: allowed keys only, ${L.cases} cases, ${L.series} series and ${L.points} points at most, finite numbers, bounded text`];
	}
	const problems: string[] = [];
	const caseIds = new Set<string>();
	for (const c of input.cases) {
		if (caseIds.has(c.id)) problems.push(`duplicate case id ${c.id}`);
		caseIds.add(c.id);
		const seriesIds = new Set<string>();
		for (const s of c.series) {
			if (seriesIds.has(s.id)) problems.push(`duplicate series id ${s.id} in case ${c.id}`);
			seriesIds.add(s.id);
			if (s.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) problems.push(`series ${s.id} in case ${c.id} has a non-finite point`);
		}
	}
	return problems;
}

/** The validated, normalized activity (version stamped, keys in schema order). */
export function normalizeActivity(input: ActivityInput): CaseComparisonActivityV1 {
	const axisOf = (a: ActivityInput["xAxis"]) => ({ label: a.label, ...(a.unit ? { unit: a.unit } : {}) });
	return {
		version: 1,
		kind: "case-comparison",
		title: input.title,
		objective: input.objective,
		instructions: input.instructions,
		xAxis: axisOf(input.xAxis),
		yAxis: axisOf(input.yAxis),
		cases: input.cases.map((c) => ({
			id: c.id,
			label: c.label,
			...(c.description ? { description: c.description } : {}),
			series: c.series.map((s) => ({ id: s.id, label: s.label, points: s.points.map((p) => ({ x: p.x, y: p.y })) })),
		})),
		textAlternative: input.textAlternative,
	};
}

/** Display-side parse of persisted details: a valid activity or undefined. */
export function activityOf(details: unknown): CaseComparisonActivityV1 | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const { version, ...rest } = details as Record<string, unknown>;
	if (version !== 1 || activityProblems(rest).length > 0) return undefined;
	return normalizeActivity(rest as ActivityInput);
}

export function activityGuide(a: CaseComparisonActivityV1): ActivityGuide {
	return { title: a.title, objective: a.objective, instructions: a.instructions };
}

export interface ActivityScales {
	x: { min: number; max: number };
	y: { min: number; max: number };
}

/** One fixed domain across ALL cases, so switching cases moves the data,
 *  never the axes (a rescaled axis would fake or hide the difference). */
export function activityScales(a: CaseComparisonActivityV1): ActivityScales {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const c of a.cases) for (const s of c.series) for (const p of s.points) {
		xs.push(p.x);
		ys.push(p.y);
	}
	const span = (v: number[]) => {
		let min = Math.min(...v);
		let max = Math.max(...v);
		if (min === max) {
			min -= 1;
			max += 1;
		}
		return { min, max };
	};
	return { x: span(xs), y: span(ys) };
}

/** The model-facing reference an explanation check carries to its activity. */
export const teachingStimulusField = Type.Optional(
	Type.Object(
		{
			kind: Type.Literal("teaching-stimulus"),
			toolCallId: Type.String({
				minLength: 1,
				maxLength: 128,
				description: "The toolCallId of the successful `activity` call in THIS session that this explanation is about.",
			}),
		},
		{
			additionalProperties: false,
			description:
				"Optional. Links this explanation to one activity you posted in this session (explore → explain). The server resolves it to that exact activity; a missing, failed or other-session source is rejected.",
		},
	),
);

export interface TeachingStimulusRef {
	kind: "teaching-stimulus";
	toolCallId: string;
}

export function teachingStimulusRefOf(input: unknown): TeachingStimulusRef | undefined {
	const s = (input as { stimulus?: unknown } | null)?.stimulus;
	if (typeof s !== "object" || s === null) return undefined;
	const { kind, toolCallId } = s as Record<string, unknown>;
	return kind === "teaching-stimulus" && typeof toolCallId === "string" ? { kind, toolCallId } : undefined;
}

interface MessageLike {
	id?: string;
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
}

export type StimulusResolution =
	| { ok: true; activity: CaseComparisonActivityV1; snapshot: TeachingStimulusSnapshot }
	| { ok: false; problem: string };

/** Canonical resolution against ONE chat's persisted messages: the exact
 *  `activity` call, posed in this chat, with a successful, valid result.
 *  Never "the latest activity" — the reference names its call. */
export function resolveTeachingStimulus(messages: readonly MessageLike[], ref: TeachingStimulusRef): StimulusResolution {
	const calls = messages.flatMap((m) =>
		m.role === "assistant" && Array.isArray(m.content)
			? m.content.filter((p: { type?: string; id?: string }) => p?.type === "toolCall" && p.id === ref.toolCallId)
			: [],
	) as Array<{ name?: string }>;
	if (!calls.some((c) => c.name === "activity")) return { ok: false, problem: `no activity call ${ref.toolCallId} in this session` };
	const results = messages.filter((m) => m.role === "toolResult" && m.toolCallId === ref.toolCallId);
	// A provider that reuses call ids makes the reference ambiguous: refuse
	// rather than pick one (never "latest").
	if (calls.length > 1 || results.length > 1) return { ok: false, problem: `call id ${ref.toolCallId} is used more than once in this session` };
	const result = results[0];
	if (!result || result.toolName !== "activity" || result.isError || !result.id) return { ok: false, problem: `activity ${ref.toolCallId} has no successful result` };
	const activity = activityOf(result.details);
	if (!activity) return { ok: false, problem: `activity ${ref.toolCallId} is not a valid activity` };
	return {
		ok: true,
		activity,
		snapshot: { kind: "teaching-stimulus", messageId: result.id, toolCallId: ref.toolCallId, guide: activityGuide(activity), provenance: "appRenderedActivity" },
	};
}

/** Display parse of an answer's snapshot (persisted details are untrusted JSON). */
export function stimulusSnapshotOf(value: unknown): TeachingStimulusSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const s = value as Record<string, unknown>;
	const g = s.guide as Record<string, unknown> | undefined;
	if (s.kind !== "teaching-stimulus" || s.provenance !== "appRenderedActivity" || typeof s.messageId !== "string" || typeof s.toolCallId !== "string") return undefined;
	if (!g || typeof g.title !== "string" || typeof g.objective !== "string" || typeof g.instructions !== "string") return undefined;
	return { kind: "teaching-stimulus", messageId: s.messageId, toolCallId: s.toolCallId, guide: { title: g.title, objective: g.objective, instructions: g.instructions }, provenance: "appRenderedActivity" };
}
