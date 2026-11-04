import {
	deriveChatObservations,
	learnerTargetMatches,
	learnerTargetProblems,
	parseLearnerObservationId,
	projectLearnerContext,
} from "../core/learner.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type {
	LearnerEvidenceAssociation,
	LearnerObservation,
	LearnerProfileRead,
	LearnerProfileV1,
} from "../core/contracts.ts";
import type { LearningTargetRef } from "../core/contracts/learning-target.ts";
import { LEARNER_LIMITS } from "../core/contracts/learner.ts";
import { LearnerProfileConflictError, LearnerProfileUnavailableError } from "../store/learner.ts";
import { isValidHostedImportName, readHostedImportRequest } from "./hosted-import.ts";
import { stores } from "./stores.ts";

export interface LearnerEvidencePage {
	availability: "complete" | "partial";
	observations: LearnerObservation[];
	nextCursor: string | null;
	coverage: { scannedChats: number; totalChats: number; unreadableChats: number };
	sources: { chatId: string; updatedAt: string }[];
	profileRevision: number | null;
}

interface LearnerEvidenceCursor {
	afterChatId: string;
	scannedChats: number;
	unreadableChats: number;
}

function decodeLearnerEvidenceCursor(cursor: string | undefined): LearnerEvidenceCursor | null {
	if (!cursor) return null;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<LearnerEvidenceCursor> & { version?: number };
		if (
			value.version === 1 &&
			typeof value.afterChatId === "string" &&
			Number.isInteger(value.scannedChats) && value.scannedChats! >= 0 &&
			Number.isInteger(value.unreadableChats) && value.unreadableChats! >= 0
		) {
			return {
				afterChatId: value.afterChatId,
				scannedChats: value.scannedChats!,
				unreadableChats: value.unreadableChats!,
			};
		}
	} catch {
		// Bare chat ids remain valid for callers holding the earlier cursor form.
	}
	return { afterChatId: cursor, scannedChats: 0, unreadableChats: 0 };
}

function encodeLearnerEvidenceCursor(cursor: LearnerEvidenceCursor): string {
	return Buffer.from(JSON.stringify({ version: 1, ...cursor }), "utf8").toString("base64url");
}

function readableProfile(read: LearnerProfileRead): LearnerProfileV1 | null {
	return read.state === "absent" || read.state === "ok" ? read.profile : null;
}

function withTargets(
	observation: LearnerObservation,
	associations: readonly LearnerEvidenceAssociation[],
): LearnerObservation {
	const targets = associations
		.filter((association) => association.evidenceId === observation.id)
		.map((association) => association.target);
	return { ...observation, targets } as LearnerObservation;
}

function safeProfileRead(): LearnerProfileRead | null {
	try {
		return stores.learnerProfileStore.read();
	} catch (error) {
		console.error("[learner] profile read failed:", error);
		return null;
	}
}

function safeDeriveChatObservations(record: Parameters<typeof deriveChatObservations>[0]): LearnerObservation[] | null {
	try {
		return deriveChatObservations(record);
	} catch {
		return null;
	}
}

export function readLearnerEvidence(input: {
	cursor?: string;
	limit?: number;
	chatBudget?: number;
} = {}): LearnerEvidencePage {
	const ids = stores.chatStore.listChatIds();
	const cursor = decodeLearnerEvidenceCursor(input.cursor);
	const cursorIndex = cursor ? ids.indexOf(cursor.afterChatId) : -1;
	const afterCursor = cursor ? ids.findIndex((id) => id > cursor.afterChatId) : 0;
	const startIndex = cursorIndex >= 0
		? cursorIndex + 1
		: afterCursor < 0
			? ids.length
			: afterCursor;
	const requestedBudget = input.chatBudget ?? 25;
	const chatBudget = Number.isInteger(requestedBudget) && requestedBudget > 0 ? requestedBudget : 25;
	const requestedLimit = input.limit ?? 50;
	const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
		? Math.min(200, requestedLimit)
		: 50;
	const pageIds = ids.slice(startIndex, startIndex + chatBudget);
	const profileRead = safeProfileRead();
	const profile = profileRead ? readableProfile(profileRead) : null;
	const profileRevision = profile ? profile.revision : null;
	const observations: LearnerObservation[] = [];
	const sources: LearnerEvidencePage["sources"] = [];
	let scannedThisPage = 0;
	let unreadableThisPage = 0;
	for (const chatId of pageIds) {
		if (scannedThisPage > 0 && observations.length >= limit) break;
		scannedThisPage++;
		const record = stores.chatStore.getChat(chatId);
		if (!record) {
			unreadableThisPage++;
			continue;
		}
		const derived = safeDeriveChatObservations(record);
		if (!derived) {
			unreadableThisPage++;
			continue;
		}
		sources.push({ chatId, updatedAt: record.updatedAt });
		for (const observation of derived) {
			observations.push(withTargets(observation, profile?.associations ?? []));
		}
	}
	observations.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
	const scannedChats = (cursor?.scannedChats ?? startIndex) + scannedThisPage;
	const unreadableChats = (cursor?.unreadableChats ?? 0) + unreadableThisPage;
	const scannedEnd = startIndex + scannedThisPage;
	const lastScannedChatId = pageIds[scannedThisPage - 1];
	const nextCursor = scannedEnd < ids.length && lastScannedChatId
		? encodeLearnerEvidenceCursor({ afterChatId: lastScannedChatId, scannedChats, unreadableChats })
		: null;
	return {
		availability: nextCursor === null && unreadableChats === 0 && scannedEnd === ids.length ? "complete" : "partial",
		observations,
		nextCursor,
		coverage: {
			scannedChats,
			totalChats: ids.length,
			unreadableChats,
		},
		sources,
		profileRevision,
	};
}

export type LearnerObservationRead =
	| { status: "available"; observation: LearnerObservation }
	| { status: "unavailable" };

export function getLearnerObservation(id: string): LearnerObservationRead {
	const parsed = parseLearnerObservationId(id);
	if (!parsed) return { status: "unavailable" };
	const record = stores.chatStore.getChat(parsed.chatId);
	if (!record) return { status: "unavailable" };
	const derived = safeDeriveChatObservations(record);
	if (!derived) return { status: "unavailable" };
	const observation = derived.find((candidate) => candidate.id === id);
	if (!observation) return { status: "unavailable" };
	const profileRead = safeProfileRead();
	const profile = profileRead ? readableProfile(profileRead) : null;
	return {
		status: "available",
		observation: withTargets(observation, profile?.associations ?? []),
	};
}

export type LearnerAssociationStatus = LearnerEvidenceAssociation & {
	status: "available" | "unavailable";
	observation?: LearnerObservation;
};

export function listEvidenceAssociations(): LearnerAssociationStatus[] {
	const profileRead = safeProfileRead();
	const profile = profileRead ? readableProfile(profileRead) : null;
	if (!profile) return [];
	return profile.associations.map((association) => {
		const source = getLearnerObservation(association.evidenceId);
		return source.status === "available"
			? { ...association, status: "available", observation: source.observation }
			: { ...association, status: "unavailable" };
	});
}

export class LearnerEvidenceUnavailableError extends Error {
	constructor(public readonly evidenceId: string) {
		super("Learner evidence is unavailable.");
		this.name = "LearnerEvidenceUnavailableError";
	}
}

function requireWritableProfile(expectedRevision: number): LearnerProfileV1 {
	const profileRead = stores.learnerProfileStore.read();
	if (profileRead.state === "corrupt" || profileRead.state === "future") {
		throw new LearnerProfileUnavailableError(profileRead);
	}
	if (profileRead.profile.revision !== expectedRevision) {
		throw new LearnerProfileConflictError(profileRead);
	}
	return profileRead.profile;
}

function ensureEvidenceAvailable(evidenceId: string): LearnerObservation {
	const source = getLearnerObservation(evidenceId);
	if (source.status !== "available") throw new LearnerEvidenceUnavailableError(evidenceId);
	return source.observation;
}

export function attachEvidenceTarget(input: {
	evidenceId: string;
	target: LearningTargetRef;
	expectedRevision: number;
}): LearnerProfileV1 {
	const profile = requireWritableProfile(input.expectedRevision);
	const problems = learnerTargetProblems(input.target);
	if (problems.length) throw new Error(problems.join(" "));
	ensureEvidenceAvailable(input.evidenceId);
	const exists = profile.associations.some((association) =>
		association.evidenceId === input.evidenceId && learnerTargetMatches(association.target, input.target),
	);
	if (exists) return profile;
	if (profile.associations.length >= LEARNER_LIMITS.associations) throw new Error("Learner evidence association limit reached.");
	return stores.learnerProfileStore.replace({
		background: profile.background,
		coursework: profile.coursework,
		topics: profile.topics,
		excerpts: profile.excerpts,
		associations: [
			...profile.associations,
			{ evidenceId: input.evidenceId, target: input.target, attachedAt: new Date().toISOString() },
		],
		suggestions: profile.suggestions,
	}, input.expectedRevision);
}

export function detachEvidenceTarget(input: {
	evidenceId: string;
	target: LearningTargetRef;
	expectedRevision: number;
}): LearnerProfileV1 {
	const profile = requireWritableProfile(input.expectedRevision);
	const problems = learnerTargetProblems(input.target);
	if (problems.length) throw new Error(problems.join(" "));
	const associations = profile.associations.filter((association) =>
		association.evidenceId !== input.evidenceId || !learnerTargetMatches(association.target, input.target),
	);
	if (associations.length === profile.associations.length) return profile;
	return stores.learnerProfileStore.replace({
		background: profile.background,
		coursework: profile.coursework,
		topics: profile.topics,
		excerpts: profile.excerpts,
		associations,
		suggestions: profile.suggestions,
	}, input.expectedRevision);
}

export function learnerContextFor(excludeChatId: string): string | null {
	try {
		const profileRead = stores.learnerProfileStore.read();
		const profile = readableProfile(profileRead);
		const contextSources: { record: ChatRecord; observations: LearnerObservation[] }[] = [];
		for (const chatId of stores.chatStore.listChatIdsByRecency()) {
			if (chatId === excludeChatId) continue;
			const record = stores.chatStore.getChat(chatId);
			if (!record) continue;
			const derived = safeDeriveChatObservations(record);
			if (!derived) continue;
			contextSources.push({ record, observations: derived });
			if (contextSources.length >= 20) break;
		}
		const observations: LearnerObservation[] = [];
		for (const source of contextSources) {
			for (const observation of source.observations) {
				observations.push(withTargets(observation, profile?.associations ?? []));
			}
		}
		return projectLearnerContext(profile, observations);
	} catch (error) {
		console.error("[learner] context read failed:", error);
		return null;
	}
}

export async function previewLearnerImport(request: Request): Promise<
	| { ok: true; drafts: { sourceName: string; text: string; bytes: number }[]; excerptLimitBytes: number }
	| { ok: false; status: 400 | 413; error: string }
> {
	const imported = await readHostedImportRequest(request);
	if (!imported.ok) return imported;
	const drafts = imported.files.map(({ name, text }) => {
		const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		return {
			sourceName: name,
			text: normalized,
			bytes: new TextEncoder().encode(normalized).byteLength,
		};
	});
	return { ok: true, drafts, excerptLimitBytes: LEARNER_LIMITS.excerptBytes };
}

export type LearnerJsonRead =
	| { ok: true; value: unknown }
	| { ok: false; status: 400 | 413; error: string };

export async function readLearnerJsonRequest(request: Request): Promise<LearnerJsonRead> {
	if (!request.body) return { ok: false, status: 400, error: "Invalid JSON request." };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > LEARNER_LIMITS.bodyBytes) {
				await reader.cancel();
				return { ok: false, status: 413, error: "Request body too large." };
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, status: 400, error: "Invalid JSON request." };
	} finally {
		reader.releaseLock();
	}
}

export function learnerJsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "private, no-store" },
	});
}

export function learnerProfileWriteErrorResponse(error: unknown): Response | null {
	if (error instanceof LearnerProfileConflictError) {
		return learnerJsonResponse({
			error: "Profile changed since you loaded it.",
			code: "revision_conflict",
			current: error.current,
		}, 409);
	}
	if (error instanceof LearnerProfileUnavailableError) {
		return learnerJsonResponse({
			error: "Learner profile cannot be updated.",
			code: "profile_unwritable",
			state: error.current.state,
		}, 409);
	}
	return null;
}

export function validLearnerImportSourceName(name: string): boolean {
	return isValidHostedImportName(name);
}

export { LearnerProfileConflictError, LearnerProfileUnavailableError };
