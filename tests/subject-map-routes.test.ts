import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subject-maps-"));
process.env.LH_DATA_DIR = TMP_DATA;

const mapsRoute = await import("../app/api/maps/route.ts");
const previewRoute = await import("../app/api/maps/import/preview/route.ts");
const importRoute = await import("../app/api/maps/import/route.ts");
const mapRoute = await import("../app/api/maps/[id]/route.ts");
const exportRoute = await import("../app/api/maps/[id]/export/route.ts");
const linksRoute = await import("../app/api/maps/[id]/links/route.ts");
const targetsRoute = await import("../app/api/learner/evidence/[id]/targets/route.ts");
const learnerTargetsRoute = await import("../app/api/learner/targets/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { learnerObservationId } = await import("../src/core/learner.ts");
const { createSubjectMapStore } = await import("../src/store/subject-maps.ts");

const MAPS_DIR = path.join(TMP_DATA, "maps");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/api/maps", {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
	});
}

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}

async function json(response: Response): Promise<Record<string, any>> {
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	return await response.json() as Record<string, any>;
}

function curriculum(overrides: Record<string, unknown> = {}) {
	return {
		format: "learnharness.subject-map",
		version: 1,
		title: "Operating systems",
		description: "Synthetic fixture",
		skills: [
			{ id: "processes", title: "Processes", objective: "Explain what a process is", revision: 1 },
			{ id: "threads", title: "Threads", objective: "Contrast threads and processes", revision: 1 },
			{ id: "scheduling", title: "Scheduling", objective: "Trace a round-robin schedule", revision: 3 },
			{ id: "unrelated", title: "Unrelated", objective: "Stand alone", revision: 1 },
		],
		edges: [
			{ prerequisite: "processes", dependent: "threads" },
			{ prerequisite: "threads", dependent: "scheduling" },
		],
		goals: ["scheduling"],
		retired: [],
		...overrides,
	};
}

function mapFiles(): string[] {
	return fs.existsSync(MAPS_DIR) ? fs.readdirSync(MAPS_DIR) : [];
}

async function createImported(): Promise<{ id: string; revision: number }> {
	const response = await importRoute.POST(request("POST", curriculum()));
	assert.equal(response.status, 201);
	const body = await json(response);
	assert.equal(response.headers.get("ETag"), `"${body.map.revision}"`);
	return { id: body.map.id, revision: body.map.revision };
}

function quizChat(correct: boolean): { chatId: string; evidenceId: string } {
	const chat = stores.chatStore.createChat("Synthetic lesson");
	const message = {
		id: `${chat.id}-result`,
		role: "toolResult",
		toolCallId: `${chat.id}-call`,
		toolName: "quiz",
		content: [],
		details: { kind: "quiz", questionText: "Which runs inside a process?", correct, dontKnow: false, gradingProvenance: "deterministic", answeredAt: "2026-10-01T00:00:00.000Z" },
		isError: false,
		timestamp: Date.parse("2026-10-01T00:00:00.000Z"),
	} as LhMessage;
	stores.chatStore.saveMessages(chat.id, [message]);
	return {
		chatId: chat.id,
		evidenceId: learnerObservationId({ chatId: chat.id, resultMessageId: message.id, callId: `${chat.id}-call` }),
	};
}

test("curriculum preview validates without writing; confirm imports; export round-trips without learner links", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error("unexpected network request");
	}) as typeof fetch;
	try {
		const preview = await previewRoute.POST(request("POST", curriculum()));
		assert.equal(preview.status, 200);
		const previewBody = await json(preview);
		assert.deepEqual(
			[previewBody.preview.skills, previewBody.preview.edges, previewBody.preview.goals],
			[4, 2, 1],
		);
		assert.deepEqual(mapFiles(), [], "preview must not write");

		for (const bad of [
			curriculum({ edges: [{ prerequisite: "threads", dependent: "processes" }, { prerequisite: "processes", dependent: "threads" }] }),
			curriculum({ edges: [{ prerequisite: "threads", dependent: "threads" }] }),
			curriculum({ edges: [{ prerequisite: "ghost", dependent: "threads" }] }),
			curriculum({ skills: [...curriculum().skills, curriculum().skills[0]] }),
			curriculum({ version: 2 }),
		]) {
			const response = await previewRoute.POST(request("POST", bad));
			assert.equal(response.status, 400);
			assert.ok((await json(response)).issues.length > 0);
		}
		assert.deepEqual(mapFiles(), []);

		const { id } = await createImported();
		const exported = await exportRoute.GET(request("GET"), ctx(id));
		assert.equal(exported.status, 200);
		assert.match(exported.headers.get("Content-Disposition") ?? "", /attachment/);
		const portable = await json(exported);
		assert.deepEqual(portable, curriculum());
		assert.doesNotMatch(JSON.stringify(portable), /map_|links|associations/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("manual create, edit and goal changes use If-Match; stale PUT/DELETE fail without overwriting", async () => {
	const created = await mapsRoute.POST(request("POST", { definition: { title: "Japanese", skills: [{ id: "kana", title: "Kana", objective: "Read hiragana" }], edges: [], goals: [] } }));
	assert.equal(created.status, 201);
	const { map } = await json(created);
	assert.equal(map.skills[0].revision, 1);

	const missing = await mapRoute.PUT(request("PUT", { definition: { title: "x", skills: [] } }), ctx(map.id));
	assert.equal(missing.status, 428);
	await json(missing);

	const edit = {
		title: "Japanese",
		skills: [{ id: "kana", title: "Kana", objective: "Read hiragana" }, { id: "kanji", title: "Kanji", objective: "Read N5 kanji" }],
		edges: [{ prerequisite: "kana", dependent: "kanji" }],
		goals: ["kanji"],
	};
	const saved = await mapRoute.PUT(request("PUT", { definition: edit }, { "if-match": `"${map.revision}"` }), ctx(map.id));
	assert.equal(saved.status, 200);
	const savedBody = await json(saved);
	assert.equal(savedBody.map.revision, 2);
	assert.equal(saved.headers.get("ETag"), "\"2\"");
	assert.deepEqual(savedBody.view.gaps.map((gap: { skillId: string }) => gap.skillId), ["kana", "kanji"]);
	assert.deepEqual(savedBody.view.gaps[0].paths, [{ goalId: "kanji", path: ["kana", "kanji"] }]);

	const stale = await mapRoute.PUT(request("PUT", { definition: { ...edit, title: "Overwrite" } }, { "if-match": `"${map.revision}"` }), ctx(map.id));
	assert.equal(stale.status, 412);
	const staleBody = await json(stale);
	assert.equal(staleBody.code, "revision_conflict");
	assert.equal(staleBody.current.title, "Japanese");

	const cycle = await mapRoute.PUT(request("PUT", { definition: { ...edit, edges: [...edit.edges, { prerequisite: "kanji", dependent: "kana" }] } }, { "if-match": "\"2\"" }), ctx(map.id));
	assert.equal(cycle.status, 400);
	assert.ok((await json(cycle)).issues.some((issue: string) => /cycle/.test(issue)));

	const staleDelete = await mapRoute.DELETE(request("DELETE", undefined, { "if-match": "\"1\"" }), ctx(map.id));
	assert.equal(staleDelete.status, 412);
	await json(staleDelete);
	const listBefore = await json(await mapsRoute.GET());
	assert.ok(listBefore.maps.some((summary: { id: string }) => summary.id === map.id));
	const deleted = await mapRoute.DELETE(request("DELETE", undefined, { "if-match": "\"2\"" }), ctx(map.id));
	assert.equal(deleted.status, 200);
	await json(deleted);
	const gone = await mapRoute.GET(request("GET"), ctx(map.id));
	assert.equal(gone.status, 404);
	await json(gone);
});

test("a curriculum that previews within the body limit also imports (same body, no wrapper)", async () => {
	const base = curriculum();
	const filler = "x".repeat(1024 * 1024 - JSON.stringify(base).length - 40);
	const nearLimit = { ...base, description: "", skills: base.skills.map((skill, index) => index === 0 ? { ...skill, objective: "o" } : skill) };
	const padded = { ...nearLimit, padding: filler };
	const body = JSON.stringify(padded);
	assert.ok(body.length <= 1024 * 1024 && body.length > 1024 * 1024 - 100, String(body.length));
	const preview = await previewRoute.POST(request("POST", body));
	assert.equal(preview.status, 200);
	await json(preview);
	const imported = await importRoute.POST(request("POST", body));
	assert.equal(imported.status, 201);
	await json(imported);
});

test("oversized, deep, malformed and chunked bodies are bounded", async () => {
	const large = await mapsRoute.POST(request("POST", `{"definition":"${"x".repeat(1024 * 1024)}"}`));
	assert.equal(large.status, 413);
	await json(large);
	let deep: unknown = 1;
	for (let i = 0; i < 40; i++) deep = { d: deep };
	const nested = await importRoute.POST(request("POST", { curriculum: deep }));
	assert.equal(nested.status, 400);
	await json(nested);
	const malformed = await mapsRoute.POST(request("POST", "{"));
	assert.equal(malformed.status, 400);
	await json(malformed);
	const encoder = new TextEncoder();
	const text = JSON.stringify(curriculum());
	const chunks = [encoder.encode(text.slice(0, 20)), encoder.encode(text.slice(20, 200)), encoder.encode(text.slice(200))];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const chunked = await importRoute.POST(new Request("http://localhost/api/maps/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: stream,
		duplex: "half",
	} as RequestInit));
	assert.equal(chunked.status, 201);
	await json(chunked);
});

test("corrupt and future map files are listed, never reset or overwritten; stray temp files are ignored", async () => {
	fs.mkdirSync(MAPS_DIR, { recursive: true });
	const corruptId = "map_corrupt-fixture";
	const futureId = "map_future-fixture";
	fs.writeFileSync(path.join(MAPS_DIR, `${corruptId}.json`), "{not json");
	fs.writeFileSync(path.join(MAPS_DIR, `${futureId}.json`), JSON.stringify({ version: 2, id: futureId }));
	fs.writeFileSync(path.join(MAPS_DIR, `.${corruptId}.json.tmp-1-x`), "partial write");
	const list = await json(await mapsRoute.GET());
	const states = Object.fromEntries(list.maps.map((summary: { id: string; state: string }) => [summary.id, summary.state]));
	assert.equal(states[corruptId], "corrupt");
	assert.equal(states[futureId], "future");
	for (const id of [corruptId, futureId]) {
		const before = fs.readFileSync(path.join(MAPS_DIR, `${id}.json`), "utf8");
		const put = await mapRoute.PUT(request("PUT", { definition: { title: "x", skills: [] } }, { "if-match": "\"1\"" }), ctx(id));
		assert.equal(put.status, 409);
		assert.equal((await json(put)).code, "map_unwritable");
		const del = await mapRoute.DELETE(request("DELETE", undefined, { "if-match": "\"1\"" }), ctx(id));
		assert.equal(del.status, 409);
		await json(del);
		assert.equal(fs.readFileSync(path.join(MAPS_DIR, `${id}.json`), "utf8"), before);
	}
	const traversal = await mapRoute.GET(request("GET"), ctx("../learner/profile"));
	assert.equal(traversal.status, 404);
	await json(traversal);
	fs.rmSync(path.join(MAPS_DIR, `${corruptId}.json`));
	fs.rmSync(path.join(MAPS_DIR, `${futureId}.json`));
});

test("a reopened store reads the same map after restart, with owner-only permissions", async () => {
	const { id } = await createImported();
	const reopened = createSubjectMapStore(MAPS_DIR);
	const read = reopened.read(id);
	assert.equal(read.state, "ok");
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(path.join(MAPS_DIR, `${id}.json`)).mode & 0o777, 0o600);
		assert.equal(fs.statSync(MAPS_DIR).mode & 0o777, 0o700);
	}
	assert.ok(!fs.readdirSync(MAPS_DIR).some((name) => name.includes(".tmp-") && name.includes(id)));
});

test("explicit evidence links resolve the current skill revision, survive objective edits as historical, and show deleted sources and maps", async () => {
	const { id, revision } = await createImported();
	const pass = quizChat(true);
	const miss = quizChat(false);
	const graphBefore = stores.graphStore.readNodes().length;
	const profile = stores.learnerProfileStore.read();
	assert.ok(profile.state === "absent" || profile.state === "ok");
	let profileRevision = profile.profile.revision;

	const attach = async (evidenceId: string, skillId: string, skillRevision: unknown = skillId === "scheduling" ? 3 : 1) => {
		const response = await targetsRoute.POST(new Request("http://localhost/x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mapId: id, skillId, skillRevision, expectedRevision: profileRevision }),
		}), ctx(evidenceId));
		return response;
	};
	for (const invalid of [undefined, null, 0, -1, 1.5, "3"]) {
		const response = await targetsRoute.POST(request("POST", { mapId: id, skillId: "scheduling", skillRevision: invalid, expectedRevision: profileRevision }), ctx(pass.evidenceId));
		assert.equal(response.status, 400);
		assert.deepEqual((await json(response)).issues, ["skillRevision must be a positive integer"]);
	}
	const linked = await attach(pass.evidenceId, "scheduling");
	assert.equal(linked.status, 200);
	const linkedBody = await json(linked);
	assert.deepEqual(linkedBody.profile.associations.at(-1).target, { kind: "subject-skill", mapId: id, skillId: "scheduling", skillRevision: 3 });
	profileRevision = linkedBody.profile.revision;

	const staleProfile = await attach(miss.evidenceId, "threads");
	const staleProfileStatus = staleProfile.status;
	profileRevision = (await json(staleProfile)).profile?.revision ?? profileRevision;
	assert.equal(staleProfileStatus, 200);

	const conflict = await targetsRoute.POST(new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mapId: id, skillId: "threads", skillRevision: 1, expectedRevision: 0 }),
	}), ctx(pass.evidenceId));
	assert.equal(conflict.status, 409);
	assert.equal((await json(conflict)).code, "revision_conflict");

	for (const [skillId, status] of [["ghost", 409], ["processes", 404]] as const) {
		const response = await attach(skillId === "ghost" ? pass.evidenceId : "ev:missing:r:c:", skillId);
		assert.equal(response.status, status, skillId);
		await json(response);
	}

	let view = (await json(await mapRoute.GET(request("GET"), ctx(id)))).view;
	const statusOf = (skillId: string) => view.skills.find((s: { skill: { id: string } }) => s.skill.id === skillId).evidence;
	assert.equal(statusOf("scheduling").status, "supporting");
	assert.equal(statusOf("threads").status, "needsPractice");
	assert.equal(statusOf("processes").status, "notChecked");
	assert.equal(statusOf("scheduling").current[0].observation.provenance, "deterministic");
	assert.deepEqual(view.gaps.map((gap: { skillId: string }) => gap.skillId), ["processes", "threads"]);
	assert.equal(view.skills.find((s: { skill: { id: string } }) => s.skill.id === "unrelated").inClosure, false);

	const edited = curriculum().skills.map((skill) => skill.id === "scheduling" ? { ...skill, objective: "Compare schedulers" } : skill);
	const put = await mapRoute.PUT(request("PUT", { definition: { ...curriculum(), skills: edited } }, { "if-match": `"${revision}"` }), ctx(id));
	assert.equal(put.status, 200);
	view = (await json(put)).view;
	assert.equal(statusOf("scheduling").status, "notChecked");
	assert.equal(statusOf("scheduling").reviewNeeded, true);
	assert.equal(statusOf("scheduling").historical[0].skillRevision, 3);
	assert.equal(statusOf("threads").status, "needsPractice", "unchanged objectives keep their evidence");
	const beforeStaleRead = stores.learnerProfileStore.read();
	assert.equal(beforeStaleRead.state, "ok");
	assert.ok(beforeStaleRead.state === "ok");
	const beforeStaleAttach = beforeStaleRead.profile;
	const staleSkill = await attach(miss.evidenceId, "scheduling", 3);
	assert.equal(staleSkill.status, 409);
	const staleSkillBody = await json(staleSkill);
	assert.equal(staleSkillBody.code, "skill_revision_conflict");
	assert.deepEqual(staleSkillBody.current, { id: "scheduling", title: "Scheduling", objective: "Compare schedulers", revision: 4 });
	const afterStaleRead = stores.learnerProfileStore.read();
	assert.ok(afterStaleRead.state === "ok");
	const afterStaleAttach = afterStaleRead.profile;
	assert.deepEqual(afterStaleAttach.associations, beforeStaleAttach.associations);
	assert.equal(afterStaleAttach.revision, beforeStaleAttach.revision);

	stores.chatStore.deleteChat(miss.chatId);
	view = (await json(await mapRoute.GET(request("GET"), ctx(id)))).view;
	assert.equal(statusOf("threads").status, "unavailable");
	assert.equal(view.evidenceAvailability, "partial");

	const mapRevision = (await json(await mapRoute.GET(request("GET"), ctx(id)))).map.revision;
	const del = await mapRoute.DELETE(request("DELETE", undefined, { "if-match": `"${mapRevision}"` }), ctx(id));
	assert.equal(del.status, 200);
	await json(del);
	const links = await json(await learnerTargetsRoute.GET());
	assert.equal(links.availability, "available");
	const mine = links.links.filter((link: { target: { mapId: string } }) => link.target.mapId === id);
	assert.deepEqual(mine.map((link: { targetStatus: string; sourceStatus: string }) => [link.targetStatus, link.sourceStatus]).sort(), [["missingMap", "available"], ["missingMap", "unavailable"]]);

	const detach = await targetsRoute.DELETE(new Request("http://localhost/x", {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target: mine[0].target, expectedRevision: links.profileRevision }),
	}), ctx(mine[0].evidenceId));
	assert.equal(detach.status, 200);
	await json(detach);
	assert.equal(stores.graphStore.readNodes().length, graphBefore, "no graph mutation");
});

test("skill links preserve regions, keystones and alternative routes after linking and unlinking", async () => {
	const regions = [{ id: "os", title: "OS", description: "Operating systems" }];
	const alternatives = [{ dependent: "scheduling", options: ["processes", "unrelated"] }];
	const definition = curriculum({ regions, alternatives });
	definition.skills = definition.skills.map((skill) => ({ ...skill, regionId: "os", ...(skill.id === "processes" ? { keystone: true } : {}) }));
	const imported = await importRoute.POST(request("POST", definition));
	assert.equal(imported.status, 201);
	const { map } = await json(imported);
	stores.graphStore.appendNode({ id: "n_region", name: "Region fixture", statement: "Synthetic link target", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] });
	let revision = map.revision;
	for (const method of ["POST", "DELETE"] as const) {
		const response = await linksRoute[method](request(method, { kind: "proposition", skillId: "scheduling", refId: "n_region" }, { "if-match": `"${revision}"` }), ctx(map.id));
		assert.equal(response.status, 200);
		const updated = (await json(response)).map;
		revision = updated.revision;
		const read = stores.subjectMapStore.read(map.id);
		assert.equal(read.state, "ok");
		assert.ok(read.state === "ok");
		assert.deepEqual(read.map.regions, regions);
		assert.equal(read.map.skills[0]!.regionId, "os");
		assert.equal(read.map.skills[0]!.keystone, true);
		assert.deepEqual(read.map.alternatives, alternatives);
		assert.equal(read.map.links.propositions.length, method === "POST" ? 1 : 0);
	}
});

test("proposition and topic links require an existing graph node or profile topic and never count as evidence", async () => {
	const { id, revision } = await createImported();
	stores.graphStore.appendNode({ id: "n_sched", name: "Round robin", statement: "Round robin rotates a time slice.", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] });
	const profile = stores.learnerProfileStore.read();
	assert.ok(profile.state === "absent" || profile.state === "ok");
	const withTopic = stores.learnerProfileStore.replace({
		background: profile.profile.background,
		coursework: profile.profile.coursework,
		topics: [...profile.profile.topics, { id: "topic-sched", topic: "Scheduling", familiarity: "practiced", updatedAt: "2026-10-02T00:00:00.000Z" }],
		excerpts: profile.profile.excerpts,
		associations: profile.profile.associations,
	}, profile.profile.revision);
	assert.ok(withTopic.revision >= 1);

	const link = (kind: string, refId: string, rev: number) => linksRoute.POST(request("POST", { kind, skillId: "scheduling", refId }, { "if-match": `"${rev}"` }), ctx(id));
	const missingNode = await link("proposition", "n_missing", revision);
	assert.equal(missingNode.status, 404);
	await json(missingNode);
	const nodeLinked = await link("proposition", "n_sched", revision);
	assert.equal(nodeLinked.status, 200);
	const nodeBody = await json(nodeLinked);
	const stale = await link("topic", "topic-sched", revision);
	assert.equal(stale.status, 412);
	await json(stale);
	const topicLinked = await link("topic", "topic-sched", nodeBody.map.revision);
	assert.equal(topicLinked.status, 200);
	const { view, map } = await json(topicLinked);
	const scheduling = view.skills.find((s: { skill: { id: string } }) => s.skill.id === "scheduling");
	assert.equal(scheduling.encounter.status, "linked");
	assert.equal(scheduling.encounter.propositions[0].name, "Round robin");
	assert.equal(scheduling.selfReport.claims[0].claim.familiarity, "practiced");
	assert.equal(scheduling.evidence.status, "notChecked");

	const exported = await json(await exportRoute.GET(request("GET"), ctx(id)));
	assert.doesNotMatch(JSON.stringify(exported), /n_sched|topic-sched/);

	const unlinked = await linksRoute.DELETE(request("DELETE", { kind: "topic", skillId: "scheduling", refId: "topic-sched" }, { "if-match": `"${map.revision}"` }), ctx(id));
	assert.equal(unlinked.status, 200);
	assert.equal((await json(unlinked)).map.links.topics.length, 0);
});
