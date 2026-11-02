import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { learnerObservationId } from "../src/core/learner.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-association-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore, learnerProfileStore } = await import("../src/server/stores.ts").then(({ stores }) => stores);
const {
	attachEvidenceTarget,
	detachEvidenceTarget,
	getLearnerObservation,
	learnerContextFor,
	listEvidenceAssociations,
	LearnerEvidenceUnavailableError,
	LearnerProfileConflictError,
	readLearnerEvidence,
} = await import("../src/server/learner.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function quizResult(id: string): LhMessage {
	return {
		id: `${id}-result`,
		role: "toolResult",
		toolCallId: `${id}-call`,
		toolName: "quiz",
		content: [],
		details: {
			kind: "quiz",
			questionText: "What is two plus two?",
			correct: true,
			dontKnow: false,
			gradingProvenance: "deterministic",
			answeredAt: "2026-02-01T00:00:00.000Z",
		},
		isError: false,
		timestamp: Date.parse("2026-02-01T00:00:00.000Z"),
	} as LhMessage;
}

function sourceEvidence() {
	const chat = chatStore.createChat("Evidence source");
	chatStore.saveMessages(chat.id, [quizResult(chat.id)]);
	const observation = getLearnerObservation(`ev:${encodeURIComponent(chat.id)}:${encodeURIComponent(`${chat.id}-result`)}:${encodeURIComponent(`${chat.id}-call`)}:`);
	assert.equal(observation.status, "available");
	if (observation.status !== "available") throw new Error("expected available evidence");
	return { chat, observation: observation.observation };
}

const target = {
	kind: "subject-skill" as const,
	mapId: "map-1",
	skillId: "skill-1",
	skillRevision: 1,
};

test("association attach validates source and target, is idempotent, and detaches with CAS", () => {
	const { observation } = sourceEvidence();
	const attached = attachEvidenceTarget({
		evidenceId: observation.id,
		target,
		expectedRevision: 0,
	});
	assert.equal(attached.revision, 1);
	assert.equal(attached.associations.length, 1);
	assert.deepEqual(attached.associations[0]?.target, target);

	const idempotent = attachEvidenceTarget({
		evidenceId: observation.id,
		target,
		expectedRevision: 1,
	});
	assert.equal(idempotent.revision, 1);
	assert.throws(
		() => attachEvidenceTarget({ evidenceId: observation.id, target, expectedRevision: 0 }),
		LearnerProfileConflictError,
	);

	assert.throws(
		() => attachEvidenceTarget({ evidenceId: observation.id, target: { ...target, skillRevision: -1 }, expectedRevision: 1 }),
		/skillRevision/,
	);
	assert.throws(
		() => attachEvidenceTarget({ evidenceId: "missing", target, expectedRevision: 1 }),
		LearnerEvidenceUnavailableError,
	);
	assert.throws(
		() => detachEvidenceTarget({ evidenceId: observation.id, target, expectedRevision: 0 }),
		LearnerProfileConflictError,
	);

	const detached = detachEvidenceTarget({ evidenceId: observation.id, target, expectedRevision: 1 });
	assert.equal(detached.revision, 2);
	assert.equal(detached.associations.length, 0);
	assert.throws(
		() => detachEvidenceTarget({ evidenceId: observation.id, target, expectedRevision: 1 }),
		LearnerProfileConflictError,
	);
	const idempotentDetach = detachEvidenceTarget({ evidenceId: observation.id, target, expectedRevision: 2 });
	assert.equal(idempotentDetach.revision, 2);
});

test("source deletion leaves the retained association unavailable", () => {
	const { chat, observation } = sourceEvidence();
	const profileRead = learnerProfileStore.read();
	assert.notEqual(profileRead.state, "corrupt");
	assert.notEqual(profileRead.state, "future");
	attachEvidenceTarget({
		evidenceId: observation.id,
		target,
		expectedRevision: profileRead.state === "ok" || profileRead.state === "absent" ? profileRead.profile.revision : 0,
	});
	assert.equal(chatStore.deleteChat(chat.id), true);
	const retained = listEvidenceAssociations();
	assert.equal(retained.length, 1);
	assert.equal(retained[0]?.status, "unavailable");
	assert.equal(getLearnerObservation(observation.id).status, "unavailable");
});

test("malformed chat derivation is unreadable per source without dropping other context", () => {
	const previousPage = readLearnerEvidence({ chatBudget: 100 });
	const { chat: validChat } = sourceEvidence();
	const malformedChat = chatStore.createChat("Malformed source");
	chatStore.saveMessages(malformedChat.id, [{
		id: "malformed-assistant",
		role: "assistant",
		content: null,
		timestamp: Date.now(),
	} as unknown as LhMessage]);

	const malformedEvidenceId = learnerObservationId({
		chatId: malformedChat.id,
		resultMessageId: "malformed-result",
		callId: "malformed-call",
	});
	assert.deepEqual(getLearnerObservation(malformedEvidenceId), { status: "unavailable" });

	const page = readLearnerEvidence({ chatBudget: 100 });
	assert.equal(page.coverage.unreadableChats, previousPage.coverage.unreadableChats + 1);
	assert.equal(page.availability, "partial");
	assert.ok(!page.sources.some((source) => source.chatId === malformedChat.id));

	const context = learnerContextFor("current-session");
	assert.match(context ?? "", /Evidence source · choice · correct · auto-graded/);
	assert.ok(validChat.id);
});
