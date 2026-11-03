import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { PortableSubjectMapV1, SubjectMapV1 } from "../src/core/contracts/subject-map.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-map-drafts-test-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_RUNTIME = "local";
const { draftSubjectMap, refineSubjectMap, MapDraftValidationError } = await import("../src/server/map-drafts.ts");
const { handleMapDraftRequest } = await import("../src/server/map-draft-http.ts");
const createRoute = await import("../app/api/subject-maps/drafts/route.ts");
const refineRoute = await import("../app/api/subject-maps/[id]/drafts/route.ts");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const valid: PortableSubjectMapV1 = { format: "learnharness.subject-map", version: 1, title: "Physics", description: "", regions: [{ id: "motion", title: "Motion", description: "" }], skills: [{ id: "force", title: "Force", objective: "Can compute force", revision: 1, regionId: "motion", source: { kind: "syllabus", sourceName: "course.txt", quote: "Compute force" } }], edges: [], goals: ["force"], retired: [] };

function engine(...drafts: PortableSubjectMapV1[]) {
	const faux = createFauxCore({});
	let calls = 0;
	const prompts: string[] = [];
	faux.setResponses(drafts.map((draft, index) => (context) => {
		calls++;
		prompts.push(JSON.stringify(context.messages));
		return fauxAssistantMessage([fauxToolCall("submit_map", draft as unknown as ToolCall["arguments"], { id: `draft-${index}` })], { stopReason: "toolUse" });
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple } satisfies PiEngine, calls: () => calls, prompts };
}
const request = (body: unknown) => new Request("http://localhost/api/subject-maps/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("fake-engine drafting returns usage and verifies whitespace-normalized syllabus quotes without persistence", async () => {
	const fake = engine(valid);
	const result = await draftSubjectMap({ syllabus: { name: "course.txt", text: "Week 1: Compute\n  force using Newton's laws" } }, fake);
	assert.equal(fake.calls(), 1);
	assert.deepEqual(result.issues, []);
	assert.equal(result.draft.skills[0]!.source?.kind, "syllabus");
	assert.equal(result.usage?.steps, 1);
	assert.equal(fs.existsSync(path.join(dir, "maps")), false);
});

test("missing or unmatched syllabus quotes are downgraded", async () => {
	for (const syllabus of [undefined, { name: "course", text: "Not this quote" }]) {
		const result = await draftSubjectMap({ goal: "Physics", syllabus }, engine(valid));
		assert.deepEqual(result.draft.skills[0]!.source, { kind: "aiGapFill", reason: "quote not found in syllabus" });
	}
});

test("verified quotes are attributed to the uploaded syllabus rather than the model's name", async () => {
	const result = await draftSubjectMap({ syllabus: { name: "actual-syllabus.txt", text: "Week 1: Compute\n force" } }, engine(valid));
	assert.deepEqual(result.draft.skills[0]!.source, { kind: "syllabus", sourceName: "actual-syllabus.txt", quote: "Compute force" });
});

test("new drafts use existing create semantics for objective revisions", async () => {
	const result = await draftSubjectMap({ framework: "AP Physics 1" }, engine({ ...valid, skills: [{ ...valid.skills[0]!, revision: 99 }] }));
	assert.equal(result.draft.skills[0]!.revision, 1);
});

test("one repair call lists invalid references, accumulates usage, and returns valid output", async () => {
	const fake = engine({ ...valid, goals: ["missing"] }, valid);
	const result = await draftSubjectMap({ goal: "Physics" }, fake);
	assert.equal(fake.calls(), 2);
	assert.equal(result.usage?.steps, 2);
	assert.match(fake.prompts[1]!, /goal missing is not a skill/);
});

test("two invalid drafts produce a typed failure and HTTP 422 with issues", async () => {
	const invalid = { ...valid, goals: ["missing"] };
	await assert.rejects(draftSubjectMap({ goal: "Physics" }, engine(invalid, invalid)), MapDraftValidationError);
	const fake = engine(invalid, invalid);
	const response = await handleMapDraftRequest(request({ goal: "Physics" }), undefined, fake);
	assert.equal(response.status, 422);
	assert.match((await response.json()).issues.join(" "), /unknown|not a skill/);
	assert.equal(fake.calls(), 2);
});

test("refinement preserves tombstones, rejects reused ids and owns objective revisions", async () => {
	const previous: SubjectMapV1 = { ...valid, retired: [{ id: "retired", title: "Old", revision: 2, retiredAt: "then" }], version: 1, id: "map_test", revision: 4, createdAt: "then", updatedAt: "then", links: { propositions: [], topics: [] }, skills: [{ ...valid.skills[0]!, revision: 3 }] };
	const bad = { ...valid, skills: [{ ...valid.skills[0]!, id: "retired" }], goals: [] };
	const fake = engine(bad, valid);
	const result = await refineSubjectMap(previous.id, { instruction: "Reorganize" }, { ...fake, readMap: () => ({ state: "ok", map: previous }) });
	assert.equal(fake.calls(), 2);
	assert.match(fake.prompts[1]!, /retired skill id retired cannot be reused/);
	assert.deepEqual(result.draft.retired, previous.retired);
	assert.equal(result.draft.skills[0]!.revision, 3);
	const changed = await refineSubjectMap(previous.id, { instruction: "Expand" }, { ...engine({ ...valid, skills: [{ ...valid.skills[0]!, objective: "Can explain inertia", revision: 99 }] }), readMap: () => ({ state: "ok", map: previous }) });
	assert.equal(changed.draft.skills[0]!.revision, 4);
});

test("routes reject empty and oversized fields and return unknown-map 404", async () => {
	for (const body of [{}, { goal: "x".repeat(501) }, { framework: "x".repeat(201) }, { syllabus: { name: "course", text: "x".repeat(200 * 1024 + 1) } }]) {
		const response = await createRoute.POST(request(body));
		assert.ok([400, 413].includes(response.status));
	}
	assert.equal((await refineRoute.POST(request({ instruction: "Expand" }), { params: Promise.resolve({ id: "map_missing" }) })).status, 404);
	assert.equal((await refineRoute.POST(request({ instruction: "x".repeat(1001) }), { params: Promise.resolve({ id: "map_missing" }) })).status, 400);
	assert.equal((await createRoute.POST(new Request("http://localhost/api/subject-maps/drafts", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=missing" }, body: "broken" }))).status, 400);
});

test("model and provider refusals propagate and preserve their route envelopes", async () => {
	for (const error of [new ModelsNotConfiguredError(["strong"]), new ProviderKeyMissingError("openrouter", ["strong"])]) {
		const deps = { ...engine(), drafter: async () => { throw error; } };
		await assert.rejects(draftSubjectMap({ goal: "Physics" }, deps), (caught) => caught === error);
		const response = await handleMapDraftRequest(request({ goal: "Physics" }), undefined, deps);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), error.envelope);
	}
});

test("local text upload drafts", async () => {
		const text = new FormData(); text.set("files", new File(["Compute force"], "course.txt"));
		const response = await handleMapDraftRequest(new Request("http://localhost/api/subject-maps/drafts", { method: "POST", body: text }), undefined, engine(valid));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).draft.skills[0].source.kind, "syllabus");
});

test("local PDF upload extracts all pages through pdf-ops", async () => {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Length 45 >>\nstream\nBT /F1 12 Tf 20 700 Td (Compute force) Tj ET\nendstream",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const xref = pdf.length;
	pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	const form = new FormData(); form.set("files", new File([pdf], "course.pdf"));
	const response = await handleMapDraftRequest(new Request("http://localhost/api/subject-maps/drafts", { method: "POST", body: form }), undefined, engine(valid));
	assert.equal(response.status, 200);
	assert.equal((await response.json()).draft.skills[0].source.kind, "syllabus");
});

test("refinement without a syllabus keeps previously recorded syllabus provenance but downgrades new or altered quotes", async () => {
	const previous: SubjectMapV1 = { ...valid, retired: [], version: 1, id: "map_test", revision: 4, createdAt: "then", updatedAt: "then", links: { propositions: [], topics: [] } };
	const forged = { ...valid.skills[0]!, id: "torque", title: "Torque", objective: "Can compute torque", source: { kind: "syllabus" as const, sourceName: "course.txt", quote: "Compute torque" } };
	const renamed = { ...valid.skills[0]!, id: "energy", title: "Energy", objective: "Can compute energy", source: { kind: "syllabus" as const, sourceName: "other.txt", quote: "Compute force" } };
	const result = await refineSubjectMap(previous.id, { instruction: "Expand" }, { ...engine({ ...valid, skills: [valid.skills[0]!, forged, renamed] }), readMap: () => ({ state: "ok", map: previous }) });
	assert.deepEqual(result.draft.skills.map((skill) => skill.source), [
		{ kind: "syllabus", sourceName: "course.txt", quote: "Compute force" },
		{ kind: "aiGapFill", reason: "quote not found in syllabus" },
		{ kind: "aiGapFill", reason: "quote not found in syllabus" },
	]);
});

test("retained syllabus provenance belongs to the same skill id, not a new skill copying its quote", async () => {
	const previous: SubjectMapV1 = { ...valid, retired: [], version: 1, id: "map_test", revision: 4, createdAt: "then", updatedAt: "then", links: { propositions: [], topics: [] } };
	const source = { kind: "syllabus" as const, sourceName: "course.txt", quote: "Compute\n  force" };
	const original = { ...valid.skills[0]!, source };
	const copied = { ...original, id: "copy", title: "Copied quote" };
	for (const syllabus of [undefined, { name: "other.txt", text: "A different syllabus" }]) {
		const result = await refineSubjectMap(previous.id, { instruction: "Expand", syllabus }, { ...engine({ ...valid, skills: [original, copied] }), readMap: () => ({ state: "ok", map: previous }) });
		assert.deepEqual(result.draft.skills.map((skill) => skill.source), [
			source,
			{ kind: "aiGapFill", reason: "quote not found in syllabus" },
		]);
	}
});

test("a same-name syllabus upload must verify previously recorded quotes against its current text", async () => {
	const previous: SubjectMapV1 = { ...valid, retired: [], version: 1, id: "map_test", revision: 4, createdAt: "then", updatedAt: "then", links: { propositions: [], topics: [] } };
	for (const text of ["Revised course: Compute torque", "Revised course: Compute\n  force"]) {
		const result = await refineSubjectMap(previous.id, { instruction: "Update", syllabus: { name: "course.txt", text } }, { ...engine(valid), readMap: () => ({ state: "ok", map: previous }) });
		assert.deepEqual(result.draft.skills[0]!.source, text.includes("torque")
			? { kind: "aiGapFill", reason: "quote not found in syllabus" }
			: valid.skills[0]!.source);
	}
});
