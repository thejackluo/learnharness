import assert from "node:assert/strict";
import { test } from "node:test";

test("hosted note import rejects before extraction begins", async () => {
	const previousRuntime = process.env.LH_RUNTIME;
	process.env.LH_RUNTIME = "hosted";
	try {
		const [{ POST }, { extraction }] = await Promise.all([
			import("../app/api/graph/import/route.ts"),
			import("../src/server/index.ts"),
		]);
		const original = extraction.importNotes;
		let calls = 0;
		extraction.importNotes = async () => {
			calls++;
			throw new Error("extraction must not run");
		};
		try {
			const form = new FormData();
			for (let i = 0; i < 6; i++) form.append("files", new File(["synthetic"], `notes-${i}.txt`));
			const response = await POST(new Request("https://lh.invalid/api/graph/import", { method: "POST", body: form }));
			assert.equal(response.status, 400);
			assert.equal(calls, 0);
		} finally {
			extraction.importNotes = original;
		}
	} finally {
		if (previousRuntime === undefined) delete process.env.LH_RUNTIME;
		else process.env.LH_RUNTIME = previousRuntime;
	}
});
