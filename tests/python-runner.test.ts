import assert from "node:assert/strict";
import test from "node:test";
import { runPythonCode } from "../components/python-runner.ts";
import type { AssessmentPart } from "../src/core/contracts/assessment.ts";

test("Python runs use fresh workers and time out only tests without results", async () => {
	const part = {
		id: "sum",
		kind: "code",
		language: "python",
		prompt: "Write add.",
		starter: "",
		tests: [
			{ id: "first", name: "First", call: "1", expected: "1" },
			{ id: "second", name: "Second", call: "2", expected: "2" },
		],
		timeLimitMs: 500,
		criteria: [{ id: "sum", description: "Pass all tests", maxPoints: 1, expectedEvidence: "All pass" }],
	} as Extract<AssessmentPart, { kind: "code" }>;
	const originalWorker = globalThis.Worker;
	const workers: Array<{ terminated: boolean }> = [];
	let created = 0;
	class FakeWorker {
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: (() => void) | null = null;
		terminated = false;

		constructor(_url: URL, _options: WorkerOptions) {
			created++;
			workers.push(this);
		}

		postMessage() {
			const send = (data: unknown) => this.onmessage?.({ data } as MessageEvent);
			queueMicrotask(() => {
				send({ type: "ready" });
				setTimeout(() => {
					send({ type: "result", result: { testId: "first", status: "pass", actual: "1" } });
					if (created > 1) {
						send({ type: "result", result: { testId: "second", status: "pass", actual: "2" } });
						send({ type: "done" });
					}
				}, 10);
			});
		}

		terminate() {
			this.terminated = true;
		}
	}
	Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
	try {
		const timedOut = await runPythonCode(part, "source");
		assert.deepEqual(timedOut.map(result => result.status), ["pass", "timeout"]);
		assert.equal(workers[0]?.terminated, true);

		const completed = await runPythonCode(part, "source");
		assert.deepEqual(completed.map(result => result.status), ["pass", "pass"]);
		assert.equal(created, 2);
		assert.equal(workers[1]?.terminated, true);
	} finally {
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
	}
});

test("Python results are capped in UTF-16 units without splitting surrogate pairs", async () => {
	const part = {
		id: "unicode",
		kind: "code",
		language: "python",
		prompt: "Return text.",
		starter: "",
		tests: [{ id: "unicode", name: "Unicode", call: "1", expected: "1" }],
		timeLimitMs: 500,
		criteria: [{ id: "unicode", description: "Pass", maxPoints: 1, expectedEvidence: "Pass" }],
	} as Extract<AssessmentPart, { kind: "code" }>;
	const result = {
		testId: "unicode",
		status: "error" as const,
		actual: "😀".repeat(300),
		error: `${"x".repeat(499)}😀`,
		stdout: "🙂".repeat(1100),
	};
	const originalWorker = globalThis.Worker;
	class FakeWorker {
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: (() => void) | null = null;

		constructor(_url: URL, _options: WorkerOptions) {}

		postMessage() {
			const send = (data: unknown) => this.onmessage?.({ data } as MessageEvent);
			queueMicrotask(() => {
				send({ type: "ready" });
				send({ type: "result", result });
				send({ type: "done" });
			});
		}

		terminate() {}
	}
	Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
	try {
		const [bounded] = await runPythonCode(part, "");
		assert.equal(bounded?.actual, "😀".repeat(250));
		assert.equal(bounded?.actual?.length, 500);
		assert.equal(bounded?.error, "x".repeat(499));
		assert.equal(bounded?.error?.length, 499);
		assert.equal(bounded?.stdout, "🙂".repeat(1000));
		assert.equal(bounded?.stdout?.length, 2000);
	} finally {
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
	}
});
