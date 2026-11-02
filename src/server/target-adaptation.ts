import type { ChatRecord, LearnerObservation, SubjectMapRead, SubjectMapV1 } from "../core/contracts.ts";
import type { LearningTargetRef } from "../core/contracts/learning-target.ts";
import {
	projectTargetAdaptation,
	projectTargetAdaptationContext,
	type EvidenceVia,
	type TargetAdaptationView,
	type TargetEvidenceInput,
	type TargetEvidenceItem,
} from "../core/adaptation.ts";
import { deriveChatObservations, learnerTargetProblems } from "../core/learner.ts";
import { isSubjectMapId, isSubjectSkillId, subjectSkillTargetStatus } from "../core/subject-map.ts";
import type { SessionTargetState } from "../agent/tools/target-attribution.ts";
import { getLearnerObservation } from "./learner.ts";
import { stores } from "./stores.ts";

/** Sessions scanned for tutor-attributed evidence, newest first. */
const TARGET_SCAN_CHATS = 50;

function readMap(mapId: string): SubjectMapRead | null {
	if (!isSubjectMapId(mapId)) return { state: "absent" };
	try {
		return stores.subjectMapStore.read(mapId);
	} catch (error) {
		console.error("[target] map read failed:", error);
		return null;
	}
}

function mapOf(read: SubjectMapRead | null): SubjectMapV1 | null {
	return read?.state === "ok" ? read.map : null;
}

/** The session target's standing for this turn's tool gate. */
export function sessionTargetState(record: Pick<ChatRecord, "target">): SessionTargetState {
	if (!record.target) return "none";
	return subjectSkillTargetStatus(mapOf(readMap(record.target.mapId)), record.target) === "current" ? "current" : "unavailable";
}

function gatherEvidence(mapId: string, excludeChatId: string): TargetEvidenceInput {
	const byKey = new Map<string, { skillId: string; item: TargetEvidenceItem }>();
	const add = (skillId: string, revision: number, observation: LearnerObservation, via: EvidenceVia) => {
		const key = `${observation.id}\u0000${skillId}\u0000${revision}`;
		const existing = byKey.get(key);
		if (existing) {
			if (!existing.item.via.includes(via)) existing.item.via.push(via);
			return;
		}
		byKey.set(key, { skillId, item: { observation, via: [via], skillRevision: revision } });
	};
	const unavailableLinks = new Map<string, number>();
	let profileAssociations: { evidenceId: string; target: LearningTargetRef }[] = [];
	try {
		const read = stores.learnerProfileStore.read();
		if (read.state === "ok" || read.state === "absent") profileAssociations = read.profile.associations;
	} catch (error) {
		console.error("[target] profile read failed:", error);
	}
	for (const association of profileAssociations) {
		if (association.target.mapId !== mapId) continue;
		let source: ReturnType<typeof getLearnerObservation>;
		try {
			source = getLearnerObservation(association.evidenceId);
		} catch {
			source = { status: "unavailable" };
		}
		if (source.status === "available") add(association.target.skillId, association.target.skillRevision, source.observation, "linked");
		else unavailableLinks.set(association.target.skillId, (unavailableLinks.get(association.target.skillId) ?? 0) + 1);
	}
	const ids = stores.chatStore.listChatIdsByRecency().filter((id) => id !== excludeChatId);
	let scannedChats = 0;
	let unreadableChats = 0;
	for (const chatId of ids.slice(0, TARGET_SCAN_CHATS)) {
		scannedChats++;
		const record = stores.chatStore.getChat(chatId);
		if (!record) {
			unreadableChats++;
			continue;
		}
		if (record.target?.mapId !== mapId) continue;
		let derived: LearnerObservation[];
		try {
			derived = deriveChatObservations(record);
		} catch {
			unreadableChats++;
			continue;
		}
		for (const observation of derived) {
			const target = observation.attributedTarget;
			if (target?.mapId === mapId) add(target.skillId, target.skillRevision, observation, "tutor");
		}
	}
	return { items: [...byKey.values()], unavailableLinks, coverage: { scannedChats, totalChats: ids.length, unreadableChats } };
}

/**
 * The inspectable advice for a session's target, built from other sessions'
 * canonical evidence (this session's own transcript is already in context).
 */
export function targetAdaptationFor(record: Pick<ChatRecord, "id" | "target">): TargetAdaptationView | null {
	if (!record.target) return null;
	const read = readMap(record.target.mapId);
	return projectTargetAdaptation({
		target: record.target,
		map: mapOf(read),
		mapUnavailable: read === null || read.state === "corrupt" || read.state === "future",
		evidence: gatherEvidence(record.target.mapId, record.id),
	});
}

/** The model-facing target block, or null for sessions without a target. */
export function targetContextFor(record: Pick<ChatRecord, "id" | "target">): string | null {
	try {
		const view = targetAdaptationFor(record);
		return view ? projectTargetAdaptationContext(view) : null;
	} catch (error) {
		console.error("[target] context read failed:", error);
		return null;
	}
}

export type NewSessionTarget =
	| { ok: true; target: LearningTargetRef | undefined }
	| { ok: false; status: 400 | 404 | 409; error: string; code: string };

/** Validates a creation-time target: the named skill must exist at exactly the revision the learner saw. */
export function resolveNewSessionTarget(value: unknown): NewSessionTarget {
	if (value === undefined || value === null) return { ok: true, target: undefined };
	const candidate = typeof value === "object" && !Array.isArray(value) ? { kind: "subject-skill", ...(value as Record<string, unknown>) } : value;
	const problems = learnerTargetProblems(candidate);
	const ref = candidate as LearningTargetRef;
	if (problems.length || !isSubjectMapId(ref.mapId) || !isSubjectSkillId(ref.skillId)) {
		return { ok: false, status: 400, error: problems[0] ?? "target must name an existing map and skill", code: "invalid_target" };
	}
	const read = readMap(ref.mapId);
	if (read === null || read.state === "corrupt" || read.state === "future") {
		return { ok: false, status: 409, error: "The subject map cannot be read.", code: "map_unavailable" };
	}
	const status = subjectSkillTargetStatus(mapOf(read), ref);
	if (status === "missingMap") return { ok: false, status: 404, error: "The subject map no longer exists.", code: "map_missing" };
	if (status === "historical") return { ok: false, status: 409, error: "The skill's objective changed. Reload the map and try again.", code: "skill_revision_conflict" };
	if (status !== "current") return { ok: false, status: 409, error: "The skill is no longer in the map.", code: "skill_unavailable" };
	return { ok: true, target: { kind: "subject-skill", mapId: ref.mapId, skillId: ref.skillId, skillRevision: ref.skillRevision } };
}
