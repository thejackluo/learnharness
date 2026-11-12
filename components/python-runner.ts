import type { AssessmentPart, CodeTestResult } from "@/src/core";

export type CodeExerciseRunner = (
	part: Extract<AssessmentPart, { kind: "code" }>,
	source: string,
) => Promise<CodeTestResult[]>;

type WorkerMessage =
	| { type: "result"; result: CodeTestResult }
	| { type: "ready" }
	| { type: "done" }
	| { type: "error"; error: string };

function capUtf16(value: string, maxUnits: number): string {
	if (value.length <= maxUnits) return value;
	const splitsSurrogatePair = value.charCodeAt(maxUnits - 1) >= 0xD800 &&
		value.charCodeAt(maxUnits - 1) <= 0xDBFF &&
		value.charCodeAt(maxUnits) >= 0xDC00 &&
		value.charCodeAt(maxUnits) <= 0xDFFF;
	return value.slice(0, splitsSurrogatePair ? maxUnits - 1 : maxUnits);
}

function boundedResult(result: CodeTestResult): CodeTestResult {
	return {
		...result,
		...(result.actual !== undefined ? { actual: capUtf16(result.actual, 500) } : {}),
		...(result.error !== undefined ? { error: capUtf16(result.error, 500) } : {}),
		...(result.stdout !== undefined ? { stdout: capUtf16(result.stdout, 2000) } : {}),
	};
}

export const runPythonCode: CodeExerciseRunner = (part, source) => new Promise((resolve) => {
	const results = new Map<string, CodeTestResult>();
	const worker = new Worker(new URL("./python-code.worker.ts", import.meta.url), { type: "module" });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	const finish = (timedOut = false, error?: string) => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		worker.terminate();
		resolve(part.tests.map(test => results.get(test.id) ?? {
			testId: test.id,
			status: timedOut ? "timeout" : "error",
			...(error ? { error: capUtf16(error, 500) } : {}),
		}));
	};

	worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
		const message = event.data;
		if (message.type === "ready") {
			timeout = setTimeout(() => finish(true), part.timeLimitMs);
		} else if (message.type === "result") {
			results.set(message.result.testId, boundedResult(message.result));
		} else if (message.type === "done") {
			finish();
		} else {
			finish(false, message.error);
		}
	};
	worker.onerror = () => finish(false, "Python worker failed.");
	worker.postMessage({ source, tests: part.tests.map(({ id, call, expected }) => ({ id, call, expected })) });
});
