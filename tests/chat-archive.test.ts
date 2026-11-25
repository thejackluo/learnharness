import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-archive-"));
process.env.LH_DATA_DIR = DATA_DIR;
process.env.LH_RUNTIME = "local";
process.env.LH_IGNORE_ENV_KEYS = "1";

const [{ chatStore }, { subscribe }, { PUT: putChat }] = await Promise.all([
	import("../src/store/chats.ts"),
	import("../src/core/events.ts"),
	import("../app/api/chats/[id]/route.ts"),
]);

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("chat archive stamps, preserves, and removes archivedAt without changing activity order", () => {
	const chat = chatStore.createChat("Archive fixture");
	const updatedAt = chat.updatedAt;
	const announcedStates: Array<string | undefined> = [];
	const off = subscribe((event) => {
		if (event.type === "chats-changed") announcedStates.push(chatStore.getChat(chat.id)?.archivedAt);
	});

	try {
		const archived = chatStore.setArchived(chat.id, true);
		assert.equal(typeof archived.archivedAt, "string");
		assert.equal(new Date(archived.archivedAt!).toISOString(), archived.archivedAt);
		assert.equal(archived.updatedAt, updatedAt);
		const stamp = archived.archivedAt;
		assert.equal(chatStore.listChats().find((summary) => summary.id === chat.id)?.archivedAt, stamp);

		const stillArchived = chatStore.setArchived(chat.id, true);
		assert.equal(stillArchived.archivedAt, stamp, "re-archiving keeps the original stamp");
		assert.equal(stillArchived.updatedAt, updatedAt);

		const unarchived = chatStore.setArchived(chat.id, false);
		assert.equal("archivedAt" in unarchived, false);
		assert.equal(unarchived.updatedAt, updatedAt);
		assert.equal(chatStore.listChats().find((summary) => summary.id === chat.id)?.archivedAt, undefined);
		assert.throws(() => chatStore.setArchived("chat_missing", true), /Chat not found/);
		assert.deepEqual(announcedStates, [stamp, stamp, undefined], "each write announces after its record is durable");
	} finally {
		off();
	}
});

test("chat PUT archives, unarchives, rejects bad bodies and keeps rename behavior", async () => {
	const chat = chatStore.createChat("Original title");
	const originalUpdatedAt = chatStore.getChat(chat.id)!.updatedAt;
	const put = (id: string, body: unknown) =>
		putChat(new Request(`http://localhost/api/chats/${id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}), { params: Promise.resolve({ id }) });

	const renamed = await put(chat.id, { title: "  Renamed title  " });
	assert.equal(renamed.status, 200);
	assert.deepEqual(await renamed.json(), { title: "Renamed title" });
	assert.equal(chatStore.getChat(chat.id)!.updatedAt, originalUpdatedAt);

	const archived = await put(chat.id, { archived: true });
	assert.equal(archived.status, 200);
	const archivedBody = await archived.json() as { archivedAt: string | null };
	assert.equal(typeof archivedBody.archivedAt, "string");
	assert.equal(chatStore.getChat(chat.id)!.archivedAt, archivedBody.archivedAt);

	const unarchived = await put(chat.id, { archived: false });
	assert.equal(unarchived.status, 200);
	assert.deepEqual(await unarchived.json(), { archivedAt: null });
	assert.equal("archivedAt" in chatStore.getChat(chat.id)!, false);

	assert.equal((await put("chat_missing", { archived: true })).status, 404);
	assert.equal((await put(chat.id, {})).status, 400);
});
