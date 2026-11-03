import type { PiEngine } from "../agent/models.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { agentCapabilities } from "../agent/capabilities.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { runMapDrafter } from "../agent/subagents/map-drafter.ts";
import { accumulateJobUsage, type JobUsage } from "../core/contracts/jobs.ts";
import type { PortableSubjectMapV1, SubjectMapDefinition, SubjectMapRead } from "../core/contracts/subject-map.ts";
import { parsePortableSubjectMap, portableSubjectMap, reviseSubjectMapDefinition } from "../core/subject-map.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export interface MapSyllabus { name: string; text: string }
export interface MapDraftInput { goal?: string; framework?: string; syllabus?: MapSyllabus }
export interface MapRefineInput { instruction: string; syllabus?: MapSyllabus }
export interface MapDraftDeps {
	engine?: PiEngine;
	signal?: AbortSignal;
	readMap?: (id: string) => SubjectMapRead;
	drafter?: typeof runMapDrafter;
}

export class MapDraftValidationError extends Error {
	constructor(public readonly issues: string[]) { super("Unable to produce a valid subject-map draft."); }
}
export class MapDraftNotFoundError extends Error {
	constructor() { super("Map not found."); }
}

function engineForDraft(deps: MapDraftDeps): PiEngine {
	if (deps.engine) return deps.engine;
	const spec = resolveRoleSpec("mapDrafter", stores.settingsStore.readSettings());
	if (!spec || (isSubscriptionProvider(spec.provider) && !agentCapabilities().subscriptions)) throw new ModelsNotConfiguredError(["strong"]);
	if (!providerKeyPresent(spec.provider)) throw new ProviderKeyMissingError(spec.provider, ["strong"]);
	return piEngineForSpec(spec);
}

function mergeUsage(total: JobUsage | undefined, next: JobUsage | undefined): JobUsage | undefined {
	if (!total) return next;
	if (!next) return total;
	for (const call of next.calls ?? []) total = accumulateJobUsage(total, next.model, {
		inputTokens: call.inputTokens, outputTokens: call.outputTokens,
		inputTokenDetails: { cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens, cacheWrite1hTokens: call.cacheWrite1hTokens },
		outputTokenDetails: { reasoningTokens: call.reasoningTokens },
	});
	return total;
}

const whitespace = (text: string) => text.replace(/\s+/gu, " ").trim();

function verifiedQuotes(draft: PortableSubjectMapV1, syllabus?: MapSyllabus): PortableSubjectMapV1 {
	const uploaded = syllabus ? whitespace(syllabus.text) : "";
	return { ...draft, skills: draft.skills.map((skill) => {
		if (skill.source?.kind !== "syllabus") return skill;
		const quote = whitespace(skill.source.quote);
		return uploaded && quote && uploaded.includes(quote) ? skill : { ...skill, source: { kind: "aiGapFill", reason: "quote not found in syllabus" } };
	}) };
}

async function draft(input: MapDraftInput | MapRefineInput, previous: SubjectMapDefinition | null, deps: MapDraftDeps) {
	const engine = engineForDraft(deps);
	const now = new Date().toISOString();
	const prompt = JSON.stringify({ request: input, ...(previous ? { existing: portableSubjectMap(previous) } : {}) });
	let repair = "";
	let usage: JobUsage | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await (deps.drafter ?? runMapDrafter)(prompt + repair, { engine, signal: deps.signal, switches: stores.settingsStore.readSettings()?.agent?.prompts });
		usage = mergeUsage(usage, result.usage);
		const candidate = verifiedQuotes(result.draft, input.syllabus);
		const normalized = parsePortableSubjectMap(candidate, now);
		let issues: string[];
		if (!normalized.ok) issues = normalized.issues;
		else {
			const revised = reviseSubjectMapDefinition(previous, normalized.definition, now);
			if (revised.ok) return { draft: revised.definition, issues: [] as string[], usage };
			issues = revised.issues;
		}
		if (attempt === 1) throw new MapDraftValidationError(issues);
		repair = `\nRepair this draft, returning a full definition:\n${JSON.stringify(candidate)}\nIssues:\n${issues.join("\n")}`;
	}
	throw new Error("Unreachable draft attempt.");
}

export function draftSubjectMap(input: MapDraftInput, deps: MapDraftDeps = {}) {
	return draft(input, null, deps);
}

export function refineSubjectMap(id: string, input: MapRefineInput, deps: MapDraftDeps = {}) {
	const read = (deps.readMap ?? stores.subjectMapStore.read)(id);
	if (read.state !== "ok") throw new MapDraftNotFoundError();
	return draft(input, read.map, deps);
}
