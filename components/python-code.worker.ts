import { PYTHON_HARNESS } from "@/src/core";
import { lockWorkerNetwork } from "./worker-network-lockdown";

type PyodideModule = typeof import("pyodide");
type WorkerRequest = {
	source: string;
	tests: Array<{ id: string; call: string; expected: string }>;
};

type PythonRuntime = {
	globals: { set(name: string, value: unknown): void };
	runPythonAsync(code: string): Promise<unknown>;
};
const workerScope = self as unknown as {
	onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
	postMessage(message: unknown): void;
};

let runtimePromise: Promise<PythonRuntime>;

async function runtime(): Promise<PythonRuntime> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const url = "/pyodide/pyodide.mjs";
			const pyodideModule = await import(/* webpackIgnore: true */ url) as PyodideModule;
			const pyodide = await pyodideModule.loadPyodide({ indexURL: "/pyodide/" }) as unknown as PythonRuntime;
			await pyodide.runPythonAsync("import ast, builtins, contextlib, io, json, traceback");
			return pyodide;
		})();
	}
	return runtimePromise;
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	try {
		const pyodide = await runtime();
		lockWorkerNetwork(workerScope as unknown as Record<string, unknown>);
		workerScope.postMessage({ type: "ready" });
		pyodide.globals.set("__lh_request_json", JSON.stringify(event.data));
		pyodide.globals.set("__lh_post_result", (json: string) => {
			workerScope.postMessage({ type: "result", result: JSON.parse(json) });
		});
		await pyodide.runPythonAsync(PYTHON_HARNESS);
		workerScope.postMessage({ type: "done" });
	} catch (error) {
		workerScope.postMessage({ type: "error", error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "Python runtime failed." });
	}
};
