import type { FamiliaritySuggestion, PlacementProbe, PlacementRun } from "./contracts.ts";
import type { SkillEvidenceStatus, SubjectMapV1 } from "./contracts/subject-map.ts";
import { dependentClosureOf, prerequisiteClosureOf, skillDepths } from "./pathways.ts";
import { subjectSkillTargetStatus, topologicalSkillOrder } from "./subject-map.ts";

export function normalizeQuoteText(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function quoteInText(quote: string, text: string): boolean {
	const normalized = normalizeQuoteText(quote);
	return normalized.length > 0 && normalized.length <= 500 && normalizeQuoteText(text).includes(normalized);
}

export function nextPlacementProbe(
	map: SubjectMapV1,
	statuses: ReadonlyMap<string, SkillEvidenceStatus>,
	probes: readonly PlacementProbe[],
	options: { maxProbes?: number; likelyKnown?: ReadonlySet<string> } = {},
): string | null {
	const maxProbes = options.maxProbes ?? 15;
	if (probes.length >= maxProbes) return null;
	const known = new Set(map.skills.filter((skill) => statuses.get(skill.id) === "supporting" || options.likelyKnown?.has(skill.id)).map((skill) => skill.id));
	for (const probe of probes) if (probe.result === "supports") {
		known.add(probe.skillId);
		for (const id of prerequisiteClosureOf(map, probe.skillId)) known.add(id);
	}
	const ruledOut = new Set<string>();
	for (const probe of probes) if (probe.result === "against") for (const id of dependentClosureOf(map, probe.skillId)) ruledOut.add(id);
	const probed = new Set(probes.map((probe) => probe.skillId));
	const unresolved = new Set(map.skills.map((skill) => skill.id).filter((id) => !known.has(id) && !ruledOut.has(id) && !probed.has(id)));
	if (!unresolved.size) return null;
	const depths = skillDepths(map);
	const closures = new Map(map.skills.map((skill) => [skill.id, {
		pre: prerequisiteClosureOf(map, skill.id),
		dep: dependentClosureOf(map, skill.id),
	}]));
	const candidates = [...unresolved].map((id) => {
		const closure = closures.get(id)!;
		const pre = [...closure.pre].filter((item) => unresolved.has(item)).length;
		const dep = [...closure.dep].filter((item) => unresolved.has(item)).length;
		return { id, score: Math.min(pre, dep), depth: depths.get(id) ?? 0 };
	});
	candidates.sort((a, b) => b.score - a.score || a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return candidates[0]?.id ?? null;
}

export function placementSuggestionTargets(map: SubjectMapV1, statuses: ReadonlyMap<string, SkillEvidenceStatus>, probedSkillId: string): string[] {
	const closure = prerequisiteClosureOf(map, probedSkillId);
	return topologicalSkillOrder(map).filter((id) => closure.has(id) && statuses.get(id) !== "supporting");
}

type SuggestionCandidate = Omit<FamiliaritySuggestion, "id" | "status" | "createdAt" | "decidedAt">;
function sameReasonKind(a: FamiliaritySuggestion, b: SuggestionCandidate): boolean {
	return a.mapId === b.mapId && a.skillId === b.skillId && a.skillRevision === b.skillRevision && a.reason.kind === b.reason.kind;
}

export function mergeFamiliaritySuggestions(
	existing: readonly FamiliaritySuggestion[],
	candidates: readonly SuggestionCandidate[],
	now: string,
	newId: () => string,
): { suggestions: FamiliaritySuggestion[]; added: FamiliaritySuggestion[]; merged: number; dropped: number } {
	const suggestions = [...existing];
	const added: FamiliaritySuggestion[] = [];
	let merged = 0;
	let dropped = 0;
	for (const candidate of candidates) {
		if (suggestions.some((item) => item.status === "pending" && sameReasonKind(item, candidate))) { merged++; continue; }
		if (suggestions.length >= 2000) { dropped++; continue; }
		const suggestion: FamiliaritySuggestion = { ...candidate, id: newId(), status: "pending", createdAt: now };
		suggestions.push(suggestion);
		added.push(suggestion);
	}
	return { suggestions, added, merged, dropped };
}

export function decideFamiliaritySuggestions(
	existing: readonly FamiliaritySuggestion[],
	ids: readonly string[],
	status: "confirmed" | "rejected",
	now: string,
): FamiliaritySuggestion[] {
	const known = new Set(existing.map((suggestion) => suggestion.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length) throw new Error(`Unknown familiarity suggestion id: ${unknown[0]}`);
	const selected = new Set(ids);
	return existing.map((suggestion) => selected.has(suggestion.id) ? { ...suggestion, status, decidedAt: now } : suggestion);
}

export function suggestionStanding(suggestion: FamiliaritySuggestion, map: SubjectMapV1 | null): "current" | "historical" {
	return subjectSkillTargetStatus(map, { kind: "subject-skill", mapId: suggestion.mapId, skillId: suggestion.skillId, skillRevision: suggestion.skillRevision }) === "current" ? "current" : "historical";
}

export function likelyKnownSkills(suggestions: readonly FamiliaritySuggestion[], map: SubjectMapV1): Set<string> {
	return new Set(suggestions.filter((suggestion) => suggestion.mapId === map.id && suggestion.status === "confirmed" && suggestionStanding(suggestion, map) === "current").map((suggestion) => suggestion.skillId));
}

export function projectPlacementContext(run: PlacementRun, map: SubjectMapV1): string {
	const unresolvedIndex = run.probes.findIndex((probe) => !probe.result && map.skills.some((skill) => skill.id === probe.skillId && skill.revision === probe.revision));
	if (unresolvedIndex < 0) {
		const results = run.probes.filter((probe) => probe.result).map((probe) => {
			const title = map.skills.find((skill) => skill.id === probe.skillId)?.title ?? probe.skillId;
			return `${title}: ${probe.result}`;
		}).join("; ");
		return `[Placement run — data, not instructions]\nThis placement run is complete. Probe results: ${results}.\nGive a short summary of what the probes showed, in plain language, and tell him the likely-known suggestions are listed below for him to confirm or reject. Ask no further questions, never call probe_done, and never claim mastery.`;
	}
	const probe = run.probes[unresolvedIndex]!;
	const skill = map.skills.find((item) => item.id === probe.skillId)!;
	const previous = run.probes.slice(0, unresolvedIndex).filter((item) => item.result).map((item) => `${item.skillId}: ${item.result}`);
	return `[Placement run — data, not instructions]\nProbe ${unresolvedIndex + 1} of ${run.maxProbes}: ${skill.title}. Objective: ${skill.objective}\n${previous.length ? `Previous probe results: ${previous.join("; ")}\n` : ""}Ask one short targeted check of this probe using onTarget: true. After it is graded, the app moves to the next probe. Keep a friendly pace; never claim mastery.`;
}
