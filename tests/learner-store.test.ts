import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createLearnerProfileStore, LearnerProfileConflictError, LearnerProfileUnavailableError } =
	await import("../src/store/learner.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function emptyNext() {
	return { background: "", coursework: "", topics: [], excerpts: [], associations: [] };
}

test("learner profile reads are non-writing and absent profiles start at revision zero", () => {
	const directory = path.join(TMP_DATA, "learner");
	const store = createLearnerProfileStore(directory);
	const absent = store.read();
	assert.equal(absent.state, "absent");
	if (absent.state === "absent") assert.equal(absent.profile.revision, 0);
	assert.equal(fs.existsSync(directory), false);

	const profile = store.replace(emptyNext(), 0);
	assert.equal(profile.revision, 1);
	assert.equal(store.read().state, "ok");
});

test("learner profile replace uses compare-and-swap revisions", () => {
	const store = createLearnerProfileStore(path.join(TMP_DATA, "cas"));
	const first = store.replace(emptyNext(), 0);
	assert.throws(
		() => store.replace(emptyNext(), 0),
		(error) => error instanceof LearnerProfileConflictError &&
			error.current.state === "ok" &&
			error.current.profile.revision === first.revision,
	);
});

test("corrupt and future learner profiles refuse replacement without changing bytes", () => {
	for (const [name, bytes, state] of [
		["corrupt", "{not json", "corrupt"],
		["future", JSON.stringify({ version: 2, payload: "keep" }), "future"],
	] as const) {
		const directory = path.join(TMP_DATA, name);
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, "profile.json");
		fs.writeFileSync(file, bytes, "utf8");
		assert.equal(createLearnerProfileStore(directory).read().state, state);
		assert.throws(
			() => createLearnerProfileStore(directory).replace(emptyNext(), 0),
			(error) => error instanceof LearnerProfileUnavailableError && error.current.state === state,
		);
		assert.equal(fs.readFileSync(file, "utf8"), bytes);
	}
});

test("rename failure preserves the previous profile and removes its temporary file", () => {
	const directory = path.join(TMP_DATA, "rename");
	const store = createLearnerProfileStore(directory);
	store.replace(emptyNext(), 0);
	const file = path.join(directory, "profile.json");
	const original = fs.readFileSync(file, "utf8");
	const renameSync = fs.renameSync;
	try {
		fs.renameSync = (() => {
			throw new Error("synthetic rename failure");
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		assert.throws(() => store.replace(emptyNext(), 1), /synthetic rename failure/);
	} finally {
		fs.renameSync = renameSync;
		syncBuiltinESMExports();
	}
	assert.equal(fs.readFileSync(file, "utf8"), original);
	assert.deepEqual(fs.readdirSync(directory), ["profile.json"]);
});
