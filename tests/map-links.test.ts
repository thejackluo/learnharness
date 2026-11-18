import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deriveChatObservations } from "../src/core/learner.ts";
import { projectSavedMapsContext } from "../src/core/map-links.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-map-links-"));
process.env.LH_DATA_DIR = DATA_DIR;
process.env.LH_RUNTIME = "local";
process.env.LH_IGNORE_ENV_KEYS = "1";

const [{ stores }, mapLinks, targetRoute, tools, mapTools, { practiceTools }, mapsApi] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/map-links.ts"),
	import("../app/api/chats/[id]/target/route.ts"),
	import("../src/agent/tools.ts"),
	import("../src/agent/tools/map-links.ts"),
	import("../src/agent/tools/practice.ts"),
	import("../src/server/subject-maps.ts"),
]);

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function mapFixture(id: string, title: string, updatedAt: string, skills = [{ id: "skill", title: "Skill", objective: "Explain the skill", revision: 1 }]) {
	return {
		version: 1 as const,
		id,
		revision: 1,
		createdAt: updatedAt,
		updatedAt,
		title,
		description: "",
		skills,
		edges: [],
		goals: [],
		retired: [],
		links: { propositions: [], topics: [] },
	};
}

function suggestionResult(callId: string, toolName: "suggest_map_link" | "suggest_map_draft", details: unknown) {
	return [
		{
			id: `assistant_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: {} }],
			timestamp: 1000,
		},
		{
			id: `result_${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "offered" }],
			details,
			isError: false,
			timestamp: 1100,
		},
	] as never[];
}

function linkDetails(mapId: string, mapTitle: string, skillId: string, skillTitle: string, skillRevision = 1) {
	return { mapId, mapTitle, skillId, skillTitle, skillRevision, reason: "The learner is studying this skill." };
}

async function postTarget(chatId: string, callId: string, decision: "accept" | "dismiss") {
	return targetRoute.POST(new Request(`http://localhost/api/chats/${chatId}/target`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ callId, decision }),
	}), { params: Promise.resolve({ id: chatId }) });
}

test("saved map projection bounds maps and skills, shows current and suggestion decisions, and omits ineligible contexts", () => {
	const maps = Array.from({ length: 21 }, (_, index) => mapFixture(
		`map_${index}`,
		`Map ${index}`,
		new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
		Array.from({ length: 81 }, (_, skillIndex) => ({
			id: `skill_${skillIndex}`,
			title: `Skill ${skillIndex}`,
			objective: "Objective",
			revision: 1,
		})),
	));
	const mapId = maps[20]!.id;
	const record = {
		kind: "teach" as const,
		target: { kind: "subject-skill" as const, mapId, skillId: "skill_0", skillRevision: 1 },
		messages: [
			...suggestionResult("declined-call", "suggest_map_link", linkDetails(mapId, "Map 20", "declined", "Declined skill")),
			...suggestionResult("pending-call", "suggest_map_link", linkDetails(mapId, "Map 20", "pending", "Pending skill")),
		],
		mapSuggestionDecisions: [{ callId: "declined-call", decision: "dismissed" as const, at: "2026-02-01T00:00:00.000Z" }],
	};
	const context = projectSavedMapsContext(record, maps)!;
	const mapLines = context.split("\n").filter((line) => line.startsWith("- "));
	assert.equal(mapLines.length, 20);
	assert.match(context, /Current link: Map 20 → Skill 0/);
	assert.match(context, /Skill 79 \[skillId: skill_79\]; \(\+1 more\)/);
	assert.doesNotMatch(context, /skill_80 \]/);
	assert.match(context, /Declined in this chat: "Map 20" → "Declined skill"/);
	assert.match(context, /Offered, awaiting the learner: "Map 20" → "Pending skill"/);
	assert.doesNotMatch(context, /Map 0/);
	assert.equal(projectSavedMapsContext({ ...record, kind: "practice" }, maps), null);
	assert.equal(projectSavedMapsContext({ ...record, placement: { mapId: "map_20" } as never }, maps), null);
	assert.equal(projectSavedMapsContext({ ...record, target: undefined }, []), null);
	assert.match(projectSavedMapsContext({ ...record, target: undefined }, maps)!, /Current link: none/);

	const safeTitles = projectSavedMapsContext({ kind: "teach", messages: [] }, [
		mapFixture("map_titles", `Systems\n${"x".repeat(90)}`, "2026-03-01T00:00:00.000Z", [
			{ id: "skill_titles", title: `Process\t${"y".repeat(90)}`, objective: "Explain", revision: 1 },
		]),
	])!;
	const titleLine = safeTitles.split("\n")[2]!;
	assert.equal(titleLine.includes("\n"), false);
	assert.ok(titleLine.includes(`"Systems ${"x".repeat(71)}…"`));
	assert.ok(titleLine.includes(`Process ${"y".repeat(71)}… [skillId: skill_titles]`));
});

test("map suggestion capabilities are gated by saved maps, practice, and placement for both registries", () => {
	const emptyChat = stores.chatStore.createChat("No saved maps");
	const emptyFeatures = mapLinks.mapSuggestionFeaturesForChat(emptyChat, emptyChat.id);
	assert.equal(emptyFeatures.savedMapsContext, null);
	assert.equal("suggestMapLink" in emptyFeatures, false);
	assert.equal(typeof emptyFeatures.suggestMapDraft, "function");

	const map = stores.subjectMapStore.create({
		title: "Synthetic systems",
		description: "",
		skills: [
			{ id: "processes", title: "Processes", objective: "Explain processes", revision: 1 },
			{ id: "threads", title: "Threads", objective: "Compare threads", revision: 1 },
		],
		edges: [],
		goals: [],
		retired: [],
	});
	const ordinary = stores.chatStore.createChat("Ordinary");
	const ordinaryFeatures = mapLinks.mapSuggestionFeaturesForChat(ordinary, ordinary.id);
	assert.match(ordinaryFeatures.savedMapsContext!, /Saved subject maps/);
	assert.equal(typeof ordinaryFeatures.suggestMapLink, "function");
	assert.equal(typeof ordinaryFeatures.suggestMapDraft, "function");

	const common = {
		chatId: ordinary.id,
		chatStore: stores.chatStore,
		jobStore: {} as never,
		spawn: () => {},
		deliver: () => {},
	};
	const base = { ...common, ...ordinaryFeatures };
	for (const registry of [tools.createTeacherTools(base), tools.createProberTools(base)]) {
		assert.ok(registry.suggest_map_link);
		assert.ok(registry.suggest_map_draft);
		assert.equal(registry.suggest_map_link!.executionMode, "sequential");
		assert.equal(registry.suggest_map_draft!.executionMode, "sequential");
	}
	const withDisabledSettings = tools.createTeacherTools(base, { suggest_map_link: false, suggest_map_draft: false } as never);
	assert.ok(withDisabledSettings.suggest_map_link, "map-link tools are not toggleable");
	assert.ok(withDisabledSettings.suggest_map_draft, "map-draft tools are not toggleable");

	const practice = stores.chatStore.createChat("Practice", "practice");
	const practiceFeatures = mapLinks.mapSuggestionFeaturesForChat(practice, practice.id);
	assert.equal(practiceFeatures.savedMapsContext, null);
	assert.equal("suggestMapLink" in practiceFeatures, false);
	assert.equal("suggestMapDraft" in practiceFeatures, false);
	assert.equal(practiceTools({ chatId: practice.id, chatStore: stores.chatStore }).suggest_map_link, undefined);
	assert.equal(practiceTools({ chatId: practice.id, chatStore: stores.chatStore }).suggest_map_draft, undefined);

	const placement = stores.chatStore.createChat("Placement", undefined, undefined, { mapId: map.id } as never);
	const placementFeatures = mapLinks.mapSuggestionFeaturesForChat(placement, placement.id);
	assert.equal(placementFeatures.savedMapsContext, null);
	assert.equal("suggestMapLink" in placementFeatures, false);
	assert.equal("suggestMapDraft" in placementFeatures, false);
	const noMapTeacher = tools.createTeacherTools({ ...common, chatId: emptyChat.id, ...emptyFeatures });
	const noMapProber = tools.createProberTools({ ...common, chatId: emptyChat.id, ...emptyFeatures });
	assert.equal(noMapTeacher.suggest_map_link, undefined);
	assert.equal(noMapProber.suggest_map_link, undefined);
	assert.ok(noMapTeacher.suggest_map_draft);
	assert.ok(noMapProber.suggest_map_draft);

	const placementTeacher = tools.createTeacherTools({ ...common, chatId: placement.id, ...placementFeatures });
	const placementProber = tools.createProberTools({ ...common, chatId: placement.id, ...placementFeatures });
	assert.equal(placementTeacher.suggest_map_link, undefined);
	assert.equal(placementTeacher.suggest_map_draft, undefined);
	assert.equal(placementProber.suggest_map_link, undefined);
	assert.equal(placementProber.suggest_map_draft, undefined);
});

test("suggestion tools validate input and server callbacks reject invalid or repeated suggestions", async () => {
	const map = stores.subjectMapStore.list().find((entry) => entry.state === "ok")!;
	const chat = stores.chatStore.createChat("Tool validation");
	const good = linkDetails(map.id, map.title, "threads", "Threads");
	const unknownMap = await mapLinks.suggestMapLinkFromChat(chat.id, { mapId: "map_00000000-0000-4000-8000-00000000dead", skillId: "threads", reason: "Reason" });
	assert.equal(unknownMap.isError, true);
	const unknownSkill = await mapLinks.suggestMapLinkFromChat(chat.id, { mapId: map.id, skillId: "missing", reason: "Reason" });
	assert.equal(unknownSkill.isError, true);

	const alreadyLinked = stores.chatStore.createChat("Already linked", undefined, { kind: "subject-skill", mapId: map.id, skillId: "threads", skillRevision: 1 });
	assert.equal(mapLinks.suggestMapLinkFromChat(alreadyLinked.id, { mapId: map.id, skillId: "threads", reason: "Reason" }).isError, true);

	const declined = stores.chatStore.createChat("Declined");
	stores.chatStore.saveMessages(declined.id, suggestionResult("declined", "suggest_map_link", good));
	stores.chatStore.recordMapSuggestionDecision(declined.id, "declined", "dismissed", "2026-01-02T00:00:00.000Z");
	assert.equal(mapLinks.suggestMapLinkFromChat(declined.id, { mapId: map.id, skillId: "threads", reason: "Reason" }).isError, true);

	const pending = stores.chatStore.createChat("Pending");
	stores.chatStore.saveMessages(pending.id, suggestionResult("pending", "suggest_map_link", good));
	assert.equal(mapLinks.suggestMapLinkFromChat(pending.id, { mapId: map.id, skillId: "threads", reason: "Reason" }).isError, true);

	const success = mapLinks.suggestMapLinkFromChat(chat.id, { mapId: map.id, skillId: "threads", reason: "  Compare the two models.  " });
	assert.equal(success.isError, undefined);
	assert.deepEqual(success.details, { ...good, reason: "Compare the two models." });
	assert.equal((success.content[0] as { text: string }).text, `Offered the learner a chip to link this chat to '${map.title}' → 'Threads'. Nothing is linked unless he accepts; until then don't treat it as the session target or set onTarget. Continue your reply normally.`);

	const duplicateDraft = stores.chatStore.createChat("Draft duplicate");
	stores.chatStore.saveMessages(duplicateDraft.id, suggestionResult("draft1", "suggest_map_draft", { subject: "Japanese", goal: "Learn kana" }));
	assert.equal(mapLinks.suggestMapDraftFromChat(duplicateDraft.id, { subject: " japanese ", goal: "Learn grammar" }).isError, true);
	const draft = mapLinks.suggestMapDraftFromChat(chat.id, { subject: "  Algebra ", goal: "  Understand functions ", framework: "  High school " });
	assert.deepEqual(draft.details, { subject: "Algebra", goal: "Understand functions", framework: "High school" });
	assert.equal((draft.content[0] as { text: string }).text, "Offered a chip that opens the map drafter prefilled with this goal; he reviews any draft before it is saved. Continue your reply normally.");

	const linkTool = mapTools.suggestMapLinkTool(() => success);
	const invalidLink = await linkTool.execute("id", { mapId: "x", skillId: "y", reason: " " });
	assert.equal(invalidLink.isError, true);
	const draftTool = mapTools.suggestMapDraftTool(() => draft);
	const invalidDraft = await draftTool.execute("id", { subject: " ", goal: "Goal" });
	assert.equal(invalidDraft.isError, true);
});

test("link and decision store writes reread records and seed creation targets", () => {
	const map = stores.subjectMapStore.list().find((entry) => entry.state === "ok")!;
	const initialTarget = { kind: "subject-skill" as const, mapId: map.id, skillId: "processes", skillRevision: 1 };
	const linkedTarget = { kind: "subject-skill" as const, mapId: map.id, skillId: "threads", skillRevision: 1 };
	const chat = stores.chatStore.createChat("Seed history", undefined, initialTarget);
	stores.chatStore.linkTarget(chat.id, linkedTarget, "accepted-call", "2026-02-01T00:00:00.000Z");
	stores.chatStore.saveMessages(chat.id, []);
	stores.chatStore.appendTurnUsage(chat.id, { id: "turn-1" } as never);
	stores.chatStore.recordMapSuggestionDecision(chat.id, "accepted-call", "accepted", "2026-02-01T00:00:00.000Z");
	const saved = stores.chatStore.getChat(chat.id)!;
	assert.deepEqual(saved.target, linkedTarget);
	assert.deepEqual(saved.targetLinks, [
		{ target: initialTarget, linkedAt: chat.createdAt },
		{ target: linkedTarget, linkedAt: "2026-02-01T00:00:00.000Z", suggestionCallId: "accepted-call" },
	]);
	assert.deepEqual(saved.mapSuggestionDecisions, [{ callId: "accepted-call", decision: "accepted", at: "2026-02-01T00:00:00.000Z" }]);
});

test("target API accepts with the current revision, dismisses, and rejects stale decisions or retired skills", async () => {
	const map = stores.subjectMapStore.list().find((entry) => entry.state === "ok")!;
	const readMap = stores.subjectMapStore.read(map.id);
	assert.equal(readMap.state, "ok");
	if (readMap.state !== "ok") return;
	const startTarget = { kind: "subject-skill" as const, mapId: map.id, skillId: "processes", skillRevision: 1 };
	const accepting = stores.chatStore.createChat("Accept", undefined, startTarget);
	stores.chatStore.saveMessages(accepting.id, suggestionResult("accept-call", "suggest_map_link", linkDetails(map.id, "Synthetic systems", "threads", "Threads")));
	const current = mapsApi.updateSubjectMap(map.id, {
		title: readMap.map.title,
		description: readMap.map.description,
		skills: readMap.map.skills.map((skill) => skill.id === "threads" ? { ...skill, objective: "Explain concurrency" } : skill),
		edges: readMap.map.edges,
		goals: readMap.map.goals,
		retired: readMap.map.retired,
	}, readMap.map.revision);
	const accepted = await postTarget(accepting.id, "accept-call", "accept");
	assert.equal(accepted.status, 200);
	const acceptedBody = await accepted.json() as { mapSuggestions: Record<string, string> };
	assert.equal(acceptedBody.mapSuggestions["accept-call"], "accepted");
	const getAccepted = await targetRoute.GET(new Request(`http://localhost/api/chats/${accepting.id}/target`), {
		params: Promise.resolve({ id: accepting.id }),
	});
	assert.deepEqual(await getAccepted.json(), acceptedBody);
	const saved = stores.chatStore.getChat(accepting.id)!;
	assert.deepEqual(saved.target, { kind: "subject-skill", mapId: current.id, skillId: "threads", skillRevision: 2 });
	assert.deepEqual(saved.targetLinks?.map((link) => link.target), [startTarget, saved.target]);
	assert.equal(saved.targetLinks?.[1]?.suggestionCallId, "accept-call");
	assert.equal((await postTarget(accepting.id, "accept-call", "accept")).status, 409);

	const relinking = stores.chatStore.createChat("Accept A, B, then A again");
	const suggestAndAccept = async (callId: string, skillId: string) => {
		const result = mapLinks.suggestMapLinkFromChat(relinking.id, {
			mapId: map.id,
			skillId,
			reason: "The learner has moved to this skill.",
		});
		assert.equal(result.isError, undefined);
		const record = stores.chatStore.getChat(relinking.id)!;
		stores.chatStore.saveMessages(relinking.id, [
			...record.messages,
			...suggestionResult(callId, "suggest_map_link", result.details),
		]);
		const response = await postTarget(relinking.id, callId, "accept");
		assert.equal(response.status, 200);
	};
	await suggestAndAccept("A-first", "processes");
	assert.equal(stores.chatStore.getChat(relinking.id)?.target?.skillId, "processes");
	await suggestAndAccept("B", "threads");
	assert.equal(stores.chatStore.getChat(relinking.id)?.target?.skillId, "threads");
	await suggestAndAccept("A-again", "processes");
	const switchedBack = stores.chatStore.getChat(relinking.id)!;
	assert.equal(switchedBack.target?.skillId, "processes");
	assert.deepEqual(switchedBack.targetLinks?.map((link) => link.target.skillId), ["processes", "threads", "processes"]);
	assert.deepEqual(switchedBack.mapSuggestionDecisions?.map(({ callId, decision }) => [callId, decision]), [
		["A-first", "accepted"],
		["B", "accepted"],
		["A-again", "accepted"],
	]);

	const draftChat = stores.chatStore.createChat("Draft decision");
	stores.chatStore.saveMessages(draftChat.id, suggestionResult("draft-call", "suggest_map_draft", { subject: "Linear algebra", goal: "Learn matrices" }));
	assert.equal((await postTarget(draftChat.id, "missing-call", "dismiss")).status, 404);
	assert.equal((await postTarget(draftChat.id, "draft-call", "accept")).status, 400);
	const dismissed = await postTarget(draftChat.id, "draft-call", "dismiss");
	assert.equal(dismissed.status, 200);
	assert.equal(((await dismissed.json()) as { mapSuggestions: Record<string, string> }).mapSuggestions["draft-call"], "dismissed");
	assert.equal(stores.chatStore.getChat(draftChat.id)?.target, undefined);

	const placement = stores.chatStore.createChat("Placement", undefined, undefined, { mapId: current.id } as never);
	stores.chatStore.saveMessages(placement.id, suggestionResult("placement-call", "suggest_map_link", linkDetails(current.id, current.title, "threads", "Threads", 2)));
	assert.equal((await postTarget(placement.id, "placement-call", "dismiss")).status, 409);

	const retiringMap = stores.subjectMapStore.create({
		title: "Retirement fixture",
		description: "",
		skills: [{ id: "retire-me", title: "Retired soon", objective: "Current", revision: 1 }],
		edges: [],
		goals: [],
		retired: [],
	});
	const retiredChat = stores.chatStore.createChat("Retired skill");
	stores.chatStore.saveMessages(retiredChat.id, suggestionResult("retired-call", "suggest_map_link", linkDetails(retiringMap.id, retiringMap.title, "retire-me", "Retired soon")));
	stores.subjectMapStore.replace(retiringMap.id, {
		title: retiringMap.title,
		description: retiringMap.description,
		skills: [],
		edges: [],
		goals: [],
		retired: [{ id: "retire-me", revision: 1, title: "Retired soon", retiredAt: "2026-02-01T00:00:00.000Z" }],
		links: retiringMap.links,
	}, retiringMap.revision);
	const retired = await postTarget(retiredChat.id, "retired-call", "accept");
	assert.equal(retired.status, 409);
	assert.match((await retired.json() as { error: string }).error, /retired/);
});

function answerMessages(callId: string, callAt: number, resultAt: number) {
	return [
		{
			id: `call-${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Q", onTarget: true } }],
			timestamp: callAt,
		},
		{
			id: `result-${callId}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "quiz",
			content: [],
			isError: false,
			details: { kind: "quiz", questionText: `Question ${callId}`, correct: true, dontKnow: false, gradingProvenance: "deterministic" },
			timestamp: resultAt,
		},
	] as never[];
}

test("onTarget attribution uses the link current when the question was posed and preserves legacy records", () => {
	const first = { kind: "subject-skill" as const, mapId: "map-a", skillId: "first", skillRevision: 1 };
	const second = { kind: "subject-skill" as const, mapId: "map-a", skillId: "second", skillRevision: 1 };
	const time = (value: number) => new Date(value).toISOString();
	const messages = [
		...answerMessages("before-first-link", 1000, 6000),
		...answerMessages("after-first-link", 3000, 7000),
		...answerMessages("after-switch-to-B", 4200, 8000),
		...answerMessages("before-switch-back-to-A", 4300, 8500),
		...answerMessages("after-switch-back-to-A", 5000, 9000),
	];
	const record = {
		id: "attribution",
		title: "Attribution",
		createdAt: time(0),
		updatedAt: time(9000),
		messages,
		target: first,
		targetLinks: [
			{ target: first, linkedAt: time(2000) },
			{ target: second, linkedAt: time(4000) },
			{ target: first, linkedAt: time(4500) },
		],
	} as unknown as ChatRecord;
	const observations = deriveChatObservations(record);
	const targetFor = (callId: string) => observations.find((item) => item.sourceCallId === callId)?.attributedTarget;
	assert.equal(targetFor("before-first-link"), undefined);
	assert.deepEqual(targetFor("after-first-link"), first);
	assert.deepEqual(targetFor("after-switch-to-B"), second);
	assert.deepEqual(targetFor("before-switch-back-to-A"), second);
	assert.deepEqual(targetFor("after-switch-back-to-A"), first);

	const legacy = { ...record, targetLinks: undefined, target: second } as unknown as ChatRecord;
	assert.deepEqual(deriveChatObservations(legacy).find((item) => item.sourceCallId === "before-first-link")?.attributedTarget, second);
});
