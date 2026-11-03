import type {
	SkillEvidenceStatus,
	SubjectMapDefinition,
} from "./contracts/subject-map.ts";

export type SkillPathState = "cleared" | "open" | "reachable" | "locked";

export function isSatisfied(status: SkillEvidenceStatus | undefined): boolean {
	return status === "supporting";
}

type PathwayMap = Pick<SubjectMapDefinition, "skills" | "edges" | "alternatives">;

function prerequisitesOf(map: PathwayMap): Map<string, string[]> {
	const prerequisites = new Map(map.skills.map((skill) => [skill.id, [] as string[]]));
	for (const edge of map.edges) prerequisites.get(edge.dependent)?.push(edge.prerequisite);
	return prerequisites;
}

function alternativeGroupsOf(map: PathwayMap): Map<string, string[][]> {
	const groups = new Map(map.skills.map((skill) => [skill.id, [] as string[][]]));
	for (const group of map.alternatives ?? []) groups.get(group.dependent)?.push(group.options);
	return groups;
}

export function skillPathStates(
	map: PathwayMap,
	statuses: ReadonlyMap<string, SkillEvidenceStatus>,
): Map<string, SkillPathState> {
	const prerequisites = prerequisitesOf(map);
	const groups = alternativeGroupsOf(map);
	const states = new Map<string, SkillPathState>();
	for (const skill of map.skills) {
		if (isSatisfied(statuses.get(skill.id))) states.set(skill.id, "cleared");
	}
	for (const skill of map.skills) {
		if (states.has(skill.id)) continue;
		const requiredReady = (prerequisites.get(skill.id) ?? []).every((id) => isSatisfied(statuses.get(id)));
		const alternativesReady = (groups.get(skill.id) ?? []).every((options) => options.some((id) => isSatisfied(statuses.get(id))));
		if (requiredReady && alternativesReady) states.set(skill.id, "open");
	}
	for (const skill of map.skills) {
		if (states.has(skill.id)) continue;
		const requiredReachable = (prerequisites.get(skill.id) ?? []).every((id) => {
			if (isSatisfied(statuses.get(id))) return true;
			const state = states.get(id);
			return state === "open" || state === "cleared";
		});
		const alternativesReachable = (groups.get(skill.id) ?? []).every((options) => {
			if (options.some((id) => isSatisfied(statuses.get(id)))) return true;
			return options.some((id) => {
				const state = states.get(id);
				return state === "open" || state === "cleared";
			});
		});
		if (requiredReachable && alternativesReachable) states.set(skill.id, "reachable");
		else states.set(skill.id, "locked");
	}
	return states;
}

export interface SkillRoute {
	goalId: string;
	route: string[];
	skipAhead: { skillId: string; beneath: number }[];
}

function dependencyEdges(map: PathwayMap): { prerequisite: string; dependent: string }[] {
	return [
		...map.edges,
		...(map.alternatives ?? []).flatMap((group) => group.options.map((option) => ({ prerequisite: option, dependent: group.dependent }))),
	];
}

function stableTopologicalOrder(ids: Set<string>, edges: readonly { prerequisite: string; dependent: string }[]): string[] {
	const indegree = new Map([...ids].map((id) => [id, 0]));
	const dependents = new Map([...ids].map((id) => [id, new Set<string>()]));
	for (const edge of edges) {
		if (!ids.has(edge.prerequisite) || !ids.has(edge.dependent) || edge.prerequisite === edge.dependent) continue;
		const children = dependents.get(edge.prerequisite)!;
		if (children.has(edge.dependent)) continue;
		children.add(edge.dependent);
		indegree.set(edge.dependent, indegree.get(edge.dependent)! + 1);
	}
	const ready = [...ids].filter((id) => indegree.get(id) === 0).sort();
	const ordered: string[] = [];
	while (ready.length) {
		const id = ready.shift()!;
		ordered.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			indegree.set(dependent, indegree.get(dependent)! - 1);
			if (indegree.get(dependent) === 0) {
				ready.push(dependent);
				ready.sort();
			}
		}
	}
	return ordered;
}

export function routeToGoal(
	map: PathwayMap & Pick<SubjectMapDefinition, "skills">,
	statuses: ReadonlyMap<string, SkillEvidenceStatus>,
	goalId: string,
): SkillRoute | null {
	const skills = new Map(map.skills.map((skill) => [skill.id, skill]));
	if (!skills.has(goalId)) return null;
	const prerequisites = prerequisitesOf(map);
	const groups = alternativeGroupsOf(map);
	const memo = new Map<string, Set<string>>();
	const visiting = new Set<string>();
	const closure = (id: string): Set<string> => {
		const cached = memo.get(id);
		if (cached) return cached;
		if (isSatisfied(statuses.get(id))) return new Set();
		if (visiting.has(id)) return new Set([id]);
		visiting.add(id);
		const result = new Set([id]);
		for (const prerequisite of prerequisites.get(id) ?? []) {
			for (const required of closure(prerequisite)) result.add(required);
		}
		for (const options of groups.get(id) ?? []) {
			if (options.some((option) => isSatisfied(statuses.get(option)))) continue;
			const chosen = options
				.map((option) => ({ option, closure: closure(option) }))
				.sort((a, b) => a.closure.size - b.closure.size || (a.option < b.option ? -1 : a.option > b.option ? 1 : 0))[0];
			if (chosen) for (const required of chosen.closure) result.add(required);
		}
		visiting.delete(id);
		memo.set(id, result);
		return result;
	};
	const unsatisfied = closure(goalId);
	const route = stableTopologicalOrder(unsatisfied, dependencyEdges(map));
	const states = skillPathStates(map, statuses);
	const skipAhead = route
		.filter((id) => skills.get(id)?.keystone === true && (states.get(id) === "open" || states.get(id) === "reachable"))
		.map((skillId) => ({
			skillId,
			beneath: [...closure(skillId)].filter((id) => unsatisfied.has(id)).length - 1,
		}))
		.sort((a, b) => b.beneath - a.beneath || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
	return { goalId, route, skipAhead };
}

export interface WorldLayout {
	width: number;
	height: number;
	nodes: { skillId: string; x: number; y: number; depth: number; regionId: string | null }[];
	regions: { id: string | null; title: string; x: number; y: number; width: number; height: number }[];
}

export const WORLD_NODE = { width: 168, height: 44 } as const;
export const WORLD_PAD = 32;
export const WORLD_COL_W = 224;
export const WORLD_ROW_H = 64;
export const WORLD_LABEL_H = 36;
export const WORLD_BAND_PAD = 20;
export const WORLD_BAND_GAP = 24;

export function worldLayout(map: Pick<SubjectMapDefinition, "skills" | "edges" | "alternatives" | "regions">): WorldLayout {
	const edges = dependencyEdges(map);
	const indegree = new Map(map.skills.map((skill) => [skill.id, 0]));
	const dependents = new Map(map.skills.map((skill) => [skill.id, new Set<string>()]));
	for (const edge of edges) {
		if (!indegree.has(edge.prerequisite) || !indegree.has(edge.dependent) || edge.prerequisite === edge.dependent) continue;
		const children = dependents.get(edge.prerequisite)!;
		if (children.has(edge.dependent)) continue;
		children.add(edge.dependent);
		indegree.set(edge.dependent, indegree.get(edge.dependent)! + 1);
	}
	const ready = map.skills.filter((skill) => indegree.get(skill.id) === 0).map((skill) => skill.id);
	const depth = new Map(map.skills.map((skill) => [skill.id, 0]));
	while (ready.length) {
		const id = ready.shift()!;
		for (const dependent of dependents.get(id) ?? []) {
			depth.set(dependent, Math.max(depth.get(dependent)!, depth.get(id)! + 1));
			indegree.set(dependent, indegree.get(dependent)! - 1);
			if (indegree.get(dependent) === 0) ready.push(dependent);
		}
	}
	const bands = [
		...(map.regions ?? []).map((region) => ({ id: region.id as string | null, title: region.title, skills: map.skills.filter((skill) => skill.regionId === region.id) })),
		...(map.skills.some((skill) => !skill.regionId) ? [{ id: null, title: "Ungrouped", skills: map.skills.filter((skill) => !skill.regionId) }] : []),
	].filter((band) => band.skills.length > 0);
	const nodes: WorldLayout["nodes"] = [];
	const regions: WorldLayout["regions"] = [];
	let bandTop = WORLD_PAD;
	let maxX = WORLD_PAD;
	for (const band of bands) {
		const columns = new Map<number, typeof band.skills>();
		for (const skill of band.skills) {
			const columnDepth = depth.get(skill.id) ?? 0;
			const column = columns.get(columnDepth) ?? [];
			column.push(skill);
			columns.set(columnDepth, column);
		}
		const maxColumnLength = Math.max(0, ...[...columns.values()].map((column) => column.length));
		const bandHeight = WORLD_LABEL_H + maxColumnLength * WORLD_ROW_H + WORLD_BAND_PAD;
		let minX = Infinity;
		let bandMaxX = -Infinity;
		for (const [columnDepth, column] of columns) {
			for (const [row, skill] of column.entries()) {
				const x = WORLD_PAD + columnDepth * WORLD_COL_W;
				const y = bandTop + WORLD_LABEL_H + row * WORLD_ROW_H;
				nodes.push({ skillId: skill.id, x, y, depth: columnDepth, regionId: skill.regionId ?? null });
				minX = Math.min(minX, x);
				bandMaxX = Math.max(bandMaxX, x + WORLD_NODE.width);
			}
		}
		regions.push({
			id: band.id,
			title: band.title,
			x: minX - WORLD_BAND_PAD,
			y: bandTop,
			width: bandMaxX - minX + WORLD_BAND_PAD * 2,
			height: bandHeight,
		});
		maxX = Math.max(maxX, bandMaxX);
		bandTop += bandHeight + WORLD_BAND_GAP;
	}
	return {
		width: maxX + WORLD_PAD,
		height: (bands.length ? bandTop - WORLD_BAND_GAP : 0) + WORLD_PAD,
		nodes,
		regions,
	};
}
