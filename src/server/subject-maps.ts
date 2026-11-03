import { getGraph } from "../core/graph.ts";
import type {
	LearnerObservation,
	LearnerProfileV1,
	PortableSubjectMapV1,
	SubjectMapRead,
	SubjectMapSummary,
	SubjectMapV1,
} from "../core/contracts.ts";
import type { LearningTargetRef } from "../core/contracts/learning-target.ts";
import { SUBJECT_MAP_LIMITS } from "../core/contracts/subject-map.ts";
import type { SubjectSkill } from "../core/contracts/subject-map.ts";
import {
	jsonDepthExceeds,
	parsePortableSubjectMap,
	portableSubjectMap,
	projectSubjectMapGaps,
	retainSubjectMapLinks,
	reviseSubjectMapDefinition,
	subjectSkillTargetStatus,
	type SubjectMapGapView,
	type SubjectSkillTargetStatus,
} from "../core/subject-map.ts";
import {
	SubjectMapConflictError,
	SubjectMapLimitError,
	SubjectMapUnavailableError,
} from "../store/subject-maps.ts";
import {
	attachEvidenceTarget,
	detachEvidenceTarget,
	getLearnerObservation,
	LearnerEvidenceUnavailableError,
	learnerJsonResponse,
	learnerProfileWriteErrorResponse,
	readLearnerJsonRequest,
} from "./learner.ts";
import { stores } from "./stores.ts";

export { SubjectMapConflictError, SubjectMapLimitError, SubjectMapUnavailableError };

export class SubjectMapValidationError extends Error {
	constructor(public readonly issues: string[]) {
		super("Invalid subject map.");
		this.name = "SubjectMapValidationError";
	}
}

export class SubjectSkillUnavailableError extends Error {
	constructor(public readonly skillId: string, public readonly status: SubjectSkillTargetStatus) {
		super("Subject skill is not current in this map.");
		this.name = "SubjectSkillUnavailableError";
	}
}

export class SubjectSkillRevisionConflictError extends Error {
	constructor(public readonly current: SubjectSkill) {
		super("The skill objective changed since you loaded it.");
		this.name = "SubjectSkillRevisionConflictError";
	}
}

export class SubjectLinkSourceUnavailableError extends Error {
	constructor(public readonly kind: "proposition" | "topic", public readonly refId: string) {
		super(kind === "proposition" ? "Proposition is not in the knowledge graph." : "Topic is not in the learner profile.");
		this.name = "SubjectLinkSourceUnavailableError";
	}
}

export function listSubjectMaps(): SubjectMapSummary[] {
	return stores.subjectMapStore.list();
}

export function readSubjectMap(id: string): SubjectMapRead {
	return stores.subjectMapStore.read(id);
}

function requireMap(id: string): SubjectMapV1 {
	const read = stores.subjectMapStore.read(id);
	if (read.state !== "ok") throw new SubjectMapUnavailableError(read.state);
	return read.map;
}

export function createSubjectMap(input: unknown): SubjectMapV1 {
	const revised = reviseSubjectMapDefinition(null, input, new Date().toISOString());
	if (!revised.ok) throw new SubjectMapValidationError(revised.issues);
	return stores.subjectMapStore.create(revised.definition);
}

export interface SubjectMapImportPreview {
	title: string;
	skills: number;
	edges: number;
	goals: number;
	retired: number;
	definition: PortableSubjectMapV1;
}

/** Validates curriculum JSON without writing anything or calling a model. */
export function previewSubjectMapImport(curriculum: unknown):
	| { ok: true; preview: SubjectMapImportPreview }
	| { ok: false; issues: string[] } {
	const parsed = parsePortableSubjectMap(curriculum, new Date().toISOString());
	if (!parsed.ok) return parsed;
	const definition = parsed.definition;
	return {
		ok: true,
		preview: {
			title: definition.title,
			skills: definition.skills.length,
			edges: definition.edges.length,
			goals: definition.goals.length,
			retired: definition.retired.length,
			definition: portableSubjectMap(definition),
		},
	};
}

export function importSubjectMap(curriculum: unknown): SubjectMapV1 {
	const parsed = parsePortableSubjectMap(curriculum, new Date().toISOString());
	if (!parsed.ok) throw new SubjectMapValidationError(parsed.issues);
	return stores.subjectMapStore.create(parsed.definition);
}

export function updateSubjectMap(id: string, input: unknown, expectedRevision: number): SubjectMapV1 {
	const current = requireMap(id);
	if (current.revision !== expectedRevision) throw new SubjectMapConflictError(current);
	const revised = reviseSubjectMapDefinition(current, input, new Date().toISOString());
	if (!revised.ok) throw new SubjectMapValidationError(revised.issues);
	return stores.subjectMapStore.replace(id, {
		...revised.definition,
		links: retainSubjectMapLinks(current.links, revised.definition.skills),
	}, expectedRevision);
}

export function deleteSubjectMap(id: string, expectedRevision: number): void {
	stores.subjectMapStore.remove(id, expectedRevision);
}

export function exportSubjectMap(id: string): PortableSubjectMapV1 {
	return portableSubjectMap(requireMap(id));
}

function graphNames(): Map<string, string> {
	return new Map(getGraph(stores.graphStore).nodes.map((node) => [node.id, node.name]));
}

function readableProfile(): LearnerProfileV1 | null {
	const read = stores.learnerProfileStore.read();
	return read.state === "absent" || read.state === "ok" ? read.profile : null;
}

export type SubjectLinkKind = "proposition" | "topic";

/** Explicitly links a skill to an encountered proposition or a self-reported profile topic. */
export function linkSubjectSkill(id: string, input: {
	kind: SubjectLinkKind;
	skillId: string;
	refId: string;
	expectedRevision: number;
}): SubjectMapV1 {
	const map = requireMap(id);
	if (map.revision !== input.expectedRevision) throw new SubjectMapConflictError(map);
	if (!map.skills.some((skill) => skill.id === input.skillId)) {
		throw new SubjectSkillUnavailableError(input.skillId, map.retired.some((skill) => skill.id === input.skillId) ? "retired" : "missingSkill");
	}
	if (input.kind === "proposition") {
		if (!graphNames().has(input.refId)) throw new SubjectLinkSourceUnavailableError("proposition", input.refId);
	} else {
		const profile = readableProfile();
		if (!profile?.topics.some((topic) => topic.id === input.refId)) throw new SubjectLinkSourceUnavailableError("topic", input.refId);
	}
	const key = input.kind === "proposition" ? "propositions" : "topics";
	const existing = input.kind === "proposition"
		? map.links.propositions.some((link) => link.skillId === input.skillId && link.nodeId === input.refId)
		: map.links.topics.some((link) => link.skillId === input.skillId && link.topicId === input.refId);
	if (existing) return map;
	if (map.links[key].length >= SUBJECT_MAP_LIMITS.links) throw new SubjectMapValidationError([`at most ${SUBJECT_MAP_LIMITS.links} ${key} links`]);
	const linkedAt = new Date().toISOString();
	const links = input.kind === "proposition"
		? { ...map.links, propositions: [...map.links.propositions, { skillId: input.skillId, nodeId: input.refId, linkedAt }] }
		: { ...map.links, topics: [...map.links.topics, { skillId: input.skillId, topicId: input.refId, linkedAt }] };
	return stores.subjectMapStore.replace(id, { ...definitionOf(map), links }, input.expectedRevision);
}

export function unlinkSubjectSkill(id: string, input: {
	kind: SubjectLinkKind;
	skillId: string;
	refId: string;
	expectedRevision: number;
}): SubjectMapV1 {
	const map = requireMap(id);
	if (map.revision !== input.expectedRevision) throw new SubjectMapConflictError(map);
	const links = input.kind === "proposition"
		? { ...map.links, propositions: map.links.propositions.filter((link) => link.skillId !== input.skillId || link.nodeId !== input.refId) }
		: { ...map.links, topics: map.links.topics.filter((link) => link.skillId !== input.skillId || link.topicId !== input.refId) };
	if (links.propositions.length === map.links.propositions.length && links.topics.length === map.links.topics.length) return map;
	return stores.subjectMapStore.replace(id, { ...definitionOf(map), links }, input.expectedRevision);
}

function definitionOf(map: SubjectMapV1) {
	return {
		title: map.title,
		description: map.description,
		...(map.regions === undefined ? {} : { regions: map.regions }),
		skills: map.skills,
		edges: map.edges,
		goals: map.goals,
		retired: map.retired,
	};
}

/** The goal closure and three-axis status for every skill of a map. */
export function subjectMapGapView(map: SubjectMapV1): SubjectMapGapView {
	let profile: LearnerProfileV1 | null = null;
	try {
		profile = readableProfile();
	} catch (error) {
		console.error("[subject maps] profile read failed:", error);
	}
	const observations = new Map<string, LearnerObservation | null>();
	const items = profile
		? profile.associations
				.filter((association) => association.target.mapId === map.id)
				.map((association) => {
					if (!observations.has(association.evidenceId)) {
						let observation: LearnerObservation | null = null;
						try {
							const read = getLearnerObservation(association.evidenceId);
							observation = read.status === "available" ? read.observation : null;
						} catch {
							observation = null;
						}
						observations.set(association.evidenceId, observation);
					}
					return { ...association, observation: observations.get(association.evidenceId) ?? null };
				})
		: [];
	let names: Map<string, string> | null = null;
	try {
		names = graphNames();
	} catch (error) {
		console.error("[subject maps] graph read failed:", error);
	}
	return projectSubjectMapGaps({
		map,
		associations: profile ? { availability: "available", items } : { availability: "unavailable" },
		topics: profile ? { availability: "available", claims: profile.topics } : { availability: "unavailable" },
		propositions: names ? { availability: "available", names } : { availability: "unavailable" },
	});
}

/** Resolves the map's current skill revision, then records the association through the learner service. */
export function attachSkillEvidence(input: {
	evidenceId: string;
	mapId: string;
	skillId: string;
	skillRevision?: number;
	expectedRevision: number;
}): LearnerProfileV1 {
	const map = requireMap(input.mapId);
	const skill = map.skills.find((candidate) => candidate.id === input.skillId);
	if (!skill) {
		throw new SubjectSkillUnavailableError(input.skillId, map.retired.some((retired) => retired.id === input.skillId) ? "retired" : "missingSkill");
	}
	if (input.skillRevision !== undefined && input.skillRevision !== skill.revision) {
		throw new SubjectSkillRevisionConflictError(skill);
	}
	return attachEvidenceTarget({
		evidenceId: input.evidenceId,
		target: { kind: "subject-skill", mapId: map.id, skillId: skill.id, skillRevision: skill.revision },
		expectedRevision: input.expectedRevision,
	});
}

/** Removes an association; works for deleted maps and retired skills so stale links can be cleaned up. */
export function detachSkillEvidence(input: {
	evidenceId: string;
	target: LearningTargetRef;
	expectedRevision: number;
}): LearnerProfileV1 {
	return detachEvidenceTarget(input);
}

export interface LearnerTargetLink {
	evidenceId: string;
	target: LearningTargetRef;
	attachedAt: string;
	sourceStatus: "available" | "unavailable";
	targetStatus: SubjectSkillTargetStatus | "mapUnavailable";
	mapTitle: string | null;
	skillTitle: string | null;
}

/** Every explicit evidence → skill link with its source and target standing. */
export function listLearnerTargetLinks():
	| { availability: "available"; profileRevision: number; links: LearnerTargetLink[] }
	| { availability: "unavailable" } {
	const profile = readableProfile();
	if (!profile) return { availability: "unavailable" };
	const maps = new Map<string, SubjectMapRead>();
	return {
		availability: "available",
		profileRevision: profile.revision,
		links: profile.associations.map((association) => {
			if (!maps.has(association.target.mapId)) maps.set(association.target.mapId, stores.subjectMapStore.read(association.target.mapId));
			const read = maps.get(association.target.mapId)!;
			const map = read.state === "ok" ? read.map : null;
			const skill = map?.skills.find((candidate) => candidate.id === association.target.skillId)
				?? map?.retired.find((candidate) => candidate.id === association.target.skillId);
			let sourceStatus: "available" | "unavailable" = "unavailable";
			try {
				sourceStatus = getLearnerObservation(association.evidenceId).status;
			} catch {
				sourceStatus = "unavailable";
			}
			return {
				evidenceId: association.evidenceId,
				target: association.target,
				attachedAt: association.attachedAt,
				sourceStatus,
				targetStatus: read.state === "corrupt" || read.state === "future" ? "mapUnavailable" : subjectSkillTargetStatus(map, association.target),
				mapTitle: map?.title ?? null,
				skillTitle: skill?.title ?? null,
			};
		}),
	};
}

// ─── transport helpers ───────────────────────────────────────────────────────

export function subjectMapEtag(map: SubjectMapV1): string {
	return `"${map.revision}"`;
}

/** The revision an If-Match header names: null when absent, NaN when malformed or a list. */
export function ifMatchRevision(request: Request): number | null {
	const header = request.headers.get("if-match");
	if (header === null) return null;
	const match = /^"([1-9][0-9]{0,15})"$/.exec(header.trim());
	return match ? Number(match[1]) : Number.NaN;
}

export function subjectMapJson(body: unknown, status = 200, map?: SubjectMapV1): Response {
	const response = learnerJsonResponse(body, status);
	if (map) response.headers.set("ETag", subjectMapEtag(map));
	return response;
}

export async function readSubjectMapJsonRequest(request: Request) {
	const parsed = await readLearnerJsonRequest(request);
	if (parsed.ok && jsonDepthExceeds(parsed.value, SUBJECT_MAP_LIMITS.jsonDepth + 2)) {
		return { ok: false as const, status: 400 as const, error: "Request JSON is nested too deeply." };
	}
	return parsed;
}

/** Requires a well-formed If-Match header, answering 428/412 otherwise. */
export function requireIfMatch(request: Request): { ok: true; revision: number } | { ok: false; response: Response } {
	const revision = ifMatchRevision(request);
	if (revision === null) {
		return { ok: false, response: subjectMapJson({ error: "If-Match with the map ETag is required.", code: "precondition_required" }, 428) };
	}
	if (!Number.isSafeInteger(revision)) {
		return { ok: false, response: subjectMapJson({ error: "If-Match must be a single map ETag.", code: "precondition_failed" }, 412) };
	}
	return { ok: true, revision };
}

export function subjectMapErrorResponse(error: unknown): Response | null {
	if (error instanceof SubjectSkillRevisionConflictError) {
		return subjectMapJson({ error: error.message, code: "skill_revision_conflict", current: error.current }, 409);
	}
	if (error instanceof SubjectMapConflictError) {
		return subjectMapJson({ error: "Map changed since you loaded it.", code: "revision_conflict", current: error.current }, 412, error.current);
	}
	if (error instanceof SubjectMapUnavailableError) {
		return error.state === "absent"
			? subjectMapJson({ error: "Map not found.", code: "map_not_found" }, 404)
			: subjectMapJson({ error: "Map cannot be updated.", code: "map_unwritable", state: error.state }, 409);
	}
	if (error instanceof SubjectMapLimitError) return subjectMapJson({ error: error.message, code: "map_limit" }, 409);
	if (error instanceof SubjectMapValidationError) return subjectMapJson({ error: "Invalid subject map.", issues: error.issues }, 400);
	if (error instanceof SubjectSkillUnavailableError) {
		return subjectMapJson({ error: "That skill is not current in this map.", code: "skill_unavailable", status: error.status }, 409);
	}
	if (error instanceof SubjectLinkSourceUnavailableError) {
		return subjectMapJson({ error: error.message, code: "link_source_unavailable" }, 404);
	}
	if (error instanceof LearnerEvidenceUnavailableError) {
		return subjectMapJson({ error: "That evidence is no longer available.", code: "evidence_unavailable" }, 404);
	}
	return learnerProfileWriteErrorResponse(error);
}
