import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-map-drafts-hosted-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_RUNTIME = "hosted";
const { POST } = await import("../app/api/subject-maps/drafts/route.ts");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("hosted mode refuses PDF before invoking a model", async () => {
	const form = new FormData(); form.set("files", new File(["pdf"], "course.pdf"));
	const response = await POST(new Request("http://localhost/api/subject-maps/drafts", { method: "POST", body: form }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /filename|file type/);
});

test("hosted JSON and text uploads reach the honest missing-model refusal", async () => {
	for (const body of [JSON.stringify({ goal: "Physics" }), (() => { const form = new FormData(); form.set("files", new File(["Compute force"], "course.txt")); return form; })()]) {
		const response = await POST(new Request("http://localhost/api/subject-maps/drafts", { method: "POST", body, ...(typeof body === "string" ? { headers: { "content-type": "application/json" } } : {}) }));
		assert.equal(response.status, 503);
		assert.equal((await response.json()).code, "models_not_configured");
	}
});
