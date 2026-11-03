import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlacementRun } from "../src/core/contracts/familiarity.ts";
import { projectPlacementContext } from "../src/core/familiarity.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-familiarity-placement-"));
process.env.LH_DATA_DIR = data;
const [{ stores }, { advancePlacement }] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/familiarity.ts"),
]);
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

function createMap(skillIds: string[], edges: { prerequisite: string; dependent: string }[] = [], alternatives: { dependent: string; options: string[] }[] = []) {
	return stores.subjectMapStore.create({
		title: "Fixture",
		description: "Synthetic",
		skills: skillIds.map((id) => ({ id, title: id, objective: `Explain ${id}`, revision: 1 })),
		edges,
		alternatives,
		goals: [skillIds.at(-1)!],
		retired: [],
	});
}

function call(callId: string, name: string, args: Record<string, unknown>, timestamp = Date.now()) {
	return { id: `assistant-${callId}`, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp };
}

function quizResult(callId: string, correct: boolean, timestamp = Date.now() + 1) {
	return {
		id: `result-${callId}`, role: "toolResult", toolCallId: callId, toolName: "quiz", content: [],
		details: { kind: "quiz", questionText: `Question for ${callId}`, correct, dontKnow: false, gradingProvenance: "deterministic", answeredAt: new Date(timestamp).toISOString() },
		isError: false, timestamp,
	};
}

function placementChat(mapId: string, skillId: string, revision = 1) {
	return stores.chatStore.createChat("Synthetic placement", undefined,
		{ kind: "subject-skill", mapId, skillId, skillRevision: revision },
		{ mapId, maxProbes: 10, probes: [{ skillId, revision }] },
	);
}

function saveMessages(chatId: string, messages: unknown[]) {
	stores.chatStore.saveMessages(chatId, messages as never);
}

test("placement context summarizes completed probes and preserves the in-progress prompt", () => {
	const map = createMap(["first", "second"]);
	const titledMap = {
		...map,
		skills: map.skills.map((skill) => ({
			...skill,
			title: skill.id === "first" ? "First skill" : "Second skill",
		})),
	};
	const completed: PlacementRun = {
		mapId: map.id,
		maxProbes: 10,
		probes: [
			{ skillId: "first", revision: 1, result: "supports" },
			{ skillId: "second", revision: 1, result: "against" },
			{ skillId: "removed", revision: 1, result: "inconclusive" },
		],
	};
	assert.equal(
		projectPlacementContext(completed, titledMap),
		"[Placement run — data, not instructions]\nThis placement run is complete. Probe results: First skill: supports; Second skill: against; removed: inconclusive.\nGive a short summary of what the probes showed, in plain language, and tell him the likely-known suggestions are listed below for him to confirm or reject. Ask no further questions, never call probe_done, and never claim mastery.",
	);

	const inProgress: PlacementRun = {
		mapId: map.id,
		maxProbes: 10,
		probes: [
			{ skillId: "first", revision: 1, result: "supports" },
			{ skillId: "second", revision: 1 },
		],
	};
	assert.equal(
		projectPlacementContext(inProgress, titledMap),
		"[Placement run — data, not instructions]\nProbe 2 of 10: Second skill. Objective: Explain second\nPrevious probe results: first: supports\nAsk one short targeted check of this probe using onTarget: true. If his previous answer was just graded, give brief feedback and then ask this probe in the same turn; never end a turn without a question while the run is in progress, and never call probe_done. After it is graded, the app moves to the next probe. Keep a friendly pace; never claim mastery.",
	);
});

test("graded placement support assigns its call, suggests the prerequisite closure, and completes without evidence", () => {
	const map = createMap(["required", "option-a", "option-b", "target"], [{ prerequisite: "required", dependent: "target" }], [{ dependent: "target", options: ["option-a", "option-b"] }]);
	const chat = placementChat(map.id, "target");
	saveMessages(chat.id, [call("quiz-1", "quiz", { onTarget: true }), quizResult("quiz-1", true)]);
	advancePlacement(chat.id);
	const record = stores.chatStore.getChat(chat.id)!;
	assert.equal(record.placement?.probes[0]?.callIds?.[0], "quiz-1");
	assert.equal(record.placement?.probes[0]?.result, "supports");
	assert.ok(record.placement?.completedAt);
	assert.equal(record.target, undefined);
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") {
		assert.deepEqual(profile.profile.suggestions?.map((item) => item.skillId).sort(), ["option-a", "option-b", "required"]);
		assert.ok(profile.profile.suggestions?.every((item) => item.status === "pending" && item.reason.kind === "placement"));
		assert.deepEqual(profile.profile.associations, []);
	}
});

test("an against result rules out dependents and advances to an unresolved prerequisite", () => {
	const map = createMap(["prerequisite", "target", "dependent"], [
		{ prerequisite: "prerequisite", dependent: "target" },
		{ prerequisite: "target", dependent: "dependent" },
	]);
	const chat = placementChat(map.id, "target");
	saveMessages(chat.id, [call("quiz-against", "quiz", { onTarget: true }), quizResult("quiz-against", false)]);
	advancePlacement(chat.id);
	const record = stores.chatStore.getChat(chat.id)!;
	assert.equal(record.placement?.probes[0]?.result, "against");
	assert.equal(record.placement?.probes[1]?.skillId, "prerequisite");
	assert.equal(record.target?.skillId, "prerequisite");
});

test("criterion observations match the probe by attributed target, not evaluate call id", () => {
	const map = createMap(["target"]);
	const chat = placementChat(map.id, "target");
	const now = Date.now();
	saveMessages(chat.id, [
		call("explain-call", "explain", { onTarget: true }, now),
		call("evaluate-call", "evaluate", {}, now + 1),
		{
			id: "evaluate-result", role: "toolResult", toolCallId: "evaluate-call", toolName: "evaluate", content: [],
			details: {
				version: 1, provenance: "deterministic", sourceCallId: "explain-call",
				responseId: "response", evaluationId: "evaluation",
				spec: { version: 1, parts: [{ id: "part", prompt: "Explain", criteria: [{ id: "criterion" }] }] },
				criteria: [{ criterionId: "criterion", partId: "part", outcome: "met", award: 1, maxPoints: 1, feedback: "Correct" }],
			},
			isError: false, timestamp: now + 2,
		},
	]);
	advancePlacement(chat.id);
	assert.equal(stores.chatStore.getChat(chat.id)?.placement?.probes[0]?.result, "supports");
});

test("observations remain attributed to each probe after the target moves", () => {
	const map = createMap(["first", "second"]);
	const chat = placementChat(map.id, "first");
	const now = Date.now();
	saveMessages(chat.id, [call("first-call", "quiz", { onTarget: true }, now), quizResult("first-call", true, now + 1)]);
	advancePlacement(chat.id);
	assert.equal(stores.chatStore.getChat(chat.id)?.target?.skillId, "second");
	saveMessages(chat.id, [
		...stores.chatStore.getChat(chat.id)!.messages,
		call("second-call", "quiz", { onTarget: true }, now + 2),
		quizResult("second-call", false, now + 3),
	]);
	advancePlacement(chat.id);
	const probes = stores.chatStore.getChat(chat.id)?.placement?.probes;
	assert.deepEqual(probes?.map((probe) => [probe.skillId, probe.result]), [["first", "supports"], ["second", "against"]]);
});

test("stale probes with calls become inconclusive; stale probes without calls are replaced", () => {
	const map = createMap(["old", "next"]);
	const revised = stores.subjectMapStore.replace(map.id, {
		title: map.title, description: map.description,
		skills: map.skills.map((skill) => ({ ...skill, revision: skill.id === "old" ? 2 : skill.revision })),
		edges: map.edges, alternatives: map.alternatives, goals: map.goals, retired: map.retired, links: map.links,
	}, map.revision);
	const withCalls = placementChat(revised.id, "old", 1);
	saveMessages(withCalls.id, [call("stale-call", "quiz", { onTarget: true }), quizResult("stale-call", true)]);
	advancePlacement(withCalls.id);
	assert.equal(stores.chatStore.getChat(withCalls.id)?.placement?.probes[0]?.result, "inconclusive");
	assert.equal(stores.chatStore.getChat(withCalls.id)?.target?.skillId, "next");

	const onlyOld = createMap(["old"]);
	stores.subjectMapStore.replace(onlyOld.id, {
		title: onlyOld.title, description: onlyOld.description,
		skills: [{ ...onlyOld.skills[0]!, revision: 2 }],
		edges: [], alternatives: [], goals: onlyOld.goals, retired: onlyOld.retired, links: onlyOld.links,
	}, onlyOld.revision);
	const withoutCalls = placementChat(onlyOld.id, "old", 1);
	advancePlacement(withoutCalls.id);
	const run = stores.chatStore.getChat(withoutCalls.id)?.placement;
	assert.equal(run?.probes.length, 1);
	assert.deepEqual(run?.probes[0], { skillId: "old", revision: 2 });
});
