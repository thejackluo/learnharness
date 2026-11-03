import assert from "node:assert/strict";
import test from "node:test";
import type { FamiliaritySuggestion, SkillEvidenceStatus, SubjectMapV1 } from "../src/core";
import {
	decideFamiliaritySuggestions,
	mergeFamiliaritySuggestions,
	nextPlacementProbe,
	normalizeQuoteText,
	placementSuggestionTargets,
	quoteInText,
} from "../src/core";
import { routeToGoal, skillPathStates } from "../src/core/pathways.ts";

const map = {
	id: "map_test",
	title: "Basics",
	description: "",
	revision: 1,
	updatedAt: "2026-01-01T00:00:00.000Z",
	skills: ["a", "b", "c", "d"].map((id) => ({ id: `skill_${id}`, title: id, objective: id, revision: 1 })),
	edges: [{ prerequisite: "skill_a", dependent: "skill_c" }, { prerequisite: "skill_b", dependent: "skill_c" }],
	alternatives: [{ dependent: "skill_d", options: ["skill_a", "skill_b"] }],
	goals: ["skill_c", "skill_d"],
} as unknown as SubjectMapV1;

test("placement selection is deterministic, respects max probes, and stops when resolved", () => {
	const statuses = new Map<string, SkillEvidenceStatus>();
	assert.equal(nextPlacementProbe(map, statuses, [], { maxProbes: 1 }), "skill_a");
	assert.equal(nextPlacementProbe(map, statuses, [{ skillId: "skill_a", revision: 1 }], { maxProbes: 1 }), null);
	assert.equal(nextPlacementProbe(map, new Map(map.skills.map((skill) => [skill.id, "supporting"])), []), null);
});

test("placement closure suggestions include required and alternative prerequisites, without evidence", () => {
	const targets = placementSuggestionTargets(map, new Map(), "skill_c");
	assert.deepEqual(targets, ["skill_a", "skill_b"]);
	assert.deepEqual(placementSuggestionTargets(map, new Map(), "skill_d"), ["skill_a", "skill_b"]);
});

test("likely-known affects readiness but is never cleared", () => {
	const states = skillPathStates(map, new Map(), new Set(["skill_a"]));
	assert.equal(states.get("skill_a"), "open");
	assert.equal(states.get("skill_c"), "reachable");
	assert.equal(states.get("skill_a"), "open");
	assert.ok(routeToGoal(map, new Map(), "skill_c", new Set(["skill_a"])));
});

test("quote normalization and verification use whitespace-normalized verbatim text", () => {
	assert.equal(normalizeQuoteText("  I\tknow\n this  "), "I know this");
	assert.equal(quoteInText("know this", "I know\nthis already"), true);
	assert.equal(quoteInText("not here", "I know this"), false);
});

test("pending suggestions merge by map, skill, and reason kind; decisions can be revoked", () => {
	const candidate = {
		mapId: "map_test", skillId: "skill_a", skillRevision: 1,
		reason: { kind: "import" as const, sourceName: "notes.md", quote: "I know this" },
	};
	const first = mergeFamiliaritySuggestions([], [candidate], "2026-01-01T00:00:00.000Z", () => "s1");
	const duplicate = mergeFamiliaritySuggestions(first.suggestions, [candidate], "2026-01-02T00:00:00.000Z", () => "s2");
	assert.equal(first.added.length, 1);
	assert.equal(duplicate.merged, 1);
	const confirmed = decideFamiliaritySuggestions(first.suggestions, ["s1"], "confirmed", "2026-01-03T00:00:00.000Z");
	assert.equal(confirmed[0]?.status, "confirmed");
	const revoked = decideFamiliaritySuggestions(confirmed, ["s1"], "rejected", "2026-01-04T00:00:00.000Z");
	assert.equal(revoked[0]?.status, "rejected");
	assert.throws(() => decideFamiliaritySuggestions(revoked, ["missing"], "confirmed", "2026-01-04T00:00:00.000Z"), /Unknown familiarity suggestion id/);
});

test("suggestion cap is 2000", () => {
	const existing = Array.from({ length: 2000 }, (_, index) => ({
		id: `s${index}`, mapId: "map_test", skillId: `skill_${index}`, skillRevision: 1,
		status: "confirmed" as const, createdAt: "2026-01-01T00:00:00.000Z",
		reason: { kind: "import" as const, sourceName: "notes", quote: "quote" },
	})) satisfies FamiliaritySuggestion[];
	const result = mergeFamiliaritySuggestions(existing, [{
		mapId: "map_test", skillId: "skill_extra", skillRevision: 1,
		reason: { kind: "import", sourceName: "notes", quote: "extra" },
	}], "2026-01-02T00:00:00.000Z", () => "new");
	assert.equal(result.dropped, 1);
	assert.equal(result.suggestions.length, 2000);
});
