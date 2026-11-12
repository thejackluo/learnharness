import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "node_modules", "pyodide");
const target = path.join(root, "public", "pyodide");
const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;
if (version !== "314.0.7") throw new Error(`Expected pyodide 314.0.7, found ${version}`);
const assets = [
	"pyodide.js",
	"pyodide.mjs",
	"pyodide.asm.mjs",
	"pyodide.asm.wasm",
	"python_stdlib.zip",
	"pyodide-lock.json",
];

fs.mkdirSync(target, { recursive: true });
for (const asset of assets) {
	fs.copyFileSync(path.join(source, asset), path.join(target, asset));
}
fs.copyFileSync(path.join(source, "pyodide.asm.mjs"), path.join(target, "pyodide.asm.js"));
