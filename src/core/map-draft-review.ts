import type { SubjectMapDefinition, SubjectSkill } from "./contracts/subject-map.ts";

export function groupSubjectMapSkills(map: SubjectMapDefinition) {
	return [
		...(map.regions ?? []).map((region) => ({ id: region.id, title: region.title, skills: map.skills.filter((skill) => skill.regionId === region.id) })),
		{ id: undefined, title: "Ungrouped", skills: map.skills.filter((skill) => !skill.regionId) },
	].filter((group) => group.skills.length);
}

export function diffSubjectMaps(previous: SubjectMapDefinition, next: SubjectMapDefinition) {
	const before = new Map(previous.skills.map((skill) => [skill.id, skill]));
	const after = new Map(next.skills.map((skill) => [skill.id, skill]));
	const identity = (skill: SubjectSkill) => JSON.stringify([skill.title, skill.objective, skill.regionId ?? null, skill.source ?? null, skill.keystone ?? false]);
	const edgeKey = (edge: SubjectMapDefinition["edges"][number]) => JSON.stringify([edge.prerequisite, edge.dependent]);
	const alternativeKey = (group: NonNullable<SubjectMapDefinition["alternatives"]>[number]) => JSON.stringify([group.dependent, [...group.options].sort()]);
	const oldEdges = new Set(previous.edges.map(edgeKey));
	const newEdges = new Set(next.edges.map(edgeKey));
	const oldAlternatives = new Set((previous.alternatives ?? []).map(alternativeKey));
	const newAlternatives = new Set((next.alternatives ?? []).map(alternativeKey));
	return {
		added: next.skills.filter((skill) => !before.has(skill.id)),
		removed: previous.skills.filter((skill) => !after.has(skill.id)),
		changed: next.skills.filter((skill) => before.has(skill.id) && identity(before.get(skill.id)!) !== identity(skill)),
		addedEdges: next.edges.filter((edge) => !oldEdges.has(edgeKey(edge))),
		removedEdges: previous.edges.filter((edge) => !newEdges.has(edgeKey(edge))),
		addedAlternatives: (next.alternatives ?? []).filter((group) => !oldAlternatives.has(alternativeKey(group))),
		removedAlternatives: (previous.alternatives ?? []).filter((group) => !newAlternatives.has(alternativeKey(group))),
	};
}
