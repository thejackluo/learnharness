import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { piModels } from "../src/agent/models.ts";
import { connectionBackgroundAllowed } from "../src/agent/subscription-connections.ts";
import { NATIVE_SUBSCRIPTIONS } from "../src/core/contracts/subscriptions.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-map-draft-consent-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_RUNTIME = "local";
const { stores } = await import("../src/server/stores.ts");
const { draftSubjectMap } = await import("../src/server/map-drafts.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;

test.before(() => {
	process.env.LH_DESKTOP_SERVER = "1";
	process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: () => { throw new Error("unexpected provider request"); } });
	connectionBackgroundAllowed(NATIVE_SUBSCRIPTIONS[0]!.logicalId);
});
test.after(() => {
	fs.rmSync(directory, { recursive: true, force: true });
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
});

let revision = 0;
for (const provider of NATIVE_SUBSCRIPTIONS) test(`${provider.providerId}: connected map drafter requires background consent`, async () => {
	const models = piModels().getModels(provider.providerId);
	assert.ok(models[0]);
	stores.settingsStore.writeSettings({ version: 1, agent: { models: { mapDrafter: { model: { provider: provider.logicalId, id: models[0].id } } } } });
	let calls = 0;
	const deps = { drafter: async () => {
		calls++;
		return { draft: { format: "learnharness.subject-map" as const, version: 1 as const, title: "Fixture", description: "", skills: [{ id: "skill", title: "Skill", objective: "Can explain", revision: 1 }], edges: [], goals: [], retired: [] }, usage: undefined };
	} };
	for (const consent of [false, true]) {
		(process.emit as (event: string, value: unknown) => boolean)("message", { channel: "lh:subscriptions", op: "changed", snapshot: {
			statuses: [{ providerId: provider.providerId, available: true, connected: true, pending: false, allowBackgroundUse: consent, connectionId: "fixture", epoch: 1, authorityRevision: 1, revision: ++revision }],
			models: { [provider.providerId]: models },
		} });
		assert.equal(providerKeyPresent(provider.logicalId), true);
		assert.equal(connectionBackgroundAllowed(provider.logicalId), consent);
		if (consent) assert.deepEqual((await draftSubjectMap({ goal: "Fixture" }, deps)).issues, []);
		else await assert.rejects(draftSubjectMap({ goal: "Fixture" }, deps), ModelsNotConfiguredError);
		assert.equal(calls, consent ? 1 : 0);
	}
});
