import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { effectivePromptSegments } from "../prompt-segments.ts";
import { accumulateJobUsage, piUsageToStep, type JobUsage } from "../../core/contracts/jobs.ts";
import type { PortableSubjectMapV1 } from "../../core/contracts/subject-map.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const text = Type.String();
const source = Type.Union([
	Type.Object({ kind: Type.Literal("manual") }),
	Type.Object({ kind: Type.Literal("syllabus"), sourceName: text, quote: text }),
	Type.Object({ kind: Type.Literal("framework"), framework: text }),
	Type.Object({ kind: Type.Literal("aiGapFill"), reason: text }),
]);

export const mapDraftSchema = Type.Object({
	format: Type.Literal("learnharness.subject-map"), version: Type.Literal(1),
	title: text, description: text,
	regions: Type.Optional(Type.Array(Type.Object({ id: text, title: text, description: text }))),
	skills: Type.Array(Type.Object({ id: text, title: text, objective: text, revision: Type.Integer({ minimum: 1 }), regionId: Type.Optional(text), source: Type.Optional(source), keystone: Type.Optional(Type.Literal(true)) })),
	edges: Type.Array(Type.Object({ prerequisite: text, dependent: text })),
	alternatives: Type.Optional(Type.Array(Type.Object({ dependent: text, options: Type.Array(text) }))),
	goals: Type.Array(text),
	retired: Type.Array(Type.Object({ id: text, title: text, revision: Type.Integer({ minimum: 1 }) })),
});

export async function runMapDrafter(prompt: string, deps: { engine: PiEngine; switches?: Record<string, boolean>; signal?: AbortSignal }) {
	let usage: JobUsage | undefined;
	const draft = await withBgLlmSlot(deps.signal, () => runSubmitAgent<PortableSubjectMapV1>({
		role: "mapDrafter", engine: deps.engine, signal: deps.signal,
		toolName: "submit_map", toolDescription: "Submit a complete subject-map draft for owner review.",
		parameters: mapDraftSchema, fill: (input) => input,
		systemPrompt: effectivePromptSegments("map-drafter", deps.switches ?? {}).map((segment) => segment.enabled ? segment.overrideText : segment.sourceText).join("\n\n"),
		prompt, neverSubmitted: "The map drafter did not submit a map.",
		onStep: (step, model) => { usage = accumulateJobUsage(usage, model, piUsageToStep(step)); },
	}));
	return { draft, usage };
}
