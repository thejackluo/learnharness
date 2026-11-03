import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-familiarity-hosted-"));
process.env.LH_DATA_DIR = data;
process.env.LH_RUNTIME = "hosted";
const { handleFamiliarityInferenceRequest } = await import("../src/server/familiarity-http.ts");
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test("hosted multipart inference rejects a body over the reader cap with 413", async () => {
	const boundary = "synthetic-boundary";
	const body = Buffer.from([
		`--${boundary}\r\nContent-Disposition: form-data; name="mapId"\r\n\r\nmap_00000000-0000-4000-8000-000000000001\r\n`,
		`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="oversized.md"\r\nContent-Type: text/markdown\r\n\r\n`,
		"x".repeat(1024 * 1024 + 128 * 1024),
		`\r\n--${boundary}--\r\n`,
	].join(""));
	const response = await handleFamiliarityInferenceRequest(
		new Request("http://localhost/api/learner/familiarity/infer", {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.byteLength) },
			body,
		}),
		async () => { throw new Error("inference must not run for an oversized request"); },
	);
	assert.equal(response.status, 413);
	assert.equal((await response.json() as { error: string }).error, "Request body too large.");
});
