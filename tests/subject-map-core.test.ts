import assert from "node:assert/strict";
import test from "node:test";
import type { LearnerObservation } from "../src/core/contracts/learner.ts";
import type { SubjectMapV1 } from "../src/core/contracts/subject-map.ts";
import {
	evidencePolarity,
	findPrerequisiteCycle,
	jsonDepthExceeds,
	parsePortableSubjectMap,
	portableSubjectMap,
	prerequisiteClosure,
	projectSubjectMapGaps,
	reviseSubjectMapDefinition,
	subjectMapDefinitionProblems,
	subjectSkillTargetStatus,
	topologicalSkillOrder,
} from "../src/core/subject-map.ts";

const NOW = "2026-11-02T00:00:00.000Z";

function skill(id: string, objective = `Explain ${id}`) {
	return { id, title: id.toUpperCase(), objective, revision: 1 };
}

function definition(skills: string[], edges: [string, string][], goals: string[] = []) {
	return {
		title: "Systems",
		description: "",
		skills: skills.map((id) => skill(id)),
		edges: edges.map(([prerequisite, dependent]) => ({ prerequisite, dependent })),
		goals,
		retired: [] as { id: string; revision: number; title: string }[],
	};
}

function mapOf(def: ReturnType<typeof definition>, extra: Partial<SubjectMapV1> = {}): SubjectMapV1 {
	const revised = reviseSubjectMapDefinition(null, def, NOW);
	assert.ok(revised.ok);
	return {
		...revised.definition,
		version: 1,
		id: "map_test",
		revision: 1,
		createdAt: NOW,
		updatedAt: NOW,
		links: { propositions: [], topics: [] },
		...extra,
	};
}

function observation(id: string, patch: Partial<LearnerObservation> & Record<string, unknown>): LearnerObservation {
	return {
		id,
		chatId: "chat",
		chatTitle: "Chat",
		chatKind: "teach",
		resultMessageId: "r",
		sourceCallId: "c",
		observedAt: NOW,
		prompt: "p",
		provenance: "deterministic",
		targets: [],
		kind: "choice",
		outcome: "correct",
		tool: "quiz",
		...patch,
	} as LearnerObservation;
}

test("valid branching and disconnected DAGs pass; structural faults are each reported", () => {
	assert.deepEqual(subjectMapDefinitionProblems(definition(["a", "b", "c", "x"], [["a", "c"], ["b", "c"]]), { requireRevisions: false }), []);
	const cases: [ReturnType<typeof definition>, RegExp][] = [
		[definition(["a", "b"], [["a", "b"], ["b", "a"]]), /prerequisite cycle: (a → b → a|b → a → b)/],
		[definition(["a"], [["a", "a"]]), /self-loop/],
		[definition(["a"], [["a", "ghost"]]), /unknown dependent ghost/],
		[definition(["a", "a"], []), /duplicate skill id a/],
		[definition(["a", "b"], [["a", "b"], ["a", "b"]]), /duplicate edge a → b/],
		[definition(["a"], [], ["zzz"]), /goal zzz is not a skill/],
		[definition(["a"], [], ["a", "a"]), /duplicate goal a/],
		[definition(["../etc"], []), /id must be/],
	];
	for (const [input, pattern] of cases) {
		const problems = subjectMapDefinitionProblems(input, { requireRevisions: false });
		assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern}: ${problems.join(" | ")}`);
	}
	assert.deepEqual(findPrerequisiteCycle(["a", "b", "c"], [{ prerequisite: "a", dependent: "b" }, { prerequisite: "b", dependent: "c" }, { prerequisite: "c", dependent: "a" }]), ["a", "b", "c", "a"]);
});

test("limits reject excessive skills, edges and deep nesting", () => {
	const many = definition(Array.from({ length: 501 }, (_, i) => `s${i}`), []);
	assert.ok(subjectMapDefinitionProblems(many, { requireRevisions: false }).some((p) => /at most 500/.test(p)));
	const edges = definition(["a", "b"], Array.from({ length: 2001 }, () => ["a", "b"] as [string, string]));
	assert.ok(subjectMapDefinitionProblems(edges, { requireRevisions: false }).some((p) => /at most 2000/.test(p)));
	let deep: unknown = 1;
	for (let i = 0; i < 20; i++) deep = [deep];
	assert.equal(jsonDepthExceeds(deep, 8), true);
	assert.equal(jsonDepthExceeds({ a: [{ b: 1 }] }, 8), false);
	const deepCurriculum = parsePortableSubjectMap({ format: "learnharness.subject-map", version: 1, title: "t", skills: [], extra: deep }, NOW);
	assert.equal(deepCurriculum.ok, false);
});

test("closure explains the shortest path from each prerequisite to each goal", () => {
	const def = definition(["vars", "loops", "funcs", "recursion", "art"], [["vars", "loops"], ["vars", "funcs"], ["funcs", "recursion"], ["loops", "recursion"]]);
	const closure = prerequisiteClosure(def, ["recursion"]);
	assert.deepEqual([...closure.keys()].sort(), ["funcs", "loops", "recursion", "vars"]);
	assert.equal(closure.has("art"), false);
	assert.deepEqual(closure.get("recursion"), [{ goalId: "recursion", path: ["recursion"] }]);
	assert.equal(closure.get("vars")![0]!.path.length, 3);
	assert.equal(closure.get("vars")![0]!.path[0], "vars");
	assert.equal(closure.get("vars")![0]!.path.at(-1), "recursion");
	const order = topologicalSkillOrder(def);
	assert.ok(order.indexOf("vars") < order.indexOf("loops") && order.indexOf("loops") < order.indexOf("recursion"));
});

test("objective edits bump only that skill's revision; edge/goal edits keep revisions; removals become tombstones", () => {
	const first = reviseSubjectMapDefinition(null, definition(["a", "b"], [["a", "b"]], ["b"]), NOW);
	assert.ok(first.ok);
	assert.deepEqual(first.definition.skills.map((s) => s.revision), [1, 1]);
	const edgeEdit = reviseSubjectMapDefinition(first.definition, { ...definition(["a", "b"], [], ["a"]) }, NOW);
	assert.ok(edgeEdit.ok);
	assert.deepEqual(edgeEdit.definition.skills.map((s) => s.revision), [1, 1]);
	const objectiveEdit = reviseSubjectMapDefinition(edgeEdit.definition, {
		...definition(["a", "b"], [], []),
		skills: [skill("a", "A new objective"), { ...skill("b"), revision: 99 }],
	}, NOW);
	assert.ok(objectiveEdit.ok);
	assert.deepEqual(objectiveEdit.definition.skills.map((s) => s.revision), [2, 1]);
	const removal = reviseSubjectMapDefinition(objectiveEdit.definition, definition(["a"], []), NOW);
	assert.ok(removal.ok);
	assert.deepEqual(removal.definition.retired.map((s) => [s.id, s.revision]), [["b", 1]]);
	const reuse = reviseSubjectMapDefinition(removal.definition, definition(["a", "b"], []), NOW);
	assert.equal(reuse.ok, false);
	assert.ok(!reuse.ok && reuse.issues.some((issue) => /retired skill id b cannot be reused/.test(issue)));
});

test("portable export round-trips and never carries learner links", () => {
	const map = mapOf(definition(["a", "b"], [["a", "b"]], ["b"]), {
		links: { propositions: [{ skillId: "a", nodeId: "n_secret", linkedAt: NOW }], topics: [{ skillId: "b", topicId: "topic-secret", linkedAt: NOW }] },
	});
	const exported = portableSubjectMap(map);
	const text = JSON.stringify(exported);
	assert.doesNotMatch(text, /n_secret|topic-secret|links|map_test|createdAt/);
	const parsed = parsePortableSubjectMap(JSON.parse(text), NOW);
	assert.ok(parsed.ok);
	assert.deepEqual(portableSubjectMap(parsed.definition), exported);
	assert.equal(parsePortableSubjectMap({ ...exported, version: 2 }, NOW).ok, false);
	assert.equal(parsePortableSubjectMap({ ...exported, format: "other" }, NOW).ok, false);
});

test("keystone and alternative routes validate, participate in cycles, round-trip, and do not bump objectives", () => {
	const base = definition(["a", "b", "c"], []);
	const group = { dependent: "b", options: ["a", "c"] };
	assert.ok(subjectMapDefinitionProblems({ ...base, skills: [{ ...skill("a"), keystone: false }, skill("b"), skill("c")] }, { requireRevisions: false }).some((issue) => /skill 1 keystone must be true when present/.test(issue)));
	for (const alternatives of [
		[{ dependent: "missing", options: ["a", "c"] }],
		[{ dependent: "b", options: ["a", "missing"] }],
		[{ dependent: "b", options: ["a"] }],
		[{ dependent: "b", options: Array.from({ length: 9 }, (_, index) => `a${index}`) }],
		[{ dependent: "b", options: ["a", "a"] }],
		[{ dependent: "b", options: ["a", "b"] }],
		[{ dependent: "b", options: ["a", "c"] }, { dependent: "b", options: ["c", "a"] }],
		Array.from({ length: 501 }, () => group),
	]) {
		assert.ok(subjectMapDefinitionProblems({ ...base, alternatives }, { requireRevisions: false }).length > 0);
	}
	const cycle = subjectMapDefinitionProblems({
		...base,
		edges: [{ prerequisite: "a", dependent: "b" }],
		alternatives: [{ dependent: "a", options: ["b", "c"] }],
	}, { requireRevisions: false });
	assert.ok(cycle.some((issue) => /prerequisite cycle/.test(issue)));

	const withPathways = {
		...base,
		skills: [{ ...skill("a"), keystone: true as const }, skill("b"), skill("c")],
		alternatives: [group],
	};
	const first = reviseSubjectMapDefinition(null, withPathways, NOW);
	assert.ok(first.ok);
	const exported = portableSubjectMap(first.definition);
	assert.equal(exported.skills[0]?.keystone, true);
	assert.deepEqual(exported.alternatives, [group]);
	const imported = parsePortableSubjectMap(exported, NOW);
	assert.ok(imported.ok);
	assert.deepEqual(portableSubjectMap(imported.definition), exported);

	const edited = reviseSubjectMapDefinition(first.definition, {
		...withPathways,
		skills: [{ ...skill("a"), keystone: undefined }, skill("b"), skill("c")],
		alternatives: [{ dependent: "b", options: ["c", "a"] }],
	}, NOW);
	assert.ok(edited.ok);
	assert.deepEqual(edited.definition.skills.map((item) => item.revision), [1, 1, 1]);
	assert.equal(Object.hasOwn(edited.definition.skills[0]!, "keystone"), false);
	assert.equal(Object.hasOwn(edited.definition, "alternatives"), true);
	const withoutFields = parsePortableSubjectMap({ format: "learnharness.subject-map", version: 1, ...base }, NOW);
	assert.ok(withoutFields.ok);
	assert.equal(Object.hasOwn(withoutFields.definition, "alternatives"), false);
	assert.equal(Object.hasOwn(portableSubjectMap(withoutFields.definition), "alternatives"), false);
});

test("evidence polarity keeps deterministic, model-judged, practice and legacy work distinct", () => {
	assert.equal(evidencePolarity(observation("1", {})), "supports");
	assert.equal(evidencePolarity(observation("2", { outcome: "dontKnow" })), "against");
	assert.equal(evidencePolarity(observation("3", { provenance: "legacyClientGraded" })), "inconclusive");
	assert.equal(evidencePolarity(observation("4", { kind: "criterion", outcome: "unassessed", provenance: "modelJudged" } as never)), "inconclusive");
	assert.equal(evidencePolarity(observation("5", { kind: "criterion", outcome: "partial", provenance: "modelJudged" } as never)), "against");
	assert.equal(evidencePolarity(observation("6", { kind: "practiceConclusion", outcome: "solvedWithHints", provenance: "modelAuthored" } as never)), "against");
	assert.equal(evidencePolarity(observation("7", { kind: "practiceConclusion", outcome: "movedOn", provenance: "modelAuthored" } as never)), "inconclusive");
});

test("gap view distinguishes not checked, supporting, needs practice, mixed, inconclusive, unavailable and historical evidence", () => {
	const map = mapOf(definition(["none", "good", "bad", "mixed", "legacy", "gone", "goal"], [
		["none", "goal"], ["good", "goal"], ["bad", "goal"], ["mixed", "goal"], ["legacy", "goal"], ["gone", "goal"],
	], ["goal"]));
	const target = (skillId: string, skillRevision = 1) => ({ kind: "subject-skill" as const, mapId: map.id, skillId, skillRevision });
	const item = (evidenceId: string, skillId: string, obs: LearnerObservation | null, skillRevision = 1) => ({ evidenceId, target: target(skillId, skillRevision), attachedAt: NOW, observation: obs });
	const view = projectSubjectMapGaps({
		map,
		associations: {
			availability: "available",
			items: [
				item("e1", "good", observation("e1", {})),
				item("e2", "bad", observation("e2", { outcome: "incorrect" })),
				item("e3", "mixed", observation("e3", {})),
				item("e4", "mixed", observation("e4", { outcome: "incorrect" })),
				item("e5", "legacy", observation("e5", { provenance: "legacyClientGraded" })),
				item("e6", "gone", null),
				item("e7", "none", observation("e7", {}), 0),
				item("e8", "good", observation("e8", {}), 1),
				{ evidenceId: "other", target: { ...target("good"), mapId: "map_other" }, attachedAt: NOW, observation: observation("other", { outcome: "incorrect" }) },
			],
		},
		topics: { availability: "available", claims: [] },
		propositions: { availability: "available", names: new Map() },
	});
	const status = Object.fromEntries(view.skills.map((s) => [s.skill.id, s.evidence.status]));
	assert.deepEqual(status, {
		none: "notChecked",
		good: "supporting",
		bad: "needsPractice",
		mixed: "mixed",
		legacy: "inconclusive",
		gone: "unavailable",
		goal: "notChecked",
	});
	const none = view.skills.find((s) => s.skill.id === "none")!;
	assert.equal(none.evidence.reviewNeeded, true);
	assert.equal(none.evidence.historical.length, 1);
	assert.deepEqual(view.gaps.map((g) => g.skillId).sort(), ["bad", "goal", "gone", "legacy", "mixed", "none"]);
	assert.deepEqual(view.gaps.find((g) => g.skillId === "bad")!.paths, [{ goalId: "goal", path: ["bad", "goal"] }]);
	assert.equal(view.evidenceAvailability, "partial");

	const unreadable = projectSubjectMapGaps({
		map,
		associations: { availability: "unavailable" },
		topics: { availability: "unavailable" },
		propositions: { availability: "unavailable" },
	});
	assert.ok(unreadable.skills.every((s) => s.evidence.status === "unavailable"));
	assert.equal(unreadable.evidenceAvailability, "unavailable");

	const historicalOnly = projectSubjectMapGaps({
		map,
		associations: { availability: "available", items: [item("e9", "good", null, 0)] },
		topics: { availability: "available", claims: [] },
		propositions: { availability: "available", names: new Map() },
	});
	assert.equal(historicalOnly.evidenceAvailability, "partial", "a deleted historical source still marks availability partial");
});

test("encounter and self-report axes report linked, missing and unavailable sources separately", () => {
	const map = mapOf(definition(["a", "b"], []), {
		links: {
			propositions: [{ skillId: "a", nodeId: "n_1", linkedAt: NOW }, { skillId: "b", nodeId: "n_deleted", linkedAt: NOW }],
			topics: [{ skillId: "a", topicId: "t1", linkedAt: NOW }, { skillId: "b", topicId: "t_deleted", linkedAt: NOW }],
		},
	});
	const view = projectSubjectMapGaps({
		map,
		associations: { availability: "available", items: [] },
		topics: { availability: "available", claims: [{ id: "t1", topic: "Pointers", familiarity: "seen", updatedAt: NOW }] },
		propositions: { availability: "available", names: new Map([["n_1", "Pointer"]]) },
	});
	const [a, b] = ["a", "b"].map((id) => view.skills.find((s) => s.skill.id === id)!);
	assert.equal(a!.encounter.status, "linked");
	assert.equal(a!.selfReport.status, "reported");
	assert.equal(a!.selfReport.claims[0]!.claim!.familiarity, "seen");
	assert.equal(b!.encounter.status, "unavailable");
	assert.equal(b!.selfReport.status, "unavailable");
	assert.equal(a!.evidence.status, "notChecked", "encounter/self-report never count as evidence");
});

test("target status resolves current, historical, retired, missing skill and deleted map", () => {
	const map = mapOf(definition(["a"], []), { retired: [{ id: "old", revision: 1, title: "Old", retiredAt: NOW }] });
	const target = (skillId: string, skillRevision = 1, mapId = map.id) => ({ kind: "subject-skill" as const, mapId, skillId, skillRevision });
	assert.equal(subjectSkillTargetStatus(map, target("a")), "current");
	assert.equal(subjectSkillTargetStatus(map, target("a", 2)), "historical");
	assert.equal(subjectSkillTargetStatus(map, target("old")), "retired");
	assert.equal(subjectSkillTargetStatus(map, target("zzz")), "missingSkill");
	assert.equal(subjectSkillTargetStatus(null, target("a")), "missingMap");
});
