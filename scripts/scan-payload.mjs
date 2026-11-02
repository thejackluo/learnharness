#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

async function containsSentinel(file, sentinels) {
	if (sentinels.length === 0) return [];
	const found = new Set();
	const overlapSize = Math.max(...sentinels.map((value) => Buffer.byteLength(value))) - 1;
	let overlap = Buffer.alloc(0);
	for await (const chunk of fs.createReadStream(file)) {
		const current = Buffer.concat([overlap, chunk]);
		for (const sentinel of sentinels) {
			if (current.includes(Buffer.from(sentinel))) found.add(sentinel);
		}
		overlap = current.subarray(Math.max(0, current.length - overlapSize));
		if (found.size === sentinels.length) break;
	}
	return [...found];
}

export async function scanPayload(root, sentinels = []) {
	const issues = [];
	const visit = async (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			const relative = path.relative(root, file).split(path.sep).join("/");
			if (entry.name === "auth.json" || /credentials\.json/i.test(entry.name) || /^\.env/.test(entry.name)) {
				issues.push(`${relative}: sensitive filename`);
			}
			if (entry.name === "owner.json" || entry.name === "sessions.json") issues.push(`${relative}: owner state`);
			if (entry.name === ".lh-writer.sock") issues.push(`${relative}: writer lock`);
			if (entry.isDirectory() && entry.name === "data") {
				for (const child of ["chats", "graph", "jobs", "maps"]) {
					if (fs.existsSync(path.join(file, child))) issues.push(`${relative}/${child}: learner records`);
				}
			}
			if (entry.isDirectory()) await visit(file);
			else if (entry.isFile()) {
				for (const sentinel of await containsSentinel(file, sentinels)) {
					issues.push(`${relative}: contains sentinel ${JSON.stringify(sentinel)}`);
				}
			}
		}
	};
	if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
	await visit(path.resolve(root));
	return issues;
}

async function main(args) {
	const root = args[0];
	if (!root) throw new Error("Usage: node scripts/scan-payload.mjs DIRECTORY [--sentinel VALUE ...]");
	const sentinels = [];
	for (let index = 1; index < args.length; index++) {
		if (args[index] !== "--sentinel" || !args[index + 1]) throw new Error("Each sentinel must use --sentinel VALUE.");
		sentinels.push(args[++index]);
	}
	const issues = await scanPayload(path.resolve(root), sentinels);
	if (issues.length) {
		for (const issue of issues) console.error(`[scan-payload] REFUSED: ${issue}`);
		process.exitCode = 1;
	} else {
		console.log(`[scan-payload] payload is clean: ${path.resolve(root)}`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`[scan-payload] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	});
}
