import assert from "node:assert/strict";
import { test } from "node:test";
import { readHostedImportRequest, validateHostedImportFiles } from "../src/server/hosted-import.ts";

test("hosted note imports accept bounded UTF-8 markdown and text files", async () => {
	const result = await validateHostedImportFiles([
		new File(["# Lesson notes\nhello"], "notes.MD"),
		new File(["## Markdown extension"], "notes.markdown"),
		new File(["plain text"], "notes.txt"),
	]);
	assert.deepEqual(result, {
		ok: true,
		files: [
			{ name: "notes.MD", text: "# Lesson notes\nhello" },
			{ name: "notes.markdown", text: "## Markdown extension" },
			{ name: "notes.txt", text: "plain text" },
		],
	});
});

test("hosted note imports reject count, aggregate size, unsafe names, and non-UTF-8 bytes", async () => {
	assert.equal((await validateHostedImportFiles(Array.from({ length: 6 }, (_, i) => new File(["x"], `${i}.txt`)))).ok, false);
	assert.equal((await validateHostedImportFiles([new File([new Uint8Array(1024 * 1024 + 1)], "large.txt")])).ok, false);
	for (const name of ["../notes.txt", ".hidden.md", "a/b.txt", "a\\b.txt", "bad\u0001.txt", "notes.pdf", ".", ".."]) {
		assert.equal((await validateHostedImportFiles([new File(["x"], name)])).ok, false, name);
	}
	for (const bytes of [new Uint8Array([0xff, 0xfe, 0x41, 0x00]), new Uint8Array([0xc3, 0x28])]) {
		assert.equal((await validateHostedImportFiles([new File([bytes], "notes.txt")])).ok, false);
	}
});

test("hosted import rejects oversized declared and streamed multipart bodies before parsing", async () => {
	const declared = await readHostedImportRequest(new Request("https://lh.invalid/api/graph/import", {
		method: "POST",
		headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(1024 * 1024 + 64 * 1024 + 1) },
		body: "--x--",
	}));
	assert.deepEqual(declared, { ok: false, status: 413, error: "Request body too large." });

	const body = new Uint8Array(1024 * 1024 + 64 * 1024 + 1);
	const streamed = await readHostedImportRequest(new Request("https://lh.invalid/api/graph/import", {
		method: "POST",
		headers: { "content-type": "multipart/form-data; boundary=x" },
		body,
	}));
	assert.deepEqual(streamed, { ok: false, status: 413, error: "Request body too large." });
});
