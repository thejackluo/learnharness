import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PLACEMENT_NUDGE_TEXT } from "../src/core/contracts/chat.ts";
import { newPlacementNudgeMessage, nativeInputCause, toLlmMessages } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { generatePlacementGoldenArtifact } from "../scripts/generate-placement-golden-fixture.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placement-nudge-test-"));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("placement-next is automatic model context and has no chat projection", () => {
	const marker = newPlacementNudgeMessage("chat_synthetic", 2);
	assert.deepEqual(marker, {
		id: "steer_placement_chat_synthetic_2",
		role: "custom",
		customType: "placement-next",
		content: PLACEMENT_NUDGE_TEXT,
		display: false,
		details: { chatId: "chat_synthetic", probeIndex: 2 },
		timestamp: marker.timestamp,
	});
	assert.equal(typeof marker.timestamp, "number");
	assert.equal(nativeInputCause(marker as never, []), "automatic");

	const wire = toLlmMessages([marker] as never);
	assert.equal(wire.length, 1);
	assert.equal(wire[0]?.role, "user");
	assert.ok(JSON.stringify(wire[0]).includes(PLACEMENT_NUDGE_TEXT));
	assert.deepEqual(projectView([marker]), []);
});

test("the production handler and pump nudge an ended placement turn into the next probe", async () => {
	const artifact = await generatePlacementGoldenArtifact(dataDir);
	const chat = JSON.parse(fs.readFileSync(artifact.chatPath, "utf8")) as {
		placement: { probes: Array<{ skillId: string; result?: string }> };
		messages: Array<{
			id: string;
			role: string;
			content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: { onTarget?: boolean } }>;
			customType?: string;
			details?: { chatId?: string; probeIndex?: number };
		}>;
	};
	const nudgeIndex = chat.messages.findIndex((message) => message.customType === "placement-next");
	const nextQuizIndex = chat.messages.findIndex((message) =>
		message.role === "assistant" &&
		message.content?.some((part) => part.type === "toolCall" && part.id === "placement-quiz-2" && part.arguments?.onTarget === true),
	);
	assert.ok(nudgeIndex >= 0);
	assert.ok(nextQuizIndex > nudgeIndex);
	assert.deepEqual(chat.messages[nudgeIndex]?.details, { chatId: artifact.chatId, probeIndex: 1 });
	assert.deepEqual(chat.placement.probes.map((probe) => probe.result), ["supports", undefined]);
	assert.ok(
		chat.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content?.some((part) => part.type === "text" && part.text === "Correct.") &&
				!message.content.some((part) => part.type === "toolCall"),
		),
		"the graded probe turn ended without asking a question",
	);
	assert.ok(fs.existsSync(artifact.mapPath), "the fixture's synthetic map was written through the map store");
});
