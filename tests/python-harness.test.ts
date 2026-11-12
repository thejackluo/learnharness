import assert from "node:assert/strict";
import test from "node:test";
import { PYTHON_HARNESS } from "../src/core/python-harness.ts";

type PyodideInstance = Awaited<ReturnType<typeof import("pyodide").loadPyodide>>;

test("the worker Python harness grades expressions in Pyodide with literal_eval", async (t) => {
	let pyodide: PyodideInstance;
	try {
		const { loadPyodide } = await import("pyodide");
		pyodide = await loadPyodide();
	} catch (error) {
		t.skip(`Pyodide could not load under Node; Python harness not exercised: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const run = async (source: string, tests: Array<{ id: string; call: string; expected: string }>) => {
		await pyodide.runPythonAsync(`__lh_request_json = ${JSON.stringify(JSON.stringify({ source, tests }))}`);
		return JSON.parse(String(await pyodide.runPythonAsync(PYTHON_HARNESS))) as Array<{
			testId: string; status: string; actual?: string; error?: string;
		}>;
	};
	try {
		assert.equal((await run("def add(a, b):\n    return a + b", [{ id: "pass", call: "add(2, 3)", expected: "5" }]))[0]?.status, "pass");
		const failed = await run("def add(a, b):\n    return a + b", [{ id: "fail", call: "add(2, 3)", expected: "6" }]);
		assert.equal(failed[0]?.status, "fail");
		assert.equal(failed[0]?.actual, "5");

		const syntax = await run("def broken(:\n    pass", [{ id: "syntax", call: "1", expected: "1" }]);
		assert.equal(syntax[0]?.status, "error");
		assert.match(syntax[0]?.error ?? "", /SyntaxError:.*line 1/);

		const runtime = await run("def broken():\n    raise ValueError('bad')", [{ id: "runtime", call: "broken()", expected: "1" }]);
		assert.equal(runtime[0]?.status, "error");
		assert.match(runtime[0]?.error ?? "", /ValueError: bad.*line 2/);

		const literal = await run("def values():\n    return [1, 2, {'x': True}]", [{ id: "literal", call: "values()", expected: "[1, 2, {'x': True}]" }]);
		assert.equal(literal[0]?.status, "pass");
		assert.equal(literal[0]?.actual, "[1, 2, {'x': True}]");
	} finally {
		pyodide.globals.destroy();
	}
});
