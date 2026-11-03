import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-familiarity-inference-"));
process.env.LH_DATA_DIR = data;
process.env.LH_RUNTIME = "local";
const [{ stores }, familiarity, http] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/familiarity.ts"),
	import("../src/server/familiarity-http.ts"),
]);
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

const map = stores.subjectMapStore.create({
	title: "Algebra", description: "Synthetic",
	skills: [{ id: "linear", title: "Linear equations", objective: "Solve linear equations", revision: 1 }],
	edges: [], goals: ["linear"], retired: [],
});
const faux = createFauxCore({});
const engine = { model: faux.getModel(), streamFn: faux.streamSimple } satisfies PiEngine;
const jsonRequest = (body: unknown) => new Request("http://localhost/api/learner/familiarity/infer", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("fake inference discards invalid items, accepts normalized quotes, and never persists source text", async () => {
	const input = { mapId: map.id, source: { name: "notes.md", text: "I already know algebra   basics." } };
	const result = await familiarity.inferFamiliarity(input, {
		engine,
		inferrer: async () => ({
			items: [
				{ skillId: "missing", quote: "I already know algebra" },
				{ skillId: "linear", quote: "this is not in the source" },
				{ skillId: "linear", quote: "algebra\tbasics" },
			],
			usage: undefined,
		}),
	});
	assert.equal(result.discarded, 2);
	assert.equal(result.added, 1);
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") {
		assert.deepEqual(profile.profile.suggestions?.[0]?.reason, { kind: "import", sourceName: "notes.md", quote: "algebra basics" });
		assert.equal(JSON.stringify(profile.profile).includes(input.source.text), false);
	}
	assert.equal(fs.readFileSync(path.join(data, "learner", "profile.json"), "utf8").includes(input.source.text), false);
});

test("inference route returns missing-map 404 and models-not-configured 503 envelopes", async () => {
	const missing = await http.handleFamiliarityInferenceRequest(jsonRequest({
		mapId: "map_00000000-0000-4000-8000-000000000000",
		source: { name: "notes.txt", text: "A synthetic source." },
	}));
	assert.equal(missing.status, 404);
	const unavailable = await http.handleFamiliarityInferenceRequest(jsonRequest({
		mapId: map.id, source: { name: "notes.txt", text: "A synthetic source." },
	}));
	assert.equal(unavailable.status, 503);
	assert.equal((await unavailable.json() as { code: string }).code, "models_not_configured");
});

test("local multipart inference uses the uploaded markdown filename as source name", async () => {
	const form = new FormData();
	form.set("mapId", map.id);
	form.set("files", new File(["Synthetic learner notes."], "learner-notes.md", { type: "text/markdown" }));
	let received: { mapId: string; source: { name: string; text: string } } | undefined;
	const response = await http.handleFamiliarityInferenceRequest(
		new Request("http://localhost/api/learner/familiarity/infer", { method: "POST", body: form }),
		async (input) => {
			received = input;
			return { added: 0, merged: 0, discarded: 0, usage: undefined, profileRevision: 0 };
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual(received, { mapId: map.id, source: { name: "learner-notes.md", text: "Synthetic learner notes." } });
});
