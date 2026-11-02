import * as fs from "node:fs";
import * as path from "node:path";
import type { OwnerSession, OwnerStore, OwnerVerifier } from "../core/ports.ts";

const OWNER_FILE = "owner.json";
const SESSIONS_FILE = "sessions.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidOwnerVerifier(value: unknown): value is OwnerVerifier {
	if (!isRecord(value) || value.version !== 1 || typeof value.revision !== "string" || !value.revision) return false;
	if (!isRecord(value.scrypt) || value.scrypt.N !== 2 ** 15 || value.scrypt.r !== 8 || value.scrypt.p !== 1 || value.scrypt.keyLen !== 32) return false;
	if (typeof value.salt !== "string" || typeof value.hash !== "string") return false;
	return Buffer.from(value.salt, "base64").length === 16 && Buffer.from(value.hash, "base64").length === 32;
}

function isOwnerSession(value: unknown): value is OwnerSession {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" &&
		typeof value.tokenHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.tokenHash) &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		typeof value.lastSeenAt === "number" &&
		Number.isFinite(value.lastSeenAt) &&
		typeof value.verifierRevision === "string";
}

function writeAtomic(file: string, value: unknown): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function createOwnerStore(directory: string): OwnerStore {
	const ownerFile = path.join(directory, OWNER_FILE);
	const sessionsFile = path.join(directory, SESSIONS_FILE);

	return {
		readOwner() {
			try {
				const raw: unknown = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
				if (isValidOwnerVerifier(raw)) return raw;
				console.error("[owner] owner verifier is invalid; hosted startup must refuse");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					console.error("[owner] owner verifier could not be read; hosted startup must refuse");
				}
			}
			return null;
		},
		writeOwner(verifier) {
			if (!isValidOwnerVerifier(verifier)) throw new Error("Invalid owner verifier.");
			writeAtomic(ownerFile, verifier);
		},
		readSessions() {
			try {
				const raw: unknown = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
				if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.sessions)) {
					console.error("[owner] sessions record is invalid; treating sessions as revoked");
					return [];
				}
				return raw.sessions.filter(isOwnerSession);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					console.error("[owner] sessions record could not be read; treating sessions as revoked");
				}
				return [];
			}
		},
		writeSessions(sessions) {
			let raw: unknown;
			try {
				raw = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") raw = null;
			}
			if (isRecord(raw) && typeof raw.version === "number" && raw.version > 1) {
				throw new Error("Refusing to overwrite a future sessions record version.");
			}
			if (!sessions.every(isOwnerSession)) throw new Error("Invalid owner session record.");
			writeAtomic(sessionsFile, { version: 1, sessions });
		},
	};
}

export const ownerStore: OwnerStore = {
	readOwner: () => createOwnerStore(process.env.LH_OWNER_DIR ?? path.join(process.cwd(), "owner")).readOwner(),
	writeOwner: (verifier) => createOwnerStore(process.env.LH_OWNER_DIR ?? path.join(process.cwd(), "owner")).writeOwner(verifier),
	readSessions: () => createOwnerStore(process.env.LH_OWNER_DIR ?? path.join(process.cwd(), "owner")).readSessions(),
	writeSessions: (sessions) => createOwnerStore(process.env.LH_OWNER_DIR ?? path.join(process.cwd(), "owner")).writeSessions(sessions),
};
