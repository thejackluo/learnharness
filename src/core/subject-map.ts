/**
 * Subject-map domain logic (pure, browser-safe): definition validation,
 * objective revisions, portable import/export, prerequisite closure with
 * path explanations, and the evidence-distinct gap projection.
 *
 * Nothing here computes mastery. A skill's encounter (linked propositions),
 * self-report (linked profile topics) and criterion evidence (explicit
 * profile associations) stay three separate axes.
 */
import type { LearnerObservation, LearnerTopicClaim } from "./contracts/learner.ts";
import type { LearningTargetRef } from "./contracts/learning-target.ts";
import {
	SUBJECT_MAP_FORMAT,
	SUBJECT_MAP_LIMITS,
	type EvidencePolarity,
	type PortableSubjectMapV1,
	type RetiredSubjectSkill,
	type SkillEvidenceStatus,
	type SubjectEdge,
	type SubjectMapDefinition,
	type SubjectMapLinks,
	type SubjectMapV1,
	type SubjectSkill,
} from "./contracts/subject-map.ts";

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAP_ID = /^map_[A-Za-z0-9-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

function nonEmptyText(value: unknown, max: number): value is string {
	return boundedText(value, max) && value.trim().length > 0;
}

export function isSubjectMapId(value: unknown): value is string {
	return typeof value === "string" && MAP_ID.test(value);
}

export function isSubjectSkillId(value: unknown): value is string {
	return typeof value === "string" && value.length <= SUBJECT_MAP_LIMITS.idChars && SKILL_ID.test(value);
}

/** Depth of nested arrays/objects; the reader rejects anything deeper than the limit. */
export function jsonDepthExceeds(value: unknown, max: number): boolean {
	const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	while (stack.length) {
		const current = stack.pop()!;
		if (!current.value || typeof current.value !== "object") continue;
		const depth = current.depth + 1;
		if (depth > max) return true;
		const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
		for (const child of children) stack.push({ value: child, depth });
	}
	return false;
}

/** One cycle as an id path that starts and ends at the same skill, or null. */
export function findPrerequisiteCycle(skillIds: readonly string[], edges: readonly SubjectEdge[]): string[] | null {
	const next = new Map<string, string[]>(skillIds.map((id) => [id, []]));
	for (const edge of edges) next.get(edge.prerequisite)?.push(edge.dependent);
	const state = new Map<string, 1 | 2>();
	for (const start of skillIds) {
		if (state.has(start)) continue;
		const path: string[] = [];
		const stack: { id: string; index: number }[] = [{ id: start, index: 0 }];
		state.set(start, 1);
		path.push(start);
		while (stack.length) {
			const frame = stack[stack.length - 1]!;
			const children = next.get(frame.id) ?? [];
			if (frame.index >= children.length) {
				state.set(frame.id, 2);
				stack.pop();
				path.pop();
				continue;
			}
			const child = children[frame.index++]!;
			const seen = state.get(child);
			if (seen === 1) return [...path.slice(path.indexOf(child)), child];
			if (seen === undefined) {
				state.set(child, 1);
				path.push(child);
				stack.push({ id: child, index: 0 });
			}
		}
	}
	return null;
}

function skillProblems(skills: unknown, issues: string[], requireRevision: boolean): string[] {
	const ids: string[] = [];
	if (!Array.isArray(skills) || skills.length > SUBJECT_MAP_LIMITS.skills) {
		issues.push(`skills must be an array of at most ${SUBJECT_MAP_LIMITS.skills} items`);
		return ids;
	}
	const seen = new Set<string>();
	skills.forEach((skill, index) => {
		const label = `skill ${index + 1}`;
		if (!isRecord(skill)) {
			issues.push(`${label} must be an object`);
			return;
		}
		if (!isSubjectSkillId(skill.id)) {
			issues.push(`${label} id must be 1-${SUBJECT_MAP_LIMITS.idChars} letters, digits, '.', '_' or '-' and start with a letter or digit`);
		} else if (seen.has(skill.id)) {
			issues.push(`duplicate skill id ${skill.id}`);
		} else {
			seen.add(skill.id);
			ids.push(skill.id);
		}
		if (!nonEmptyText(skill.title, SUBJECT_MAP_LIMITS.titleChars)) issues.push(`${label} title must be non-empty and at most ${SUBJECT_MAP_LIMITS.titleChars} characters`);
		if (!nonEmptyText(skill.objective, SUBJECT_MAP_LIMITS.objectiveChars)) issues.push(`${label} objective must be non-empty and at most ${SUBJECT_MAP_LIMITS.objectiveChars} characters`);
		if (requireRevision || skill.revision !== undefined) {
			if (!Number.isInteger(skill.revision) || (skill.revision as number) < 1) issues.push(`${label} revision must be a positive integer`);
		}
	});
	return ids;
}

function edgeProblems(edges: unknown, skillIds: Set<string>, issues: string[]): void {
	if (!Array.isArray(edges) || edges.length > SUBJECT_MAP_LIMITS.edges) {
		issues.push(`edges must be an array of at most ${SUBJECT_MAP_LIMITS.edges} items`);
		return;
	}
	const seen = new Set<string>();
	edges.forEach((edge, index) => {
		const label = `edge ${index + 1}`;
		if (!isRecord(edge) || typeof edge.prerequisite !== "string" || typeof edge.dependent !== "string") {
			issues.push(`${label} must have string prerequisite and dependent skill ids`);
			return;
		}
		if (edge.prerequisite === edge.dependent) issues.push(`${label} is a self-loop on ${edge.prerequisite}`);
		if (!skillIds.has(edge.prerequisite)) issues.push(`${label} references unknown prerequisite ${edge.prerequisite}`);
		if (!skillIds.has(edge.dependent)) issues.push(`${label} references unknown dependent ${edge.dependent}`);
		const key = `${edge.prerequisite}\u0000${edge.dependent}`;
		if (seen.has(key)) issues.push(`duplicate edge ${edge.prerequisite} → ${edge.dependent}`);
		seen.add(key);
	});
}

function goalProblems(goals: unknown, skillIds: Set<string>, issues: string[]): void {
	if (!Array.isArray(goals) || goals.length > SUBJECT_MAP_LIMITS.skills) {
		issues.push(`goals must be an array of at most ${SUBJECT_MAP_LIMITS.skills} skill ids`);
		return;
	}
	const seen = new Set<string>();
	for (const goal of goals) {
		if (typeof goal !== "string" || !skillIds.has(goal)) issues.push(`goal ${String(goal)} is not a skill in this map`);
		else if (seen.has(goal)) issues.push(`duplicate goal ${goal}`);
		else seen.add(goal);
	}
}

function retiredProblems(retired: unknown, skillIds: Set<string>, issues: string[], requireDate: boolean): void {
	if (!Array.isArray(retired) || retired.length > SUBJECT_MAP_LIMITS.retired) {
		issues.push(`retired must be an array of at most ${SUBJECT_MAP_LIMITS.retired} items`);
		return;
	}
	const seen = new Set<string>();
	retired.forEach((item, index) => {
		const label = `retired skill ${index + 1}`;
		if (!isRecord(item) || !isSubjectSkillId(item.id)) {
			issues.push(`${label} must have a valid skill id`);
			return;
		}
		if (seen.has(item.id)) issues.push(`duplicate retired skill id ${item.id}`);
		seen.add(item.id);
		if (skillIds.has(item.id)) issues.push(`retired skill id ${item.id} cannot be reused`);
		if (!Number.isInteger(item.revision) || (item.revision as number) < 1) issues.push(`${label} revision must be a positive integer`);
		if (!boundedText(item.title, SUBJECT_MAP_LIMITS.titleChars)) issues.push(`${label} title must be at most ${SUBJECT_MAP_LIMITS.titleChars} characters`);
		if (requireDate && typeof item.retiredAt !== "string") issues.push(`${label} retiredAt must be a string`);
	});
}

/**
 * Every structural problem in a definition: bounds, ids, dangling or
 * duplicate edges, self-loops, cycles, goals and tombstone reuse.
 * Empty means the definition is a valid DAG.
 */
export function subjectMapDefinitionProblems(
	input: unknown,
	opts: { requireRevisions?: boolean; requireRetiredDates?: boolean } = {},
): string[] {
	if (!isRecord(input)) return ["map definition must be an object"];
	const issues: string[] = [];
	if (!nonEmptyText(input.title, SUBJECT_MAP_LIMITS.titleChars)) issues.push(`title must be non-empty and at most ${SUBJECT_MAP_LIMITS.titleChars} characters`);
	if (!boundedText(input.description, SUBJECT_MAP_LIMITS.descriptionChars)) issues.push(`description must be a string of at most ${SUBJECT_MAP_LIMITS.descriptionChars} characters`);
	const ids = skillProblems(input.skills, issues, opts.requireRevisions ?? true);
	const idSet = new Set(ids);
	edgeProblems(input.edges, idSet, issues);
	goalProblems(input.goals, idSet, issues);
	retiredProblems(input.retired, idSet, issues, opts.requireRetiredDates ?? false);
	if (!issues.length) {
		const cycle = findPrerequisiteCycle(ids, input.edges as SubjectEdge[]);
		if (cycle) issues.push(`prerequisite cycle: ${cycle.join(" → ")}`);
	}
	return [...new Set(issues)];
}

export function subjectMapLinksProblems(links: unknown, skillIds: ReadonlySet<string>): string[] {
	if (!isRecord(links)) return ["links must be an object"];
	const issues: string[] = [];
	for (const [key, refKey] of [["propositions", "nodeId"], ["topics", "topicId"]] as const) {
		const list = links[key];
		if (!Array.isArray(list) || list.length > SUBJECT_MAP_LIMITS.links) {
			issues.push(`${key} links must be an array of at most ${SUBJECT_MAP_LIMITS.links} items`);
			continue;
		}
		const seen = new Set<string>();
		for (const link of list) {
			if (!isRecord(link) || typeof link.skillId !== "string" || !skillIds.has(link.skillId)) {
				issues.push(`${key} link must reference a current skill`);
				continue;
			}
			const ref = link[refKey];
			if (!nonEmptyText(ref, 1024)) issues.push(`${key} link ${refKey} must be a non-empty bounded string`);
			if (typeof link.linkedAt !== "string") issues.push(`${key} link linkedAt must be a string`);
			const identity = `${link.skillId}\u0000${String(ref)}`;
			if (seen.has(identity)) issues.push(`duplicate ${key} link for ${link.skillId}`);
			seen.add(identity);
		}
	}
	return issues;
}

/** Full stored-record validation (the store refuses to read or write anything else). */
export function subjectMapRecordProblems(value: unknown): string[] {
	if (!isRecord(value)) return ["map must be an object"];
	const issues: string[] = [];
	if (value.version !== 1) issues.push("map version must be 1");
	if (!isSubjectMapId(value.id)) issues.push("map id is invalid");
	if (!Number.isInteger(value.revision) || (value.revision as number) < 1) issues.push("map revision must be a positive integer");
	if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") issues.push("map timestamps must be strings");
	issues.push(...subjectMapDefinitionProblems(value, { requireRevisions: true, requireRetiredDates: true }));
	const skillIds = new Set(Array.isArray(value.skills) ? value.skills.filter(isRecord).map((skill) => String(skill.id)) : []);
	issues.push(...subjectMapLinksProblems(value.links, skillIds));
	return issues;
}

function pickSkill(value: Record<string, unknown>, revision: number): SubjectSkill {
	return {
		id: value.id as string,
		title: (value.title as string).trim(),
		objective: (value.objective as string).trim(),
		revision,
	};
}

function pickEdges(edges: unknown[]): SubjectEdge[] {
	return edges.map((edge) => {
		const record = edge as Record<string, unknown>;
		return { prerequisite: record.prerequisite as string, dependent: record.dependent as string };
	});
}

export type SubjectMapDefinitionResult =
	| { ok: true; definition: SubjectMapDefinition }
	| { ok: false; issues: string[] };

/**
 * Applies an edit to the previous definition (or creates a first one).
 * Client-supplied skill revisions are ignored: an unchanged objective keeps
 * its revision, a changed objective increments it, a new skill starts at 1,
 * and a removed skill becomes a retired tombstone whose id cannot return.
 */
export function reviseSubjectMapDefinition(
	previous: SubjectMapDefinition | null,
	input: unknown,
	now: string,
): SubjectMapDefinitionResult {
	if (!isRecord(input)) return { ok: false, issues: ["map definition must be an object"] };
	const priorRetired = previous?.retired ?? [];
	const candidate = {
		title: input.title,
		description: input.description ?? "",
		skills: input.skills,
		edges: input.edges ?? [],
		goals: input.goals ?? [],
		retired: priorRetired,
	};
	const issues = subjectMapDefinitionProblems(candidate, { requireRevisions: false });
	if (issues.length) return { ok: false, issues };
	const priorSkills = new Map((previous?.skills ?? []).map((skill) => [skill.id, skill]));
	const skills = (candidate.skills as Record<string, unknown>[]).map((raw) => {
		const prior = priorSkills.get(raw.id as string);
		const objective = (raw.objective as string).trim();
		const revision = !prior ? 1 : prior.objective === objective ? prior.revision : prior.revision + 1;
		return pickSkill(raw, revision);
	});
	const kept = new Set(skills.map((skill) => skill.id));
	const retired: RetiredSubjectSkill[] = [
		...priorRetired,
		...[...priorSkills.values()]
			.filter((skill) => !kept.has(skill.id))
			.map((skill) => ({ id: skill.id, revision: skill.revision, title: skill.title, retiredAt: now })),
	];
	if (retired.length > SUBJECT_MAP_LIMITS.retired) {
		return { ok: false, issues: [`retired must be an array of at most ${SUBJECT_MAP_LIMITS.retired} items`] };
	}
	return {
		ok: true,
		definition: {
			title: (candidate.title as string).trim(),
			description: candidate.description as string,
			skills,
			edges: pickEdges(candidate.edges as unknown[]),
			goals: [...(candidate.goals as string[])],
			retired,
		},
	};
}

/** Links that still point at a current skill after an edit. */
export function retainSubjectMapLinks(links: SubjectMapLinks, skills: readonly SubjectSkill[]): SubjectMapLinks {
	const ids = new Set(skills.map((skill) => skill.id));
	return {
		propositions: links.propositions.filter((link) => ids.has(link.skillId)),
		topics: links.topics.filter((link) => ids.has(link.skillId)),
	};
}

/** The portable curriculum JSON — excludes every learner, chat and evidence link. */
export function portableSubjectMap(map: SubjectMapDefinition): PortableSubjectMapV1 {
	return {
		format: SUBJECT_MAP_FORMAT,
		version: 1,
		title: map.title,
		description: map.description,
		skills: map.skills.map(({ id, title, objective, revision }) => ({ id, title, objective, revision })),
		edges: map.edges.map(({ prerequisite, dependent }) => ({ prerequisite, dependent })),
		goals: [...map.goals],
		retired: map.retired.map(({ id, revision, title }) => ({ id, revision, title })),
	};
}

/** Parses curriculum JSON into a definition; unknown keys are dropped, revisions are kept. */
export function parsePortableSubjectMap(value: unknown, now: string): SubjectMapDefinitionResult {
	if (!isRecord(value)) return { ok: false, issues: ["curriculum must be a JSON object"] };
	if (value.format !== SUBJECT_MAP_FORMAT) return { ok: false, issues: [`format must be "${SUBJECT_MAP_FORMAT}"`] };
	if (value.version !== 1) {
		return {
			ok: false,
			issues: [typeof value.version === "number" && value.version > 1
				? `curriculum version ${value.version} is newer than this app supports`
				: "curriculum version must be 1"],
		};
	}
	if (jsonDepthExceeds(value, SUBJECT_MAP_LIMITS.jsonDepth)) return { ok: false, issues: ["curriculum is nested too deeply"] };
	const candidate = {
		title: value.title,
		description: value.description ?? "",
		skills: value.skills,
		edges: value.edges ?? [],
		goals: value.goals ?? [],
		retired: value.retired ?? [],
	};
	const issues = subjectMapDefinitionProblems(candidate, { requireRevisions: true });
	if (issues.length) return { ok: false, issues };
	return {
		ok: true,
		definition: {
			title: (candidate.title as string).trim(),
			description: candidate.description as string,
			skills: (candidate.skills as Record<string, unknown>[]).map((raw) => pickSkill(raw, raw.revision as number)),
			edges: pickEdges(candidate.edges as unknown[]),
			goals: [...(candidate.goals as string[])],
			retired: (candidate.retired as Record<string, unknown>[]).map((raw) => ({
				id: raw.id as string,
				revision: raw.revision as number,
				title: raw.title as string,
				retiredAt: now,
			})),
		},
	};
}

/** Skill ids with prerequisites before dependents; ties keep authoring order. */
export function topologicalSkillOrder(definition: Pick<SubjectMapDefinition, "skills" | "edges">): string[] {
	const indegree = new Map(definition.skills.map((skill) => [skill.id, 0]));
	const dependents = new Map<string, string[]>(definition.skills.map((skill) => [skill.id, []]));
	for (const edge of definition.edges) {
		indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1);
		dependents.get(edge.prerequisite)?.push(edge.dependent);
	}
	const position = new Map(definition.skills.map((skill, index) => [skill.id, index]));
	const ready = definition.skills.filter((skill) => indegree.get(skill.id) === 0).map((skill) => skill.id);
	const order: string[] = [];
	while (ready.length) {
		ready.sort((a, b) => position.get(a)! - position.get(b)!);
		const id = ready.shift()!;
		order.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			const remaining = indegree.get(dependent)! - 1;
			indegree.set(dependent, remaining);
			if (remaining === 0) ready.push(dependent);
		}
	}
	return order;
}

export interface GoalPath {
	goalId: string;
	/** Skill ids from this skill to the goal, inclusive. */
	path: string[];
}

/**
 * For each goal, every skill it transitively requires (including itself)
 * with the shortest prerequisite chain from that skill up to the goal.
 */
export function prerequisiteClosure(
	definition: Pick<SubjectMapDefinition, "skills" | "edges">,
	goals: readonly string[],
): Map<string, GoalPath[]> {
	const prerequisites = new Map<string, string[]>(definition.skills.map((skill) => [skill.id, []]));
	for (const edge of definition.edges) prerequisites.get(edge.dependent)?.push(edge.prerequisite);
	const closure = new Map<string, GoalPath[]>();
	for (const goal of goals) {
		if (!prerequisites.has(goal)) continue;
		const towardGoal = new Map<string, string | null>([[goal, null]]);
		const queue = [goal];
		while (queue.length) {
			const id = queue.shift()!;
			for (const prerequisite of prerequisites.get(id) ?? []) {
				if (towardGoal.has(prerequisite)) continue;
				towardGoal.set(prerequisite, id);
				queue.push(prerequisite);
			}
		}
		for (const skillId of towardGoal.keys()) {
			const path = [skillId];
			let step = towardGoal.get(skillId);
			while (step) {
				path.push(step);
				step = towardGoal.get(step);
			}
			const paths = closure.get(skillId) ?? [];
			paths.push({ goalId: goal, path });
			closure.set(skillId, paths);
		}
	}
	return closure;
}

/** How one observation bears on a skill. Legacy client-graded work never counts either way. */
export function evidencePolarity(observation: LearnerObservation): EvidencePolarity {
	if (observation.provenance === "legacyClientGraded") return "inconclusive";
	switch (observation.kind) {
		case "choice":
			return observation.outcome === "correct" ? "supports" : "against";
		case "criterion":
			if (observation.outcome === "met") return "supports";
			if (observation.outcome === "unassessed") return "inconclusive";
			return "against";
		case "practiceConclusion":
			if (observation.outcome === "solved") return "supports";
			if (observation.outcome === "movedOn") return "inconclusive";
			return "against";
	}
}

export type SubjectSkillTargetStatus = "current" | "historical" | "retired" | "missingSkill" | "missingMap";

/** Where a stored association target stands against the map as it is now. */
export function subjectSkillTargetStatus(map: SubjectMapV1 | null, target: LearningTargetRef): SubjectSkillTargetStatus {
	if (!map || map.id !== target.mapId) return "missingMap";
	const skill = map.skills.find((candidate) => candidate.id === target.skillId);
	if (skill) return skill.revision === target.skillRevision ? "current" : "historical";
	return map.retired.some((retired) => retired.id === target.skillId) ? "retired" : "missingSkill";
}

export interface SubjectEvidenceItem {
	evidenceId: string;
	skillRevision: number;
	attachedAt: string;
	polarity: EvidencePolarity | null;
	observation: LearnerObservation | null;
}

export interface SubjectSkillView {
	skill: SubjectSkill;
	prerequisites: string[];
	isGoal: boolean;
	inClosure: boolean;
	paths: GoalPath[];
	encounter: {
		status: "linked" | "notLinked" | "unavailable";
		propositions: { nodeId: string; name: string | null; status: "available" | "unavailable" }[];
	};
	selfReport: {
		status: "reported" | "none" | "unavailable";
		claims: { topicId: string; claim: LearnerTopicClaim | null }[];
	};
	evidence: {
		status: SkillEvidenceStatus;
		current: SubjectEvidenceItem[];
		historical: SubjectEvidenceItem[];
		unavailableSources: number;
		reviewNeeded: boolean;
	};
}

export interface SubjectMapGapView {
	mapId: string;
	mapRevision: number;
	goals: string[];
	/** Every skill, prerequisites first. */
	skills: SubjectSkillView[];
	/** Closure skills without supporting current evidence, prerequisites first. */
	gaps: { skillId: string; status: SkillEvidenceStatus; paths: GoalPath[] }[];
	evidenceAvailability: "available" | "partial" | "unavailable";
}

export interface SubjectMapGapInput {
	map: SubjectMapV1;
	goals?: readonly string[];
	associations:
		| { availability: "unavailable" }
		| {
				availability: "available";
				items: { evidenceId: string; target: LearningTargetRef; attachedAt: string; observation: LearnerObservation | null }[];
		  };
	topics: { availability: "unavailable" } | { availability: "available"; claims: readonly LearnerTopicClaim[] };
	propositions: { availability: "unavailable" } | { availability: "available"; names: ReadonlyMap<string, string> };
}

function evidenceStatus(current: SubjectEvidenceItem[], unavailableSources: number): SkillEvidenceStatus {
	const available = current.filter((item) => item.observation);
	const supports = available.some((item) => item.polarity === "supports");
	const against = available.some((item) => item.polarity === "against");
	if (supports && against) return "mixed";
	if (supports) return "supporting";
	if (against) return "needsPractice";
	if (available.length) return "inconclusive";
	return unavailableSources > 0 ? "unavailable" : "notChecked";
}

/** The goal view: closure, path explanations and the three axes per skill. */
export function projectSubjectMapGaps(input: SubjectMapGapInput): SubjectMapGapView {
	const { map } = input;
	const goals = (input.goals ?? map.goals).filter((goal) => map.skills.some((skill) => skill.id === goal));
	const closure = prerequisiteClosure(map, goals);
	const prerequisites = new Map<string, string[]>(map.skills.map((skill) => [skill.id, []]));
	for (const edge of map.edges) prerequisites.get(edge.dependent)?.push(edge.prerequisite);
	const byId = new Map(map.skills.map((skill) => [skill.id, skill]));
	const topicsById = input.topics.availability === "available"
		? new Map(input.topics.claims.map((claim) => [claim.id, claim]))
		: null;
	let anyUnavailableSource = false;
	const skills = topologicalSkillOrder(map).map((skillId): SubjectSkillView => {
		const skill = byId.get(skillId)!;
		const propositionLinks = map.links.propositions.filter((link) => link.skillId === skillId);
		const topicLinks = map.links.topics.filter((link) => link.skillId === skillId);
		const encounter: SubjectSkillView["encounter"] = input.propositions.availability === "unavailable"
			? { status: propositionLinks.length ? "unavailable" : "notLinked", propositions: propositionLinks.map((link) => ({ nodeId: link.nodeId, name: null, status: "unavailable" })) }
			: (() => {
					const names = input.propositions.names;
					const propositions = propositionLinks.map((link) => {
						const name = names.get(link.nodeId);
						return { nodeId: link.nodeId, name: name ?? null, status: name === undefined ? "unavailable" as const : "available" as const };
					});
					return {
						status: propositions.some((item) => item.status === "available") ? "linked" : propositions.length ? "unavailable" : "notLinked",
						propositions,
					};
				})();
		const claims = topicLinks.map((link) => ({ topicId: link.topicId, claim: topicsById?.get(link.topicId) ?? null }));
		const selfReport: SubjectSkillView["selfReport"] = {
			status: claims.some((item) => item.claim) ? "reported" : claims.length || (!topicsById && topicLinks.length) ? "unavailable" : "none",
			claims,
		};
		let evidence: SubjectSkillView["evidence"];
		if (input.associations.availability === "unavailable") {
			evidence = { status: "unavailable", current: [], historical: [], unavailableSources: 0, reviewNeeded: false };
		} else {
			const items = input.associations.items
				.filter((item) => item.target.kind === "subject-skill" && item.target.mapId === map.id && item.target.skillId === skillId)
				.map((item): SubjectEvidenceItem => ({
					evidenceId: item.evidenceId,
					skillRevision: item.target.skillRevision,
					attachedAt: item.attachedAt,
					polarity: item.observation ? evidencePolarity(item.observation) : null,
					observation: item.observation,
				}));
			const current = items.filter((item) => item.skillRevision === skill.revision);
			const historical = items.filter((item) => item.skillRevision !== skill.revision);
			const unavailableSources = current.filter((item) => !item.observation).length;
			if (unavailableSources) anyUnavailableSource = true;
			evidence = {
				status: evidenceStatus(current, unavailableSources),
				current,
				historical,
				unavailableSources,
				reviewNeeded: historical.length > 0,
			};
		}
		const paths = closure.get(skillId) ?? [];
		return {
			skill,
			prerequisites: prerequisites.get(skillId) ?? [],
			isGoal: goals.includes(skillId),
			inClosure: paths.length > 0,
			paths,
			encounter,
			selfReport,
			evidence,
		};
	});
	return {
		mapId: map.id,
		mapRevision: map.revision,
		goals,
		skills,
		gaps: skills
			.filter((view) => view.inClosure && view.evidence.status !== "supporting")
			.map((view) => ({ skillId: view.skill.id, status: view.evidence.status, paths: view.paths })),
		evidenceAvailability: input.associations.availability === "unavailable"
			? "unavailable"
			: anyUnavailableSource ? "partial" : "available",
	};
}

export function skillEvidenceStatusLabel(status: SkillEvidenceStatus): string {
	switch (status) {
		case "notChecked": return "Not checked";
		case "supporting": return "Supporting evidence";
		case "needsPractice": return "Needs practice";
		case "mixed": return "Mixed evidence";
		case "inconclusive": return "Inconclusive";
		case "unavailable": return "Evidence unavailable";
	}
}
