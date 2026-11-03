import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePortableSubjectMap, portableSubjectMap, reviseSubjectMapDefinition, subjectMapDefinitionProblems } from "../src/core/subject-map.ts";
import type { SubjectMapDefinition } from "../src/core/contracts/subject-map.ts";
import { diffSubjectMaps, groupSubjectMapSkills } from "../src/core/map-draft-review.ts";

const original: SubjectMapDefinition = { title: "Physics", description: "", skills: [{ id: "force", title: "Force", objective: "Can compute force", revision: 3 }], edges: [], goals: [], retired: [] };

test("regions and all source kinds round-trip; metadata does not revise objectives", () => {
	for (const source of [{ kind: "manual" }, { kind: "framework", framework: "AP Physics 1" }, { kind: "syllabus", sourceName: "Course", quote: "Compute force" }, { kind: "aiGapFill", reason: "Prerequisite" }] as const) {
		const result = reviseSubjectMapDefinition(original, { ...original, regions: [{ id: "mechanics", title: "Mechanics", description: "Motion" }], skills: [{ ...original.skills[0], regionId: "mechanics", source }] }, "now");
		assert.equal(result.ok, true);
		if (!result.ok) continue;
		assert.equal(result.definition.skills[0]!.revision, 3);
		const parsed = parsePortableSubjectMap(portableSubjectMap(result.definition), "now");
		assert.deepEqual(parsed, result);
	}
});

test("old maps retain absent metadata, empty regions are permitted", () => {
	assert.deepEqual(parsePortableSubjectMap(portableSubjectMap(original), "now"), { ok: true, definition: original });
	assert.equal("regions" in portableSubjectMap(original), false);
	assert.deepEqual(subjectMapDefinitionProblems({ ...original, regions: [] }), []);
});

test("metadata validates region ids, references, bounds and source shape", () => {
	for (const changed of [
		{ regions: [{ id: "bad id", title: "x", description: "" }] },
		{ regions: Array.from({ length: 51 }, (_, id) => ({ id: String(id), title: "x", description: "" })) },
		{ regions: [{ id: "r", title: "x", description: "" }, { id: "r", title: "x", description: "" }] },
		{ skills: [{ ...original.skills[0], regionId: "missing" }] },
		{ skills: [{ ...original.skills[0], source: { kind: "unknown" } }] },
		{ skills: [{ ...original.skills[0], source: { kind: "aiGapFill", reason: "x".repeat(501) } }] },
		{ skills: [{ ...original.skills[0], source: { kind: "syllabus", sourceName: "course", quote: "x".repeat(501) } }] },
		{ skills: [{ ...original.skills[0], source: { kind: "syllabus", sourceName: "x".repeat(201), quote: "quote" } }] },
		{ skills: [{ ...original.skills[0], source: { kind: "framework", framework: "x".repeat(201) } }] },
		{ skills: [{ ...original.skills[0], source: { kind: "manual", extra: "value" } }] },
	]) assert.ok(subjectMapDefinitionProblems({ ...original, ...changed }).length);
});

test("draft grouping and diffs include skill metadata and edge changes", () => {
	assert.deepEqual(groupSubjectMapSkills({ ...original, skills: [] }), []);
	assert.equal(groupSubjectMapSkills(original)[0]!.title, "Ungrouped");
	const next = { ...original, skills: [{ ...original.skills[0]!, source: { kind: "manual" as const } }, { id: "new", title: "New", objective: "Can explain", revision: 1 }], edges: [{ prerequisite: "force", dependent: "new" }] };
	const diff = diffSubjectMaps(original, next);
	assert.deepEqual(diff.added.map((skill) => skill.id), ["new"]);
	assert.deepEqual(diff.changed.map((skill) => skill.id), ["force"]);
	assert.deepEqual(diff.addedEdges, next.edges);
	assert.deepEqual(diffSubjectMaps(next, original).removed.map((skill) => skill.id), ["new"]);
	assert.deepEqual(diffSubjectMaps(original, original), { added: [], removed: [], changed: [], addedEdges: [], removedEdges: [] });
});
