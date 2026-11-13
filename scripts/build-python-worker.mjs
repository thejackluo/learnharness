import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "public", "python-worker");

fs.mkdirSync(outputDirectory, { recursive: true });
await build({
	absWorkingDir: root,
	entryPoints: ["components/python-code.worker.ts"],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	outfile: "public/python-worker/python-code.worker.mjs",
	logLevel: "warning",
});
