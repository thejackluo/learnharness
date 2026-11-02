import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";

const LOCK_NAME = ".lh-writer.sock";
const LOCK_STATE = Symbol.for("lh.writerLock");
type LockState = { held: boolean };

function lockState(): LockState {
	const global = globalThis as typeof globalThis & { [LOCK_STATE]?: LockState };
	return (global[LOCK_STATE] ??= { held: false });
}

function connectIsLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
			else reject(error);
		});
	});
}

function linkOrThrow(tempPath: string, lockPath: string): void {
	try {
		fs.linkSync(tempPath, lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Another LearnHarness process holds this data directory.");
		}
		throw error;
	}
}

async function removeStaleLock(lockPath: string): Promise<void> {
	if (await connectIsLive(lockPath)) {
		throw new Error("Another LearnHarness process holds this data directory.");
	}
	const stalePath = `${lockPath}.stale-${randomUUID()}`;
	try {
		fs.renameSync(lockPath, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (await connectIsLive(stalePath)) {
		if (!fs.existsSync(lockPath)) fs.renameSync(stalePath, lockPath);
		else fs.unlinkSync(stalePath);
		throw new Error("Another LearnHarness process holds this data directory.");
	}
	fs.unlinkSync(stalePath);
}

export interface WriterLock {
	release(): Promise<void>;
	releaseSync(): void;
}

function unlinkOwnedLock(lockPath: string, identity: fs.Stats): void {
	try {
		const current = fs.lstatSync(lockPath);
		if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function isWriterLockHeld(): boolean {
	return lockState().held;
}

export async function acquireWriterLock(directory = PATHS.data): Promise<WriterLock> {
	if (process.platform === "win32") throw new Error("Hosted writer locking requires Unix domain sockets.");
	if (lockState().held) throw new Error("This LearnHarness process already holds the writer lock.");

	const lockPath = path.join(directory, LOCK_NAME);
	const tempPath = path.join(directory, `.lh-writer-${process.pid}-${randomUUID()}.sock`);
	const server = net.createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(tempPath, resolve);
	});

	try {
		try {
			linkOrThrow(tempPath, lockPath);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("Another LearnHarness")) throw error;
			await removeStaleLock(lockPath);
			linkOrThrow(tempPath, lockPath);
		}
		const lockIdentity = fs.lstatSync(lockPath);
		fs.unlinkSync(tempPath);
		server.unref();
		lockState().held = true;
		let released = false;
		return {
			releaseSync() {
				if (released) return;
				released = true;
				lockState().held = false;
				server.close();
				unlinkOwnedLock(lockPath, lockIdentity);
				fs.rmSync(tempPath, { force: true });
			},
			release() {
				if (released) return Promise.resolve();
				released = true;
				lockState().held = false;
				return new Promise<void>((resolve, reject) => {
					server.close((error) => {
						try {
							unlinkOwnedLock(lockPath, lockIdentity);
							fs.rmSync(tempPath, { force: true });
						} catch (unlinkError) {
							reject(unlinkError);
							return;
						}
						if (error) reject(error);
						else resolve();
					});
				});
			},
		};
	} catch (error) {
		server.close(() => {
			fs.rmSync(tempPath, { force: true });
		});
		throw error;
	}
}
