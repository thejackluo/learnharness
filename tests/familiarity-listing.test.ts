import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FamiliaritySuggestion } from "../src/core/contracts/learner.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-familiarity-listing-"));
process.env.LH_DATA_DIR = data;
const [{ stores }, familiarity, route] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/familiarity.ts"),
	import("../app/api/learner/familiarity/route.ts"),
]);

test.after(() => fs.rmSync(data, { recursive: true, force: true }));

const map = stores.subjectMapStore.create({
	title: "Synthetic map",
	description: "Placement listing fixture",
	skills: [
		{ id: "first", title: "First", objective: "Explain the first skill", revision: 1 },
		{ id: "second", title: "Second", objective: "Explain the second skill", revision: 1 },
		{ id: "third", title: "Third", objective: "Explain the third skill", revision: 1 },
	],
	edges: [],
	goals: ["first"],
	retired: [],
});

function placementChat(title: string, probes: { skillId: string; observationId: string }[]) {
	return stores.chatStore.createChat(title, undefined, undefined, {
		mapId: map.id,
		maxProbes: 15,
		probes: probes.map(({ skillId, observationId }) => ({
			skillId,
			revision: 1,
			result: "supports" as const,
			observationId,
		})),
		completedAt: "2026-11-03T00:00:00.000Z",
	});
}

function placementSuggestion(id: string, skillId: string, observationId: string): FamiliaritySuggestion {
	return {
		id,
		mapId: map.id,
		skillId,
		skillRevision: 1,
		reason: { kind: "placement", observationId, viaSkillId: "first" },
		status: "pending",
		createdAt: "2026-11-03T00:00:00.000Z",
	};
}

test("placement-chat listing is scoped to that completed run and leaves likely-known ids unchanged", async () => {
	const runA = placementChat("Placement A", [
		{ skillId: "first", observationId: "observation-a1" },
		{ skillId: "second", observationId: "observation-a2" },
	]);
	placementChat("Placement B", [{ skillId: "third", observationId: "observation-b1" }]);
	const suggestions: FamiliaritySuggestion[] = [
		placementSuggestion("run-a-first", "first", "observation-a1"),
		placementSuggestion("run-a-second", "second", "observation-a2"),
		placementSuggestion("run-b-third", "third", "observation-b1"),
		{
			id: "import-third",
			mapId: map.id,
			skillId: "third",
			skillRevision: 1,
			reason: { kind: "import", sourceName: "notes.md", quote: "I know this" },
			status: "confirmed",
			createdAt: "2026-11-03T00:00:00.000Z",
		},
	];
	const profile = stores.learnerProfileStore.read();
	assert.ok(profile.state === "ok" || profile.state === "absent");
	stores.learnerProfileStore.replace({
		background: profile.profile.background,
		coursework: profile.profile.coursework,
		topics: profile.profile.topics,
		excerpts: profile.profile.excerpts,
		associations: profile.profile.associations,
		suggestions,
	}, profile.profile.revision);

	const unscoped = familiarity.listFamiliaritySuggestions(map.id);
	const scoped = familiarity.listFamiliaritySuggestions(map.id, { placementChatId: runA.id });
	assert.deepEqual(scoped.suggestions.map((item) => item.id), ["run-a-first", "run-a-second"]);
	assert.deepEqual(scoped.likelyKnownSkillIds, unscoped.likelyKnownSkillIds);

	const response = await route.GET(new Request(
		`http://localhost/api/learner/familiarity?mapId=${encodeURIComponent(map.id)}&chatId=${encodeURIComponent(runA.id)}`,
	));
	assert.equal(response.status, 200);
	const body = await response.json() as typeof scoped;
	assert.deepEqual(body.suggestions.map((item) => item.id), ["run-a-first", "run-a-second"]);
	assert.deepEqual(body.likelyKnownSkillIds, unscoped.likelyKnownSkillIds);

	const invalid = await route.GET(new Request(
		`http://localhost/api/learner/familiarity?mapId=${encodeURIComponent(map.id)}&chatId=bad%2Fid`,
	));
	assert.equal(invalid.status, 400);

	for (const placementChatId of ["chat_missing_123", stores.chatStore.createChat("No placement").id]) {
		const empty = familiarity.listFamiliaritySuggestions(map.id, { placementChatId });
		assert.deepEqual(empty.suggestions, []);
		assert.deepEqual(empty.likelyKnownSkillIds, unscoped.likelyKnownSkillIds);
	}
});
