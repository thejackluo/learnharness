export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { runtimeMode, validateHostedRuntime, acquireHostedWriterLock } = await import("./src/server/hosted-boot.ts");
	let mode: ReturnType<typeof runtimeMode>;
	try {
		mode = runtimeMode();
	} catch (error) {
		console.error(`[runtime] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (mode !== "hosted") return;

	const problems = validateHostedRuntime();
	if (problems.length > 0) {
		for (const problem of problems) console.error(`[runtime] ${problem}`);
		process.exit(1);
	}

	let lock: Awaited<ReturnType<typeof acquireHostedWriterLock>>;
	try {
		lock = await acquireHostedWriterLock();
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
