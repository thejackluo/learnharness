export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { resolveRuntimeMode } = await import("./src/core/runtime.ts");
	const resolved = resolveRuntimeMode(process.env);
	if ("error" in resolved) {
		console.error(`[runtime] ${resolved.error}`);
		process.exit(1);
	}
	if (resolved.mode !== "hosted") return;

	const { validateHostedRuntime } = await import("./src/server/runtime.ts");
	const problems = validateHostedRuntime();
	if (problems.length > 0) {
		for (const problem of problems) console.error(`[runtime] ${problem}`);
		process.exit(1);
	}

	const { acquireWriterLock } = await import("./src/server/writer-lock.ts");
	let lock;
	try {
		lock = await acquireWriterLock();
	} catch (error) {
		console.error(`[runtime] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const release = () => {
		void lock.release().then(() => process.exit(0), (error) => {
			console.error(`[runtime] Failed to release writer lock: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
	};
	process.once("exit", () => {
		try {
			lock.releaseSync();
		} catch (error) {
			console.error(`[runtime] Failed to release writer lock at exit: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	if (process.env.NEXT_MANUAL_SIG_HANDLE === "true") {
		process.once("SIGTERM", release);
		process.once("SIGINT", release);
	}
}
