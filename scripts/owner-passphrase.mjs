#!/usr/bin/env node
import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 };
const MAXMEM = 64 * 1024 * 1024;

function readPassphrase() {
	if (!process.stdin.isTTY) {
		return new Promise((resolve, reject) => {
			let input = "";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (chunk) => { input += chunk; });
			process.stdin.on("end", () => resolve(input.replace(/[\r\n]+$/, "")));
			process.stdin.on("error", reject);
		});
	}
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		let input = "";
		const done = (error) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onData);
			process.stdout.write("\n");
			if (error) reject(error);
			else resolve(input);
		};
		const onData = (chunk) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\u0003") return done(new Error("Passphrase input cancelled."));
				if (char === "\r" || char === "\n") return done();
				if (char === "\u007f" || char === "\b") input = input.slice(0, -1);
				else input += char;
			}
		};
		stdin.on("data", onData);
	});
}

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const directory = dirArg >= 0 ? args[dirArg + 1] : process.env.LH_OWNER_DIR;
if (!directory || !path.isAbsolute(directory)) {
	console.error("Usage: node scripts/owner-passphrase.mjs --dir /absolute/owner-dir");
	process.exit(2);
}

try {
	process.stderr.write("Owner passphrase (minimum 12 characters): ");
	const passphrase = await readPassphrase();
	if (passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters.");
	const salt = randomBytes(16);
	const hash = await scrypt(passphrase, salt, SCRYPT.keyLen, { ...SCRYPT, maxmem: MAXMEM });
	const verifier = {
		version: 1,
		revision: randomUUID(),
		scrypt: SCRYPT,
		salt: salt.toString("base64"),
		hash: hash.toString("base64"),
	};
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	for (const [name, value] of [["owner.json", verifier], ["sessions.json", { version: 1, sessions: [] }]]) {
		const target = path.join(directory, name);
		const temporary = path.join(directory, `.${name}.tmp-${process.pid}-${randomUUID()}`);
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, target);
	}
	console.log("Owner verifier written; existing sessions revoked.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
