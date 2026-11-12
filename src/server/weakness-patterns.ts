import type { WeaknessPattern, WeaknessPatternOccurrence, WeaknessPatternStatus, LearnerProfileV1 } from "../core/contracts/learner.ts";
import { LEARNER_LIMITS } from "../core/contracts/learner.ts";
import { normalizeQuoteText, quoteInText } from "../core/familiarity.ts";
import { learnerTargetProblems } from "../core/learner.ts";
import { asAgentMessages, nativeInputCause, type LhMessage } from "../core/native-messages.ts";
import { invalidInputResult } from "../agent/tool-execute.ts";
import type { NotePatternToolInput } from "../agent/tools/note-pattern.ts";
import { LearnerProfileConflictError, LearnerProfileUnavailableError } from "../store/learner.ts";
import { stores } from "./stores.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectResponseStrings(value: unknown, strings: string[], visited = new Set<object>()): void {
	if (!value || typeof value !== "object" || visited.has(value)) return;
	visited.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectResponseStrings(item, strings, visited);
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if ((key === "text" || key === "source") && typeof item === "string") strings.push(item);
		else if (key === "fields" && Array.isArray(item)) collectResponseStrings(item, strings, visited);
	}
}

function userMessageContainsQuote(message: LhMessage, quote: string): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return quoteInText(quote, message.content);
	return message.content.some((part) => part.type === "text" && quoteInText(quote, part.text));
}

function answerContainsQuote(message: LhMessage, history: readonly LhMessage[], quote: string): boolean {
	if (message.role !== "toolResult" || nativeInputCause(message, asAgentMessages(history)) !== "learner") return false;
	const details = message.details;
	if (!isRecord(details) || !Array.isArray(details.partResponses)) return false;
	const strings: string[] = [];
	collectResponseStrings(details.partResponses, strings);
	return strings.some((value) => quoteInText(quote, value));
}

function quoteSource(record: { messages: LhMessage[] }, quote: string): LhMessage | null {
	for (let index = record.messages.length - 1; index >= 0; index--) {
		const message = record.messages[index]!;
		if (
			userMessageContainsQuote(message, quote) ||
			answerContainsQuote(message, record.messages.slice(0, index), quote)
		) return message;
	}
	return null;
}

function casefold(value: string): string {
	return value.split("ı").map((part) => part.toUpperCase().toLowerCase().replace(/ß/g, "ss")).join("ı");
}

function mergeKey(subject: string, pattern: string): string {
	return `${casefold(subject.trim())}\u0000${casefold(pattern.trim())}`;
}

function profileFields(profile: {
	background: LearnerProfileV1["background"];
	coursework: LearnerProfileV1["coursework"];
	topics: LearnerProfileV1["topics"];
	excerpts: LearnerProfileV1["excerpts"];
	associations: LearnerProfileV1["associations"];
	suggestions?: LearnerProfileV1["suggestions"];
	patterns?: LearnerProfileV1["patterns"];
}) {
	return {
		background: profile.background,
		coursework: profile.coursework,
		topics: profile.topics,
		excerpts: profile.excerpts,
		associations: profile.associations,
		suggestions: profile.suggestions,
		patterns: profile.patterns,
	};
}

function recorded(text: string, details: Record<string, string | number | boolean>) {
	return { content: [{ type: "text" as const, text }], details };
}

export function notePatternFromChat(chatId: string, input: NotePatternToolInput) {
	const subjectInput = typeof input.subject === "string" ? input.subject : "";
	const patternInput = typeof input.pattern === "string" ? input.pattern : "";
	const subject = subjectInput.trim();
	const pattern = patternInput.trim();
	const quote = typeof input.quote === "string" ? input.quote : "";
	const problems: string[] = [];
	if (!subject || subjectInput.length > LEARNER_LIMITS.patternSubjectChars) {
		problems.push(`subject must be non-empty and at most ${LEARNER_LIMITS.patternSubjectChars} characters`);
	}
	if (!pattern || patternInput.length > LEARNER_LIMITS.patternChars) {
		problems.push(`pattern must be non-empty and at most ${LEARNER_LIMITS.patternChars} characters`);
	}
	if (!quote.trim() || quote.length > LEARNER_LIMITS.patternQuoteChars) {
		problems.push(`quote must be non-empty and at most ${LEARNER_LIMITS.patternQuoteChars} characters`);
	}
	if (problems.length) return invalidInputResult("note_pattern", problems);
	if (!quoteInText(quote, quote)) {
		return invalidInputResult("note_pattern", ["quote must appear verbatim in the learner's own words or submitted answer"]);
	}
	if (input.target !== undefined) {
		const targetProblems = learnerTargetProblems(input.target);
		if (targetProblems.length) return invalidInputResult("note_pattern", targetProblems);
		const target = input.target;
		const mapRead = stores.subjectMapStore.read(target.mapId);
		if (mapRead.state === "absent") {
			return invalidInputResult("note_pattern", ["target must reference an existing subject map"]);
		}
		if (mapRead.state !== "ok") {
			return invalidInputResult("note_pattern", ["target subject map is unavailable"]);
		}
		if (!mapRead.map.skills.some((skill) => skill.id === target.skillId)) {
			return invalidInputResult("note_pattern", ["target must reference a skill in the specified subject map"]);
		}
	}

	const record = stores.chatStore.getChat(chatId);
	if (!record) return invalidInputResult("note_pattern", ["This session is unavailable."]);
	const source = quoteSource(record, quote);
	if (!source) {
		return invalidInputResult("note_pattern", ["quote must appear verbatim in the learner's own words or submitted answer in this session"]);
	}
	const occurrence: WeaknessPatternOccurrence = {
		chatId,
		messageId: source.id,
		quote: normalizeQuoteText(quote),
		at: new Date().toISOString(),
		...(input.target ? { target: { ...input.target } } : {}),
	};
	const key = mergeKey(subject, pattern);

	for (let attempt = 0; attempt < 2; attempt++) {
		const read = stores.learnerProfileStore.read();
		if (read.state !== "ok" && read.state !== "absent") throw new LearnerProfileUnavailableError(read);
		const patterns = read.profile.patterns ?? [];
		const index = patterns.findIndex((candidate) => mergeKey(candidate.subject, candidate.pattern) === key);
		const existing = patterns[index];
		if (existing?.status === "dismissed") {
			return recorded("This weakness pattern was dismissed by the owner; do not record it again.", {
				recorded: false,
				dismissed: true,
				patternId: existing.id,
			});
		}
		if (existing?.occurrences.some((item) => item.messageId === occurrence.messageId && item.quote === occurrence.quote)) {
			return recorded("This learner quote is already recorded for the weakness pattern.", {
				recorded: false,
				duplicate: true,
				patternId: existing.id,
				occurrenceCount: existing.occurrences.length,
			});
		}
		if (!existing && patterns.length >= LEARNER_LIMITS.patterns) {
			return invalidInputResult("note_pattern", [`The learner profile already has ${LEARNER_LIMITS.patterns} weakness patterns.`]);
		}

		const now = new Date().toISOString();
		const nextPattern: WeaknessPattern = existing
			? {
					...existing,
					status: existing.status === "resolved" ? "active" : existing.status,
					occurrences: [...existing.occurrences, occurrence].slice(-LEARNER_LIMITS.patternOccurrences),
					updatedAt: now,
				}
			: {
					id: crypto.randomUUID(),
					subject,
					pattern,
					status: "active",
					occurrences: [occurrence],
					createdAt: now,
					updatedAt: now,
				};
		const nextPatterns = existing
			? patterns.map((candidate, candidateIndex) => candidateIndex === index ? nextPattern : candidate)
			: [...patterns, nextPattern];
		try {
			stores.learnerProfileStore.replace({
				...profileFields(read.profile),
				patterns: nextPatterns,
			}, read.profile.revision);
			return recorded(`Recorded the ${subject} weakness pattern “${pattern}” from the learner's own work. This is not evidence.`, {
				recorded: true,
				patternId: nextPattern.id,
				occurrenceCount: nextPattern.occurrences.length,
				status: nextPattern.status,
			});
		} catch (error) {
			if (!(error instanceof LearnerProfileConflictError) || attempt === 1) throw error;
		}
	}
	throw new Error("Unable to record weakness pattern.");
}

export function listWeaknessPatterns() {
	const read = stores.learnerProfileStore.read();
	const patterns = read.state === "ok" || read.state === "absent" ? read.profile.patterns ?? [] : null;
	const targetTitles = new Map<string, string | undefined>();
	const titleFor = (target: NonNullable<WeaknessPatternOccurrence["target"]>) => {
		const key = `${target.mapId}\u0000${target.skillId}\u0000${target.skillRevision}`;
		if (!targetTitles.has(key)) targetTitles.set(key, weaknessPatternTargetTitle(target));
		return targetTitles.get(key);
	};
	return {
		state: read.state,
		patterns: patterns?.map((pattern) => ({
			...pattern,
			occurrences: pattern.occurrences.map((occurrence) => ({
				...occurrence,
				...(occurrence.target ? { targetTitle: titleFor(occurrence.target) } : {}),
			})),
		})) ?? null,
		profileRevision: read.state === "ok" || read.state === "absent" ? read.profile.revision : null,
	};
}

export function weaknessPatternTargetTitle(target: NonNullable<WeaknessPatternOccurrence["target"]>): string | undefined {
	const mapRead = stores.subjectMapStore.read(target.mapId);
	if (mapRead.state !== "ok") return undefined;
	const skill = mapRead.map.skills.find((item) => item.id === target.skillId);
	return skill ? `${mapRead.map.title} — ${skill.title}` : undefined;
}

export class WeaknessPatternNotFoundError extends Error {
	constructor(id: string) {
		super(`Unknown weakness pattern id: ${id}`);
		this.name = "WeaknessPatternNotFoundError";
	}
}

export function setWeaknessPatternStatus(
	id: string,
	status: WeaknessPatternStatus,
	expectedRevision: number,
) {
	const read = stores.learnerProfileStore.read();
	if (read.state !== "ok" && read.state !== "absent") throw new LearnerProfileUnavailableError(read);
	if (read.profile.revision !== expectedRevision) throw new LearnerProfileConflictError(read);
	const patterns = read.profile.patterns ?? [];
	const pattern = patterns.find((item) => item.id === id);
	if (!pattern) throw new WeaknessPatternNotFoundError(id);
	if (pattern.status === status) return read.profile;
	const updatedAt = new Date().toISOString();
	return stores.learnerProfileStore.replace({
		...profileFields(read.profile),
		patterns: patterns.map((item) => item.id === id ? { ...item, status, updatedAt } : item),
	}, expectedRevision);
}
