import {
	createHash,
	randomBytes,
	randomUUID,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import type { OwnerSession, OwnerStore, OwnerVerifier } from "../core/ports.ts";
import { ownerStore } from "../store/owner.ts";

export const OWNER_SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLen: 32 });
export const OWNER_SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
export const OWNER_SESSION_COOKIE = "__Host-lh_session";

function deriveKey(
	passphrase: string,
	salt: Buffer,
	keyLen: number,
	options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(passphrase, salt, keyLen, options, (error, key) => {
			if (error) reject(error);
			else resolve(key as Buffer);
		});
	});
}

export async function makeOwnerVerifier(passphrase: string, revision: string = randomUUID()): Promise<OwnerVerifier> {
	const salt = randomBytes(16);
	const derived = await deriveKey(passphrase, salt, OWNER_SCRYPT.keyLen, {
		N: OWNER_SCRYPT.N,
		r: OWNER_SCRYPT.r,
		p: OWNER_SCRYPT.p,
		maxmem: OWNER_SCRYPT_MAXMEM,
	});
	return {
		version: 1,
		revision,
		scrypt: { ...OWNER_SCRYPT },
		salt: salt.toString("base64"),
		hash: derived.toString("base64"),
	};
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export interface AuthenticatedOwnerSession extends OwnerSession {}

export interface OwnerAuth {
	verifyPassphrase(passphrase: string): Promise<boolean>;
	createSession(): { id: string; token: string };
	validateSession(token: string | undefined, options?: { touch?: boolean }): AuthenticatedOwnerSession | null;
	revokeSession(id: string): void;
}

export function createOwnerAuth(options: { store?: OwnerStore; now?: () => number } = {}): OwnerAuth {
	const store = options.store ?? ownerStore;
	const now = options.now ?? Date.now;

	function prune(sessions: OwnerSession[], verifier: OwnerVerifier, time: number): OwnerSession[] {
		return sessions.filter((session) =>
			session.verifierRevision === verifier.revision &&
			time - session.lastSeenAt < SESSION_IDLE_MS &&
			time - session.createdAt < SESSION_ABSOLUTE_MS,
		);
	}

	return {
		async verifyPassphrase(passphrase) {
			const verifier = store.readOwner();
			if (!verifier || typeof passphrase !== "string") return false;
			const actual = await deriveKey(passphrase, Buffer.from(verifier.salt, "base64"), verifier.scrypt.keyLen, {
				N: verifier.scrypt.N,
				r: verifier.scrypt.r,
				p: verifier.scrypt.p,
				maxmem: OWNER_SCRYPT_MAXMEM,
			});
			const expected = Buffer.from(verifier.hash, "base64");
			return actual.length === expected.length && timingSafeEqual(actual, expected);
		},
		createSession() {
			const verifier = store.readOwner();
			if (!verifier) throw new Error("Owner verifier is unavailable.");
			const time = now();
			const sessions = prune(store.readSessions(), verifier, time);
			const token = randomBytes(32).toString("base64url");
			const session: OwnerSession = {
				id: randomUUID(),
				tokenHash: tokenHash(token),
				createdAt: time,
				lastSeenAt: time,
				verifierRevision: verifier.revision,
			};
			store.writeSessions([...sessions, session]);
			return { id: session.id, token };
		},
		validateSession(token, { touch = false } = {}) {
			if (!token) return null;
			const verifier = store.readOwner();
			if (!verifier) return null;
			const time = now();
			const sessions = store.readSessions();
			const current = prune(sessions, verifier, time);
			const hash = tokenHash(token);
			const found = current.find((session) => session.tokenHash === hash);
			if (current.length !== sessions.length || (touch && found && time - found.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS)) {
				const next = current.map((session) =>
					session.id === found?.id && touch && time - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS
						? { ...session, lastSeenAt: time }
						: session,
				);
				store.writeSessions(next);
				if (found && touch && time - found.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
					return { ...found, lastSeenAt: time };
				}
			}
			return found ?? null;
		},
		revokeSession(id) {
			const sessions = store.readSessions();
			const next = sessions.filter((session) => session.id !== id);
			if (next.length !== sessions.length) store.writeSessions(next);
		},
	};
}

const ownerAuth = createOwnerAuth();
export const verifyOwnerPassphrase = ownerAuth.verifyPassphrase;
export const createOwnerSession = ownerAuth.createSession;
export const validateOwnerSession = ownerAuth.validateSession;
export const revokeOwnerSession = ownerAuth.revokeSession;

export function ownerSessionIsActive(id: string, now = Date.now()): boolean {
	const verifier = ownerStore.readOwner();
	if (!verifier) return false;
	const session = ownerStore.readSessions().find((item) => item.id === id);
	return !!session &&
		session.verifierRevision === verifier.revision &&
		now - session.lastSeenAt < SESSION_IDLE_MS &&
		now - session.createdAt < SESSION_ABSOLUTE_MS;
}
