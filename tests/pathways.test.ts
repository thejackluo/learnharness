import assert from "node:assert/strict";
import test from "node:test";
import {
	SUBJECT_MAP_LIMITS,
	WORLD_BAND_GAP,
	WORLD_BAND_PAD,
	WORLD_COL_W,
	WORLD_LABEL_H,
	WORLD_NODE,
	WORLD_PAD,
	WORLD_ROW_H,
	isSatisfied,
	routeToGoal,
	skillPathStates,
	worldLayout,
	type SkillEvidenceStatus,
	type SubjectMapDefinition,
	type SubjectSkill,
} from "../src/core/index.ts";

const skill = (id: string, regionId?: string, keystone = false): SubjectSkill => ({
	id,
	title: id.toUpperCase(),
	objective: `Explain ${id}`,
	revision: 1,
	...(regionId ? { regionId } : {}),
	...(keystone ? { keystone: true } : {}),
});

function map(
	skills: SubjectSkill[],
	edges: [string, string][] = [],
	alternatives: { dependent: string; options: string[] }[] = [],
	regions: SubjectMapDefinition["regions"] = [],
	goals: string[] = [],
): SubjectMapDefinition {
	return {
		title: "Test map",
		description: "",
		skills,
		edges: edges.map(([prerequisite, dependent]) => ({ prerequisite, dependent })),
		...(alternatives.length ? { alternatives } : {}),
		...(regions === undefined ? {} : { regions }),
		goals,
		retired: [],
	};
}

function statusMap(values: Record<string, SkillEvidenceStatus> = {}): Map<string, SkillEvidenceStatus> {
	return new Map(Object.entries(values));
}

test("path states distinguish supporting, open, reachable, locked, alternatives and practice evidence", () => {
	const subject = map(
		["root", "middle", "deep", "choice", "practice"].map((id) => skill(id)),
		[["root", "middle"], ["middle", "deep"]],
		[{ dependent: "choice", options: ["root", "middle"] }],
	);
	assert.equal(isSatisfied("supporting"), true);
	assert.equal(isSatisfied("needsPractice"), false);
	assert.equal(isSatisfied(undefined), false);
	assert.deepEqual([...skillPathStates(subject, statusMap({ practice: "needsPractice" }))], [
		["root", "open"],
		["practice", "open"],
		["middle", "reachable"],
		["deep", "locked"],
		["choice", "reachable"],
	]);
	assert.equal(skillPathStates(subject, statusMap({ root: "supporting" })).get("choice"), "open");
	assert.equal(skillPathStates(subject, statusMap({ root: "supporting", practice: "mixed" })).get("practice"), "open");
	assert.equal(skillPathStates(subject, statusMap({ middle: "needsPractice" })).get("middle"), "reachable");
});

test("routes choose the smallest unsatisfied alternative closure, break ties by id, and prune cleared skills", () => {
	const subject = map(
		["goal", "a", "b", "c"].map((id) => skill(id)),
		[["c", "b"]],
		[{ dependent: "goal", options: ["a", "b"] }],
		[],
		["goal"],
	);
	const chosen = routeToGoal(subject, statusMap(), "goal");
	assert.deepEqual(chosen?.route, ["a", "goal"]);
	const tieMap = map(["goal", "z", "a"].map((id) => skill(id)), [], [{ dependent: "goal", options: ["z", "a"] }]);
	assert.deepEqual(routeToGoal(tieMap, statusMap(), "goal")?.route, ["a", "goal"]);
	const required = map(["goal", "a"].map((id) => skill(id)), [["a", "goal"]]);
	const pruned = routeToGoal(required, statusMap({ a: "supporting" }), "goal");
	assert.deepEqual(pruned?.route, ["goal"]);
	assert.deepEqual(routeToGoal(subject, statusMap({ goal: "supporting" }), "goal")?.route, []);
	assert.equal(routeToGoal(subject, statusMap(), "missing"), null);
});

test("routes use lexical topological readiness and list eligible keystone checks by beneath count", () => {
	const subject = map(
		[
			skill("goal"),
			skill("root", undefined, true),
			skill("middle", undefined, true),
			skill("deep", undefined, true),
			skill("b", undefined, true),
			skill("a", undefined, true),
		],
		[["root", "middle"], ["middle", "deep"], ["deep", "goal"], ["a", "goal"], ["b", "goal"]],
		[],
		[],
		["goal"],
	);
	const route = routeToGoal(subject, statusMap(), "goal");
	assert.deepEqual(route?.route, ["a", "b", "root", "middle", "deep", "goal"]);
	assert.deepEqual(route?.skipAhead, [
		{ skillId: "middle", beneath: 1 },
		{ skillId: "a", beneath: 0 },
		{ skillId: "b", beneath: 0 },
		{ skillId: "root", beneath: 0 },
	]);
});

test("world layout is deterministic, includes alternative depth, bands, and contained non-overlapping nodes", () => {
	const subject = map(
		[
			skill("a", "first"),
			skill("b", "first"),
			skill("c", "second"),
			skill("d", "second"),
			skill("e", "second"),
			skill("free"),
		],
		[["a", "b"], ["b", "e"]],
		[{ dependent: "d", options: ["a", "b"] }],
		[
			{ id: "empty", title: "Empty", description: "" },
			{ id: "second", title: "Second", description: "" },
			{ id: "first", title: "First", description: "" },
		],
	);
	const layout = worldLayout(subject);
	assert.deepEqual(worldLayout(subject), layout);
	assert.deepEqual(layout.regions.map((region) => region.id), ["second", "first", null]);
	assert.deepEqual(layout.regions.map((region) => region.title), ["Second", "First", "Ungrouped"]);
	const byId = new Map(layout.nodes.map((node) => [node.skillId, node]));
	assert.equal(byId.get("b")?.depth, 1);
	assert.equal(byId.get("d")?.depth, 2);
	assert.equal(byId.get("d")?.x, WORLD_PAD + 2 * WORLD_COL_W);
	assert.equal(byId.get("c")?.y, layout.regions[0]!.y + WORLD_LABEL_H);
	assert.equal(byId.get("d")?.y, layout.regions[0]!.y + WORLD_LABEL_H);
	assert.equal(byId.get("e")?.y, layout.regions[0]!.y + WORLD_LABEL_H + WORLD_ROW_H);
	for (const region of layout.regions) {
		for (const node of layout.nodes.filter((item) => item.regionId === region.id)) {
			assert.ok(node.x >= region.x);
			assert.ok(node.y >= region.y);
			assert.ok(node.x + WORLD_NODE.width <= region.x + region.width);
			assert.ok(node.y + WORLD_NODE.height <= region.y + region.height);
		}
	}
	for (let i = 0; i < layout.nodes.length; i++) {
		for (let j = i + 1; j < layout.nodes.length; j++) {
			const left = layout.nodes[i]!;
			const right = layout.nodes[j]!;
			const overlaps = left.x < right.x + WORLD_NODE.width && left.x + WORLD_NODE.width > right.x
				&& left.y < right.y + WORLD_NODE.height && left.y + WORLD_NODE.height > right.y;
			assert.equal(overlaps, false, `${left.skillId} overlaps ${right.skillId}`);
		}
	}
	assert.ok(layout.width >= Math.max(...layout.nodes.map((node) => node.x + WORLD_NODE.width)) + WORLD_PAD);
	assert.ok(layout.height >= Math.max(...layout.regions.map((region) => region.y + region.height)) + WORLD_PAD);
	assert.equal(WORLD_BAND_PAD > 0 && WORLD_BAND_GAP > 0, true);
	assert.ok(SUBJECT_MAP_LIMITS.alternativeOptionsMax >= 2);
});
