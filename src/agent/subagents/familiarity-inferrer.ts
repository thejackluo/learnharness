import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { effectivePromptSegments } from "../prompt-segments.ts";
import { accumulateJobUsage, piUsageToStep, type JobUsage } from "../../core/contracts/jobs.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const schema = Type.Object({ items: Type.Array(Type.Object({ skillId: Type.String(), quote: Type.String() })) });

export async function runFamiliarityInferrer(prompt: string, deps: { engine: PiEngine; switches?: Record<string, boolean>; signal?: AbortSignal }) {
	let usage: JobUsage | undefined;
	const result = await withBgLlmSlot(deps.signal, () => runSubmitAgent<{ items: { skillId: string; quote: string }[] }>({
		role: "familiarityInferrer",
		engine: deps.engine,
		signal: deps.signal,
		toolName: "submit_familiarity",
		toolDescription: "Submit supported skill familiarity suggestions.",
		parameters: schema,
		fill: (input) => input,
		systemPrompt: effectivePromptSegments("familiarity-inferrer", deps.switches ?? {}).map((segment) => segment.enabled ? segment.overrideText : segment.sourceText).join("\n\n"),
		prompt,
		neverSubmitted: "The familiarity inferrer did not submit suggestions.",
		onStep: (step, model) => { usage = accumulateJobUsage(usage, model, piUsageToStep(step)); },
	}));
	return { items: result.items, usage };
}
