import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-target-session-"));
process.env.LH_DATA_DIR = DATA_DIR;
process.env.OPENROUTER_API_KEY ??= "test-target-key-presence-gate";

const [{ stores }, chatsRoute, targetRoute, { handleChatRequest }, { createTeacherAgent, composeInstructions }, turnRuns, targets, maps, tools, attribution, segments, familiarity] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../app/api/chats/route.ts"),
	import("../app/api/chats/[id]/target/route.ts"),
	import("../src/server/chat-handler.ts"),
	import("../src/agent/teacher-agent.ts"),
	import("../src/server/turn-runs.ts"),
	import("../src/server/target-adaptation.ts"),
	import("../src/server/subject-maps.ts"),
	import("../src/agent/tools.ts"),
	import("../src/agent/tools/target-attribution.ts"),
	import("../src/agent/prompt-segments.ts"),
	import("../src/server/familiarity.ts"),
]);
const { ADAPTIVE_DOCTRINE_SEGMENTS } = await import("../src/core/prompt-segments.ts");

test.after(() => {
	fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const map = stores.subjectMapStore.create({
	title: "Operating systems",
	description: "Synthetic fixture",
	skills: [
		{ id: "processes", title: "Processes", objective: "Explain what a process is", revision: 1 },
		{ id: "threads", title: "Threads", objective: "Contrast threads and processes", revision: 1 },
		{ id: "scheduling", title: "Scheduling", objective: "Trace a round-robin schedule", revision: 1 },
		{ id: "unrelated", title: "Unrelated", objective: "Stand alone", revision: 1 },
	],
	edges: [
		{ prerequisite: "processes", dependent: "threads" },
		{ prerequisite: "threads", dependent: "scheduling" },
	],
	goals: ["scheduling"],
	retired: [],
});

async function createSession(body: Record<string, unknown>): Promise<Response> {
	return chatsRoute.POST(new Request("http://localhost/api/chats", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

const threads = { mapId: map.id, skillId: "threads", skillRevision: 1 };
let stamp = Date.parse("2026-03-01T00:00:00.000Z");
const assistant = (id: string, name: string, args: Record<string, unknown>) => ({ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: stamp });
const result = (id: string, name: string, details: unknown) => ({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [], details, isError: false, timestamp: (stamp += 60_000) });
const quiz = (id: string, correct: boolean, onTarget = true) => [
	assistant(id, "quiz", { question: "Q", onTarget }),
	result(id, "quiz", { kind: "quiz", questionText: `Question ${id}`, correct, dontKnow: false, gradingProvenance: "deterministic", answeredAt: new Date(stamp + 60_000).toISOString() }),
];
const hintedPractice = (id: string) => [
	assistant(`${id}_p`, "problem", { statement: "Contrast them", onTarget: true }),
	result(`${id}_p`, "problem", null),
	assistant(`${id}_c`, "conclude", { outcome: "solvedWithHints", verdict: "needed R2", rung: "R2", missClass: null }),
	result(`${id}_c`, "conclude", { problemCallId: `${id}_p` }),
];

async function sessionWith(body: Record<string, unknown>, messages: unknown[]): Promise<string> {
	const response = await createSession(body);
	assert.equal(response.status, 200);
	const { id } = await response.json() as { id: string };
	if (messages.length) stores.chatStore.saveMessages(id, messages as never);
	return id;
}

test("session creation validates the target at the revision the learner saw", async () => {
	const before = stores.chatStore.listChatIds().length;
	const stale = await createSession({ title: "Stale", target: { ...threads, skillRevision: 9 } });
	assert.equal(stale.status, 409);
	assert.equal((await stale.json() as { code: string }).code, "skill_revision_conflict");
	const missing = await createSession({ title: "Missing", target: { ...threads, mapId: "map_00000000-0000-4000-8000-00000000dead" } });
	assert.equal(missing.status, 404);
	const malformed = await createSession({ title: "Bad", target: { mapId: map.id, skillId: "threads" } });
	assert.equal(malformed.status, 400);
	const gone = await createSession({ title: "Gone", target: { ...threads, skillId: "nope" } });
	assert.equal(gone.status, 409);
	assert.equal(stores.chatStore.listChatIds().length, before, "rejected targets create no session");
	const id = await sessionWith({ title: "Valid", target: threads }, []);
	assert.deepEqual(stores.chatStore.getChat(id)?.target, { kind: "subject-skill", ...threads });
	const plain = await sessionWith({ title: "Plain" }, []);
	assert.equal(stores.chatStore.getChat(plain)?.target, undefined);
	const view = await targetRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id: plain }) });
	assert.equal(view.headers.get("Cache-Control"), "private, no-store");
	assert.deepEqual(await view.json(), { view: null, placement: null });
	const practicePlacement = await createSession({ title: "Practice placement", kind: "practice", placement: { mapId: map.id } });
	assert.equal(practicePlacement.status, 400);
	assert.equal((await practicePlacement.json() as { code: string }).code, "invalid_placement");
	const validPlacement = await createSession({ title: "Placement", placement: { mapId: map.id } });
	assert.equal(validPlacement.status, 200);
	const placementChat = await validPlacement.json() as { id: string; placement: { mapId: string } };
	assert.equal(stores.chatStore.getChat(placementChat.id)?.placement?.mapId, map.id);
	const activePlacementResponse = await targetRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id: placementChat.id }) });
	assert.deepEqual((await activePlacementResponse.json() as { placement: unknown }).placement, { mapId: map.id, completed: false });
	const run = stores.chatStore.getChat(placementChat.id)!.placement!;
	stores.chatStore.saveTargeting(placementChat.id, { placement: { ...run, completedAt: new Date().toISOString() } });
	const completedPlacementResponse = await targetRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id: placementChat.id }) });
	assert.deepEqual(await completedPlacementResponse.json(), {
		view: null,
		placement: { mapId: map.id, completed: true },
	});
	const targetAndPlacement = await createSession({ title: "Both", target: threads, placement: { mapId: map.id } });
	assert.equal(targetAndPlacement.status, 400);
	assert.equal((await targetAndPlacement.json() as { code: string }).code, "invalid_placement");
	const malformedPlacement = await createSession({ title: "Bad map id", placement: { mapId: "bad" } });
	assert.equal(malformedPlacement.status, 400);
	const missingPlacementMap = await createSession({ title: "Missing map", placement: { mapId: "map_00000000-0000-4000-8000-00000000dead" } });
	assert.equal(missingPlacementMap.status, 404);
	const fullyKnownMap = stores.subjectMapStore.create({
		title: "Known map", description: "Synthetic",
		skills: [{ id: "known", title: "Known", objective: "Known skill", revision: 1 }],
		edges: [], goals: ["known"], retired: [],
	});
	const profileRead = stores.learnerProfileStore.read();
	assert.ok(profileRead.state === "ok" || profileRead.state === "absent");
	const profile = profileRead.profile;
	stores.learnerProfileStore.replace({
		background: profile.background,
		coursework: profile.coursework,
		topics: profile.topics,
		excerpts: profile.excerpts,
		associations: profile.associations,
		suggestions: [...(profile.suggestions ?? []), {
			id: "confirmed-known",
			mapId: fullyKnownMap.id,
			skillId: "known",
			skillRevision: 1,
			reason: { kind: "import", sourceName: "synthetic.txt", quote: "Known skill" },
			status: "confirmed",
			createdAt: new Date().toISOString(),
			decidedAt: new Date().toISOString(),
		}],
	}, profile.revision);
	const nothingToProbe = await createSession({ title: "Nothing", placement: { mapId: fullyKnownMap.id } });
	assert.equal(nothingToProbe.status, 409);
	assert.equal((await nothingToProbe.json() as { code: string }).code, "placement_nothing_to_probe");
});

test("conversation familiarity accepts the latest plain-string learner quote and rejects tutor text", async () => {
	const chat = await sessionWith({ title: "Conversation quote", target: threads }, []);
	const profileBefore = stores.learnerProfileStore.read();
	assert.ok(profileBefore.state === "ok" || profileBefore.state === "absent");
	const preservedPattern = {
		id: "familiarity-writer-pattern",
		subject: "Operating systems",
		pattern: "confuses processes and threads",
		status: "active" as const,
		occurrences: [{
			chatId: chat,
			messageId: "learner-earlier",
			quote: "I remember how threads work.",
			at: new Date(stamp).toISOString(),
		}],
		createdAt: new Date(stamp).toISOString(),
		updatedAt: new Date(stamp).toISOString(),
	};
	const seededProfile = stores.learnerProfileStore.replace({
		background: profileBefore.profile.background,
		coursework: profileBefore.profile.coursework,
		topics: profileBefore.profile.topics,
		excerpts: profileBefore.profile.excerpts,
		associations: profileBefore.profile.associations,
		suggestions: profileBefore.profile.suggestions,
		patterns: [...(profileBefore.profile.patterns ?? []), preservedPattern],
	}, profileBefore.profile.revision);
	stores.chatStore.saveMessages(chat, [
		{ id: "learner-earlier", role: "user", content: "I remember how threads work." },
		{ id: "tutor", role: "assistant", content: "You said you remember how threads work." },
		{ id: "learner-latest", role: "user", content: "I remember\n how threads work." },
	] as never);
	const result = await familiarity.suggestFamiliarityFromChat(chat, { skillId: "threads", quote: "I remember how threads work." });
	assert.equal((result.details as { suggested?: boolean }).suggested, true);
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") {
		assert.deepEqual(profile.profile.patterns, seededProfile.patterns, "suggestion writes preserve weakness patterns");
		const suggestion = profile.profile.suggestions?.at(-1);
		assert.equal(suggestion?.reason.kind, "conversation");
		if (suggestion?.reason.kind === "conversation") assert.equal(suggestion.reason.messageId, "learner-latest");
		if (suggestion) {
			const decided = familiarity.decideSuggestions([suggestion.id], "confirmed", profile.profile.revision);
			assert.deepEqual(decided.patterns, seededProfile.patterns, "suggestion decisions preserve weakness patterns");
		}
	}
	stores.chatStore.saveMessages(chat, [{ id: "tutor-only", role: "assistant", content: "The tutor mentioned this phrase." }] as never);
	const rejected = await familiarity.suggestFamiliarityFromChat(chat, { skillId: "threads", quote: "mentioned this phrase" });
	assert.equal("isError" in rejected && rejected.isError === true, true);
	stores.chatStore.saveMessages(chat, [{ id: "invalid-skill", role: "user", content: [{ type: "text", text: "I remember algebra." }] }] as never);
	const invalidSkill = await familiarity.suggestFamiliarityFromChat(chat, { skillId: "not-in-map", quote: "algebra" });
	assert.equal((invalidSkill.details as { problems: string[] }).problems[0], "skillId must be a current skill of this session's map");
	const badQuote = await familiarity.suggestFamiliarityFromChat(chat, { skillId: "threads", quote: "not verbatim" });
	assert.equal((badQuote.details as { problems: string[] }).problems[0], "quote must appear verbatim in one of the learner's own messages");
});

test("familiarity and pattern tools are gated to teacher/prober callbacks and absent from practice", async () => {
	const chatId = await sessionWith({ title: "Tool registry" }, []);
	const callback = () => ({ content: [{ type: "text" as const, text: "accepted" }], details: {} });
	const ctx = {
		chatId,
		chatStore: stores.chatStore,
		jobStore: {} as never,
		spawn: () => {},
		deliver: () => {},
		suggestFamiliarity: callback,
		notePattern: callback,
	};
	assert.ok(tools.createTeacherTools(ctx).suggest_familiarity);
	assert.ok(tools.createProberTools(ctx).suggest_familiarity);
	assert.ok(tools.createTeacherTools(ctx).note_pattern);
	assert.ok(tools.createProberTools(ctx).note_pattern);
	assert.equal(tools.createTeacherTools({ ...ctx, suggestFamiliarity: undefined }).suggest_familiarity, undefined);
	assert.equal(tools.createProberTools({ ...ctx, suggestFamiliarity: undefined }).suggest_familiarity, undefined);
	assert.equal(tools.createTeacherTools({ ...ctx, notePattern: undefined }).note_pattern, undefined);
	assert.equal(tools.createProberTools({ ...ctx, notePattern: undefined }).note_pattern, undefined);
	const { capabilitiesOverride } = await import("../src/agent/capabilities.ts");
	const { capabilitiesFor } = await import("../src/core/runtime.ts");
	const previousCapabilities = capabilitiesOverride.current;
	try {
		capabilitiesOverride.current = capabilitiesFor("hosted");
		assert.ok(tools.createTeacherTools(ctx).note_pattern, "hosted tools keep note_pattern without host filesystem capability");
		assert.ok(tools.createProberTools(ctx).note_pattern, "hosted tools keep note_pattern without host filesystem capability");
	} finally {
		capabilitiesOverride.current = previousCapabilities;
	}
	const { practiceTools } = await import("../src/agent/tools/practice.ts");
	assert.equal(practiceTools({ chatId, chatStore: stores.chatStore }).suggest_familiarity, undefined);
	assert.equal(practiceTools({ chatId, chatStore: stores.chatStore }).note_pattern, undefined);
	const invalid = await tools.createTeacherTools(ctx).suggest_familiarity!.execute("invalid", { skillId: "threads", quote: "" });
	assert.equal(invalid.isError, true);
	assert.deepEqual((invalid.details as { tool: string; problems: string[] }), {
		tool: "suggest_familiarity",
		problems: ["skillId and a quote of at most 500 characters are required."],
	});
});

test("two sessions for one target: hinted versus unaided success change the advice, isolated from other targets", async () => {
	const current = await sessionWith({ title: "Current target session", target: threads }, []);
	const viewOf = () => targets.targetAdaptationFor(stores.chatStore.getChat(current)!)!;
	assert.equal(viewOf().advice?.reason, "noEvidence");

	const hinted = await sessionWith({ title: "Hinted practice", kind: "practice", target: threads }, hintedPractice("h1"));
	await sessionWith({ title: "Other skill", target: { ...threads, skillId: "unrelated" } }, quiz("u1", false));
	await sessionWith({ title: "No target", kind: undefined }, quiz("n1", true));
	await sessionWith({ title: "Unmarked check", target: threads }, quiz("m1", true, false));

	const repair = viewOf();
	assert.equal(repair.advice?.move, "repair");
	assert.equal(repair.advice?.reason, "aidedOnly");
	assert.deepEqual(repair.sample.map((item) => [item.chatTitle, item.result, item.via]), [["Hinted practice", "practice solved with hints", ["tutor"]]]);
	assert.deepEqual(repair.unverifiedPrerequisites.map((item) => item.skillId), ["processes"]);

	// Reload: the advice is derived again from disk, not cached.
	const response = await targetRoute.GET(new Request("http://localhost"), { params: Promise.resolve({ id: current }) });
	const body = await response.json() as { view: { advice: { move: string } } };
	assert.equal(body.view.advice.move, "repair");

	// Deleting the hinted source drops its evidence; unaided success advances.
	assert.equal(stores.chatStore.deleteChat(hinted), true);
	await sessionWith({ title: "Unaided check", target: threads }, quiz("s1", true));
	const advance = viewOf();
	assert.equal(advance.advice?.move, "advance");
	assert.equal(advance.advice?.qualified, false);
	assert.deepEqual(advance.sample.map((item) => item.chatTitle), ["Unaided check"]);
	assert.deepEqual(advance.nextSteps.map((step) => step.skillId), ["scheduling"]);

	// A miss on the same target alongside it is conflicting evidence: probe.
	await sessionWith({ title: "Missed check", target: threads }, quiz("x1", false));
	assert.equal(viewOf().advice?.reason, "conflicting");

	// Editing the objective makes the session's target historical: no advice, no attribution.
	const latest = stores.subjectMapStore.read(map.id);
	assert.equal(latest.state, "ok");
	const live = latest.state === "ok" ? latest.map : map;
	maps.updateSubjectMap(map.id, {
		title: live.title,
		description: live.description,
		skills: live.skills.map((skill) => skill.id === "threads" ? { ...skill, objective: "Contrast user and kernel threads" } : skill),
		edges: live.edges,
		goals: live.goals,
	}, live.revision);
	const record = stores.chatStore.getChat(current)!;
	assert.equal(targets.sessionTargetState(record), "unavailable");
	assert.equal(viewOf().advice, null);
	assert.match(targets.targetContextFor(record) ?? "", /Do not set onTarget/);
});

test("onTarget claims are rejected unless the session target is current", async () => {
	const input = { question: "Q?", options: [{ label: "a", value: "a" }, { label: "b", value: "b" }], explanation: "e", correctAnswer: "a", onTarget: true };
	for (const state of ["none", "unavailable"] as const) {
		const rejected = await attribution.withTargetAttribution(tools.probeQuizTool, state).execute("call", input as never);
		assert.equal((rejected as { isError?: boolean }).isError, true);
		assert.match(JSON.stringify(rejected.content), /onTarget/);
	}
	const accepted = await attribution.withTargetAttribution(tools.probeQuizTool, "current").execute("call", input as never);
	assert.notEqual((accepted as { isError?: boolean }).isError, true);
	const unmarked = await attribution.withTargetAttribution(tools.probeQuizTool, "none").execute("call", { ...input, onTarget: undefined } as never);
	assert.notEqual((unmarked as { isError?: boolean }).isError, true);
});

test("a clarification turn gets the target block and a direct answer without a compulsory quiz", async () => {
	const next = stores.subjectMapStore.read(map.id);
	const live = next.state === "ok" ? next.map : map;
	const skill = live.skills.find((candidate) => candidate.id === "scheduling")!;
	const scheduling = { mapId: map.id, skillId: "scheduling", skillRevision: skill.revision };
	const current = await sessionWith({ title: "Clarify", target: scheduling }, []);
	stores.chatStore.saveSettings(current, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	let context = "";
	const faux = createFauxCore({});
	faux.setResponses([
		(ctx) => {
			context = JSON.stringify(ctx.messages);
			return fauxAssistantMessage([fauxText("A time slice is the fixed interval each process runs before the scheduler switches.")]);
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const ack = await handleChatRequest(new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId: current, input: { type: "text", text: "Quick question: what is a time slice?" } }),
	}), (options) => createTeacherAgent(undefined, { ...options, engine }));
	assert.equal(ack.status, 200);
	await new Response(turnRuns.runningTurn(current)!.subscribe()).text();
	assert.match(context, /Session target/);
	assert.match(context, /Advisory next move: Probe/);
	const persisted = stores.chatStore.getChat(current)!.messages;
	assert.ok(!JSON.stringify(persisted).includes("Session target"), "the target block is never persisted");
	const last = persisted.at(-1) as { role: string; content: { type: string }[] };
	assert.equal(last.role, "assistant");
	assert.ok(last.content.every((block) => block.type !== "toolCall"), "the clarification ends without a question");
});

test("doctrine: no quiz-every-step; overrides of the adaptive segments are flagged", () => {
	const teacher = composeInstructions("teacher", {});
	assert.doesNotMatch(teacher, /Check that the step landed — every step/);
	assert.doesNotMatch(teacher, /One question per turn, every turn/);
	assert.match(teacher, /do not attach an automatic quiz/);
	assert.match(teacher, /Session target and evidence/);
	assert.match(teacher, /A quiz answer MAY carry `confidence`/);
	assert.match(composeInstructions("practice", {}), /Session target and evidence/);
	const known = new Set(segments.allSegmentPaths());
	for (const segment of ADAPTIVE_DOCTRINE_SEGMENTS) assert.ok(known.has(segment), segment);
});
