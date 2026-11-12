import type { FamiliaritySuggestion, PlacementProbe, PlacementRun, SteerMessage, SubjectMapV1 } from "../core/contracts.ts";
import { PLACEMENT_MAX_PROBES, assessmentSpecOf, deriveChatObservations, modelJudgedSpec } from "../core";
import { decideFamiliaritySuggestions, mergeFamiliaritySuggestions, nextPlacementProbe, placementSuggestionTargets, quoteInText, normalizeQuoteText, projectPlacementContext, suggestionStanding, likelyKnownSkills } from "../core/familiarity.ts";
import { danglingQuestionOf, newPlacementNudgeMessage } from "../core/native-messages.ts";
import { evidencePolarity, subjectSkillTargetStatus } from "../core/subject-map.ts";
import { LearnerProfileConflictError, LearnerProfileUnavailableError } from "../store/learner.ts";
import { runFamiliarityInferrer } from "../agent/subagents/familiarity-inferrer.ts";
import { invalidInputResult } from "../agent/tool-execute.ts";
import type { PiEngine } from "../agent/models.ts";
import { agentCapabilities } from "../agent/capabilities.ts";
import { connectionBackgroundAllowed, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { stores } from "./stores.ts";
import { subjectMapGapView } from "./subject-maps.ts";

export type PlacementResolution =
	| { ok: true; placement?: PlacementRun; target?: { kind: "subject-skill"; mapId: string; skillId: string; skillRevision: number } }
	| { ok: false; status: 400 | 404 | 409; code: string; error: string };

export function resolveNewPlacement(value: unknown): PlacementResolution {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { mapId?: unknown }).mapId !== "string" || !/^map_[A-Za-z0-9-]{1,64}$/.test((value as { mapId: string }).mapId)) {
		return { ok: false, status: 400, code: "invalid_placement", error: "placement must contain a valid mapId" };
	}
	const mapId = (value as { mapId: string }).mapId;
	const read = stores.subjectMapStore.read(mapId);
	if (read.state === "absent") return { ok: false, status: 404, code: "map_missing", error: "Map not found." };
	if (read.state !== "ok") return { ok: false, status: 409, code: "map_unavailable", error: "Map is temporarily unavailable." };
	const view = (awaitlessGapView(read.map));
	const profile = stores.learnerProfileStore.read();
	const likelyKnown = profile.state === "ok" || profile.state === "absent"
		? new Set((profile.profile.suggestions ?? []).filter((s) => s.mapId === mapId && s.status === "confirmed" && subjectSkillTargetStatus(read.map, { kind: "subject-skill", mapId, skillId: s.skillId, skillRevision: s.skillRevision }) === "current").map((s) => s.skillId))
		: new Set<string>();
	const statuses = new Map(view.skills.map((item) => [item.skill.id, item.evidence.status]));
	const first = nextPlacementProbe(read.map, statuses, [], { maxProbes: PLACEMENT_MAX_PROBES, likelyKnown });
	if (!first) return { ok: false, status: 409, code: "placement_nothing_to_probe", error: "There are no unresolved skills to probe." };
	const revision = read.map.skills.find((skill) => skill.id === first)!.revision;
	return { ok: true, placement: { mapId, maxProbes: PLACEMENT_MAX_PROBES, probes: [{ skillId: first, revision }] }, target: { kind: "subject-skill", mapId, skillId: first, skillRevision: revision } };
}

function awaitlessGapView(map: SubjectMapV1) {
	return subjectMapGapView(map);
}

function appendSuggestions(candidates: Omit<FamiliaritySuggestion, "id" | "status" | "createdAt" | "decidedAt">[]) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const read = stores.learnerProfileStore.read();
		if (read.state !== "ok" && read.state !== "absent") throw new LearnerProfileUnavailableError(read);
		const merged = mergeFamiliaritySuggestions(read.profile.suggestions ?? [], candidates, new Date().toISOString(), () => crypto.randomUUID());
		if (!merged.added.length) return merged;
		try {
			stores.learnerProfileStore.replace({
				background: read.profile.background, coursework: read.profile.coursework, topics: read.profile.topics,
				excerpts: read.profile.excerpts, associations: read.profile.associations, suggestions: merged.suggestions,
				patterns: read.profile.patterns,
			}, read.profile.revision);
			return merged;
		} catch (error) {
			if (!(error instanceof LearnerProfileConflictError) || attempt === 1) throw error;
		}
	}
	throw new Error("Unable to append suggestions.");
}

function familiarityEngine(): PiEngine {
	const spec = resolveRoleSpec("familiarityInferrer", stores.settingsStore.readSettings());
	if (!spec || (isSubscriptionProvider(spec.provider) && !agentCapabilities().subscriptions) || !connectionBackgroundAllowed(spec.provider)) throw new ModelsNotConfiguredError(["strong"]);
	if (!providerKeyPresent(spec.provider)) throw new ProviderKeyMissingError(spec.provider, ["strong"]);
	return piEngineForSpec(spec, true);
}

export interface FamiliarityInferenceDeps {
	engine?: PiEngine;
	inferrer?: typeof runFamiliarityInferrer;
	signal?: AbortSignal;
	readMap?: (id: string) => ReturnType<typeof stores.subjectMapStore.read>;
}

export async function inferFamiliarity(input: { mapId: string; source: { name: string; text: string } }, deps: FamiliarityInferenceDeps = {}) {
	const read = (deps.readMap ?? stores.subjectMapStore.read)(input.mapId);
	if (read.state === "absent") throw new Error("Map not found.");
	if (read.state !== "ok") throw new Error("Map unavailable.");
	const engine = deps.engine ?? familiarityEngine();
	const result = await (deps.inferrer ?? runFamiliarityInferrer)(JSON.stringify({
		map: { title: read.map.title, skills: read.map.skills.map(({ id, title, objective }) => ({ id, title, objective })) },
		source: input.source,
	}), { engine, signal: deps.signal, switches: stores.settingsStore.readSettings()?.agent?.prompts });
	const skills = new Map(read.map.skills.map((skill) => [skill.id, skill]));
	let discarded = 0;
	const candidates = [];
	for (const item of result.items) {
		const skill = skills.get(item.skillId);
		if (!skill || !quoteInText(item.quote, input.source.text)) { discarded++; continue; }
		candidates.push({
			mapId: input.mapId, skillId: skill.id, skillRevision: skill.revision,
			reason: { kind: "import" as const, sourceName: input.source.name, quote: normalizeQuoteText(item.quote) },
		});
	}
	const merged = appendSuggestions(candidates);
	const profile = stores.learnerProfileStore.read();
	return { added: merged.added.length, merged: merged.merged, discarded, usage: result.usage, profileRevision: profile.state === "ok" || profile.state === "absent" ? profile.profile.revision : 0 };
}

export function suggestFamiliarityFromChat(chatId: string, input: { skillId: string; quote: string }) {
	const record = stores.chatStore.getChat(chatId);
	const mapId = record?.target?.mapId ?? record?.placement?.mapId;
	if (!record || !mapId) return invalidInputResult("suggest_familiarity", ["This session is not attached to a subject map."]);
	const mapRead = stores.subjectMapStore.read(mapId);
	if (mapRead.state !== "ok") return invalidInputResult("suggest_familiarity", ["The subject map is unavailable."]);
	const skill = mapRead.map.skills.find((item) => item.id === input.skillId);
	if (!skill) return invalidInputResult("suggest_familiarity", ["skillId must be a current skill of this session's map"]);
	if (!quoteInText(input.quote, input.quote)) return invalidInputResult("suggest_familiarity", ["quote must appear verbatim in one of the learner's own messages"]);
	const message = [...record.messages].reverse().find((candidate) => candidate.role === "user" && (
		typeof candidate.content === "string"
			? quoteInText(input.quote, candidate.content)
			: candidate.content.some((part) => part.type === "text" && quoteInText(input.quote, part.text))
	));
	if (!message) return invalidInputResult("suggest_familiarity", ["quote must appear verbatim in one of the learner's own messages"]);
	appendSuggestions([{
		mapId, skillId: skill.id, skillRevision: skill.revision,
		reason: { kind: "conversation", chatId, messageId: message.id, quote: normalizeQuoteText(input.quote) },
	}]);
	return { content: [{ type: "text" as const, text: `Suggested '${skill.title}' as likely known; the learner will confirm or reject it. This is not evidence.` }], details: { suggested: true } };
}

export function decideSuggestions(ids: string[], status: "confirmed" | "rejected", expectedRevision: number) {
	const read = stores.learnerProfileStore.read();
	if (read.state !== "ok" && read.state !== "absent") throw new LearnerProfileUnavailableError(read);
	const suggestions = decideFamiliaritySuggestions(read.profile.suggestions ?? [], ids, status, new Date().toISOString());
	return stores.learnerProfileStore.replace({
		background: read.profile.background, coursework: read.profile.coursework, topics: read.profile.topics,
		excerpts: read.profile.excerpts, associations: read.profile.associations, suggestions,
		patterns: read.profile.patterns,
	}, expectedRevision);
}

export function listFamiliaritySuggestions(mapId?: string, options: { placementChatId?: string } = {}) {
	const read = stores.learnerProfileStore.read();
	if (read.state !== "ok" && read.state !== "absent") throw new LearnerProfileUnavailableError(read);
	const maps = new Map<string, SubjectMapV1 | null>();
	const readMap = (id: string) => {
		if (!maps.has(id)) {
			const result = stores.subjectMapStore.read(id);
			maps.set(id, result.state === "ok" ? result.map : null);
		}
		return maps.get(id) ?? null;
	};
	let matching = (read.profile.suggestions ?? []).filter((item) => !mapId || item.mapId === mapId);
	if (options.placementChatId !== undefined) {
		const placement = stores.chatStore.getChat(options.placementChatId)?.placement;
		if (!placement) matching = [];
		else {
			const observationIds = new Set(placement.probes.flatMap((probe) =>
				typeof probe.observationId === "string" ? [probe.observationId] : [],
			));
			matching = matching.filter((item) =>
				item.reason.kind === "placement" &&
				item.mapId === placement.mapId &&
				observationIds.has(item.reason.observationId),
			);
		}
	}
	const suggestions = matching.map((item) => {
		const map = readMap(item.mapId);
		const skill = map?.skills.find((s) => s.id === item.skillId);
		const viaSkillId = item.reason.kind === "placement" ? item.reason.viaSkillId : undefined;
		const viaSkillTitle = viaSkillId ? map?.skills.find((s) => s.id === viaSkillId)?.title ?? viaSkillId : undefined;
		return {
			...item,
			mapTitle: map?.title ?? item.mapId,
			skillTitle: skill?.title ?? item.skillId,
			standing: suggestionStanding(item, map),
			...(viaSkillTitle ? { viaSkillTitle } : {}),
		};
	});
	const mapRead = mapId ? readMap(mapId) : null;
	return {
		profileRevision: read.profile.revision,
		suggestions,
		...(mapRead ? { likelyKnownSkillIds: [...likelyKnownSkills(read.profile.suggestions ?? [], mapRead)] } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function advancePlacement(chatId: string): void {
	const record = stores.chatStore.getChat(chatId);
	if (!record?.placement || record.placement.completedAt) return;
	const run = structuredClone(record.placement);
	const mapRead = stores.subjectMapStore.read(run.mapId);
	if (mapRead.state !== "ok") return;
	const map = mapRead.map;
	const current = run.probes.find((probe) => !probe.result);
	if (!current) return;
	const knownCalls = new Set(run.probes.flatMap((probe) => probe.callIds ?? []));
	const newCalls = record.messages.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) =>
		part.type === "toolCall" && part.arguments && typeof part.arguments === "object" && (part.arguments as { onTarget?: unknown }).onTarget === true && !knownCalls.has(part.id) ? [part.id] : []) : []);
	current.callIds = [...(current.callIds ?? []), ...newCalls];
	const skill = map.skills.find((item) => item.id === current.skillId);
	const stale = !skill || skill.revision !== current.revision;
	if (stale && !(current.callIds?.length)) run.probes = run.probes.filter((probe) => probe !== current);
	else if (stale) current.result = "inconclusive";
	else {
		const observations = deriveChatObservations({ ...record, placement: run }).filter((item) =>
			item.attributedTarget?.mapId === run.mapId &&
			item.attributedTarget.skillId === current.skillId &&
			item.attributedTarget.skillRevision === current.revision,
		);
		const sourceCalls = new Map<string, { arguments: unknown }>();
		const resultMessages = new Map<string, (typeof record.messages)[number]>();
		const evaluatedResponseIds = new Set<string>();
		for (const message of record.messages) {
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall") sourceCalls.set(part.id, part);
				}
			} else if (message.role === "toolResult") {
				resultMessages.set(message.id, message);
				if (message.toolName === "evaluate" && !message.isError && isRecord(message.details) && typeof message.details.responseId === "string") {
					evaluatedResponseIds.add(message.details.responseId);
				}
			}
		}
		const pendingResponses = new Map<string, number>();
		for (const message of record.messages) {
			if (message.role !== "toolResult" || !current.callIds?.includes(message.toolCallId) ||
				!isRecord(message.details) || !isRecord(message.details.autoEvaluation) || evaluatedResponseIds.has(message.id)) continue;
			const source = sourceCalls.get(message.toolCallId);
			const spec = source ? assessmentSpecOf(source.arguments) : undefined;
			if (spec && modelJudgedSpec(spec)) pendingResponses.set(message.id, message.timestamp);
		}
		const groups = new Map<string, { observations: typeof observations; observedAt: string }>();
		for (const observation of observations) {
			const result = resultMessages.get(observation.resultMessageId);
			const responseId = result?.role === "toolResult" && result.toolName === "evaluate" &&
				isRecord(result.details) && typeof result.details.responseId === "string"
				? result.details.responseId
				: observation.resultMessageId;
			const group = groups.get(responseId);
			if (group) {
				group.observations.push(observation);
				if (observation.observedAt < group.observedAt) group.observedAt = observation.observedAt;
			} else {
				groups.set(responseId, { observations: [observation], observedAt: observation.observedAt });
			}
		}
		for (const [responseId, timestamp] of pendingResponses) {
			if (!groups.has(responseId)) groups.set(responseId, { observations: [], observedAt: new Date(timestamp).toISOString() });
		}
		const orderedGroups = [...groups].map(([responseId, group]) => ({ responseId, ...group })).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
		const graded = orderedGroups.find((group) =>
			pendingResponses.has(group.responseId) || group.observations.some((item) => evidencePolarity(item) !== null),
		);
		if (graded && !pendingResponses.has(graded.responseId)) {
			const forResponse = graded.observations;
			current.result = forResponse.some((item) => evidencePolarity(item) === "against") ? "against" : forResponse.some((item) => evidencePolarity(item) === "supports") ? "supports" : "inconclusive";
			const matching = forResponse.find((item) => evidencePolarity(item) === current.result);
			if (matching) current.observationId = matching.id;
			if (current.result === "supports" && current.observationId) {
				const statuses = new Map(awaitlessGapView(map).skills.map((item) => [item.skill.id, item.evidence.status]));
				const suggestions = placementSuggestionTargets(map, statuses, current.skillId).map((skillId) => ({
					mapId: run.mapId, skillId, skillRevision: map.skills.find((item) => item.id === skillId)!.revision,
					reason: { kind: "placement" as const, observationId: current.observationId!, viaSkillId: current.skillId },
				}));
				appendSuggestions(suggestions);
			}
		}
	}
	if (current.result === undefined && !stale) {
		stores.chatStore.saveTargeting(chatId, { placement: run, target: { kind: "subject-skill", mapId: run.mapId, skillId: current.skillId, skillRevision: current.revision } });
		return;
	}
	const profile = stores.learnerProfileStore.read();
	const likelyKnown = profile.state === "ok" || profile.state === "absent" ? new Set((profile.profile.suggestions ?? []).filter((s) => s.status === "confirmed" && s.mapId === run.mapId && subjectSkillTargetStatus(map, { kind: "subject-skill", mapId: run.mapId, skillId: s.skillId, skillRevision: s.skillRevision }) === "current").map((s) => s.skillId)) : new Set<string>();
	const view = awaitlessGapView(map);
	const statuses = new Map(view.skills.map((item) => [item.skill.id, item.evidence.status]));
	const next = nextPlacementProbe(map, statuses, run.probes, { maxProbes: run.maxProbes, likelyKnown });
	if (next) {
		const revision = map.skills.find((item) => item.id === next)!.revision;
		run.probes.push({ skillId: next, revision });
		stores.chatStore.saveTargeting(chatId, { placement: run, target: { kind: "subject-skill", mapId: run.mapId, skillId: next, skillRevision: revision } });
	} else {
		run.completedAt = new Date().toISOString();
		stores.chatStore.saveTargeting(chatId, { placement: run });
	}
}

export function placementNudgeFor(chatId: string): SteerMessage | null {
	const record = stores.chatStore.getChat(chatId);
	const placement = record?.placement;
	if (!record || !placement || placement.completedAt) return null;
	const probeIndex = placement.probes.findIndex((probe) => !probe.result);
	if (probeIndex < 0 || danglingQuestionOf(record.messages) !== null) return null;
	const nudge = newPlacementNudgeMessage(chatId, probeIndex);
	return record.messages.some((message) => message.id === nudge.id) ? null : nudge;
}

export function latestPlacementFor(mapId: string) {
	for (const item of stores.chatStore.listChats().slice(0, 50)) {
		const record = stores.chatStore.getChat(item.id);
		if (record?.placement?.mapId === mapId) return { chatId: record.id, title: record.title, probes: record.placement.probes, completed: !!record.placement.completedAt };
	}
	return null;
}

export function placementContextFor(record: { placement?: PlacementRun }) {
	if (!record.placement) return null;
	const read = stores.subjectMapStore.read(record.placement.mapId);
	return read.state === "ok" ? projectPlacementContext(record.placement, read.map) : null;
}
