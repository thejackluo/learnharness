import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { beforeEach } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import type {
	LearnerProfileV1,
	WeaknessPattern,
	WeaknessPatternOccurrence,
	WeaknessPatternStatus,
} from "../src/core/contracts/learner.ts";
import { emptyLearnerProfile, learnerProfileProblems, projectLearnerContext } from "../src/core/learner.ts";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-patterns-"));
process.env.LH_DATA_DIR = DATA_DIR;

const [{ stores }, patternsService, patternsRoute, { createLearnerProfileStore }, { subjectMapGapView }] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/weakness-patterns.ts"),
	import("../app/api/learner/patterns/route.ts"),
	import("../src/store/learner.ts"),
	import("../src/server/subject-maps.ts"),
]);

test.after(() => {
	fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.join(DATA_DIR, "learner"), { recursive: true, force: true });
});

const timestamp = "2026-03-01T00:00:00.000Z";

const map = stores.subjectMapStore.create({
	title: "Programming",
	description: "Pattern target fixture",
	skills: [{ id: "loop-bounds", title: "Loop bounds", objective: "Choose correct loop bounds", revision: 1 }],
	edges: [],
	goals: ["loop-bounds"],
	retired: [],
});

const target = {
	kind: "subject-skill" as const,
	mapId: map.id,
	skillId: "loop-bounds",
	skillRevision: 1,
};

function userMessage(id: string, content: string): LhMessage {
	return { id, role: "user", content, timestamp: Date.parse(timestamp) } as LhMessage;
}

function chatWith(messages: LhMessage[]): string {
	const chat = stores.chatStore.createChat("Weakness pattern test");
	stores.chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

function learnerAnswerChat(partResponses: unknown[]): string {
	const chat = stores.chatStore.createChat("Submitted answer quote");
	stores.chatStore.saveMessages(chat.id, [
		{
			id: "assistant-question",
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "answer-call",
				name: "explain",
				arguments: { questionText: "Write a loop.", starter: "tutor starter phrase" },
			}],
			timestamp: Date.parse(timestamp),
		},
		{
			id: "learner-answer",
			role: "toolResult",
			toolCallId: "answer-call",
			toolName: "explain",
			content: [],
			details: {
				kind: "explain",
				questionText: "Write a loop.",
				dontKnow: false,
				answers: [],
				answeredAt: timestamp,
				partResponses,
			},
			isError: false,
			timestamp: Date.parse(timestamp) + 1,
		},
	] as unknown as LhMessage[]);
	return chat.id;
}

function successDetails(result: unknown): Record<string, unknown> {
	return (result as { details: Record<string, unknown> }).details;
}

function failureDetails(result: unknown): { isError?: boolean; details?: { problems?: string[] } } {
	return result as { isError?: boolean; details?: { problems?: string[] } };
}

function makeOccurrence(index: number, quote = `quote ${index}`): WeaknessPatternOccurrence {
	return {
		chatId: `chat-${index}`,
		messageId: `message-${index}`,
		quote,
		at: timestamp,
	};
}

function makePattern(
	id: string,
	count: number,
	updatedAt = timestamp,
	status: WeaknessPatternStatus = "active",
): WeaknessPattern {
	return {
		id,
		subject: "Subject",
		pattern: id,
		status,
		occurrences: Array.from({ length: count }, (_, index) => makeOccurrence(index, `${id}-quote-${index}`)),
		createdAt: timestamp,
		updatedAt,
	};
}

test("note_pattern tool records a verified learner quote and validates its input", async () => {
	const chatId = chatWith([userMessage("learner-1", "I use range(0,\n n + 1).")]);
	const { notePatternTool } = await import("../src/agent/tools/note-pattern.ts");
	const tool = notePatternTool((input) => patternsService.notePatternFromChat(chatId, input));
	const result = await tool.execute("call-1", {
		subject: "Python",
		pattern: "off-by-one in range() bounds",
		quote: "I use range(0, n + 1).",
		target,
	});
	assert.equal(successDetails(result).recorded, true);
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") {
		assert.equal(profile.profile.patterns?.[0]?.occurrences[0]?.quote, "I use range(0, n + 1).");
		assert.deepEqual(profile.profile.patterns?.[0]?.occurrences[0]?.target, target);
	}

	const invalid = await tool.execute("call-invalid", { subject: " ", pattern: " ", quote: "" });
	assert.equal(failureDetails(invalid).isError, true);
	assert.deepEqual(failureDetails(invalid).details?.problems, [
		"subject must be non-empty and at most 60 characters",
		"pattern must be non-empty and at most 80 characters",
		"quote must be non-empty and at most 300 characters",
	]);
	const tooLong = patternsService.notePatternFromChat(chatId, {
		subject: ` ${"s".repeat(60)}`,
		pattern: "off-by-one",
		quote: "I use range(0, n + 1).",
	});
	assert.equal(failureDetails(tooLong).isError, true);
});

test("note_pattern rejects quotes absent from learner-authored messages", () => {
	const notFoundChat = chatWith([userMessage("learner", "I am practicing loops.")]);
	const notFound = patternsService.notePatternFromChat(notFoundChat, {
		subject: "Python", pattern: "off-by-one", quote: "range(0, n + 1)",
	});
	assert.equal(failureDetails(notFound).isError, true);

	const assistantOnlyChat = chatWith([{
		id: "tutor",
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "starter-call",
			name: "explain",
			arguments: { starter: "I use range(0, n + 1)." },
		}],
		timestamp: Date.parse(timestamp),
	} as unknown as LhMessage]);
	const assistantOnly = patternsService.notePatternFromChat(assistantOnlyChat, {
		subject: "Python", pattern: "off-by-one", quote: "I use range(0, n + 1).",
	});
	assert.equal(failureDetails(assistantOnly).isError, true);
	assert.equal(stores.learnerProfileStore.read().state, "absent");
});

test("submitted assessment strings, including future code source, are valid quote sources", () => {
	const chatId = learnerAnswerChat([
		{ partId: "free", kind: "free", text: "I count one past the final index." },
		{ partId: "exact", kind: "exact", text: "I compare against len(items)." },
		{ partId: "structured", kind: "structured", fields: [{ id: "reason", text: "I mutate the list while iterating." }] },
		{ partId: "code", kind: "code", source: "for i in range(0, n + 1): pass" },
	]);
	for (const quote of [
		"I count one past the final index.",
		"I compare against len(items).",
		"I mutate the list while iterating.",
		"for i in range(0, n + 1): pass",
	]) {
		const result = patternsService.notePatternFromChat(chatId, {
			subject: "Python", pattern: "off-by-one in range() bounds", quote,
		});
		assert.equal(successDetails(result).recorded, true, quote);
	}
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") assert.equal(profile.profile.patterns?.[0]?.occurrences.length, 4);
});

test("patterns merge by casefolded subject and label and deduplicate message-plus-quote", () => {
	const first = userMessage("learner-1", "I use range(0, n + 1).");
	const second = userMessage("learner-2", "I use range(0, n + 1).");
	const chatId = chatWith([first]);
	const firstResult = patternsService.notePatternFromChat(chatId, {
		subject: "Python", pattern: "off-by-one in range() bounds", quote: "I use range(0, n + 1).",
	});
	assert.equal(successDetails(firstResult).recorded, true);

	stores.chatStore.saveMessages(chatId, [first, second]);
	const secondResult = patternsService.notePatternFromChat(chatId, {
		subject: " python ", pattern: "OFF-BY-ONE IN RANGE() BOUNDS ", quote: "I use range(0, n + 1).",
	});
	assert.equal(successDetails(secondResult).occurrenceCount, 2);
	const profileAfterSecond = stores.learnerProfileStore.read();
	assert.equal(profileAfterSecond.state, "ok");
	if (profileAfterSecond.state !== "ok") return;
	const revision = profileAfterSecond.profile.revision;
	const duplicate = patternsService.notePatternFromChat(chatId, {
		subject: "PYTHON", pattern: "off-by-one in range() bounds", quote: "I use range(0, n + 1).",
	});
	assert.equal(successDetails(duplicate).duplicate, true);
	const profileAfterDuplicate = stores.learnerProfileStore.read();
	assert.equal(profileAfterDuplicate.state, "ok");
	if (profileAfterDuplicate.state === "ok") {
		assert.equal(profileAfterDuplicate.profile.revision, revision);
		assert.equal(profileAfterDuplicate.profile.patterns?.length, 1);
		assert.equal(profileAfterDuplicate.profile.patterns?.[0]?.occurrences.length, 2);
	}
});

test("patterns retain only their newest twenty occurrences", () => {
	const chatId = stores.chatStore.createChat("Occurrence cap").id;
	const messages: LhMessage[] = [];
	for (let index = 0; index < 21; index++) {
		const message = userMessage(`learner-${index}`, `Occurrence ${index}: I include the end of range.`);
		messages.push(message);
		stores.chatStore.saveMessages(chatId, messages);
		const result = patternsService.notePatternFromChat(chatId, {
			subject: "Python", pattern: "inclusive range end", quote: `Occurrence ${index}`,
		});
		assert.equal(successDetails(result).recorded, true);
	}
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state === "ok") {
		const occurrences = profile.profile.patterns?.[0]?.occurrences ?? [];
		assert.equal(occurrences.length, 20);
		assert.equal(occurrences[0]?.messageId, "learner-1");
		assert.equal(occurrences[19]?.messageId, "learner-20");
	}
});

test("resolved patterns reactivate, while dismissed patterns record nothing", () => {
	const first = userMessage("learner-1", "I add one to the upper bound.");
	const second = userMessage("learner-2", "I do the same thing with this range.");
	const third = userMessage("learner-3", "I add one again for this loop.");
	const chatId = chatWith([first]);
	patternsService.notePatternFromChat(chatId, { subject: "Python", pattern: "inclusive range end", quote: "I add one to the upper bound." });
	const initial = stores.learnerProfileStore.read();
	assert.equal(initial.state, "ok");
	if (initial.state !== "ok") return;
	const patternId = initial.profile.patterns![0]!.id;
	patternsService.setWeaknessPatternStatus(patternId, "resolved", initial.profile.revision);
	stores.chatStore.saveMessages(chatId, [first, second]);
	const reactivated = patternsService.notePatternFromChat(chatId, { subject: "Python", pattern: "inclusive range end", quote: "I do the same thing with this range." });
	assert.equal(successDetails(reactivated).status, "active");
	const reactivatedProfile = stores.learnerProfileStore.read();
	assert.equal(reactivatedProfile.state, "ok");
	if (reactivatedProfile.state !== "ok") return;
	const dismissedProfile = patternsService.setWeaknessPatternStatus(patternId, "dismissed", reactivatedProfile.profile.revision);
	const revision = dismissedProfile.revision;
	stores.chatStore.saveMessages(chatId, [first, second, third]);
	const dismissed = patternsService.notePatternFromChat(chatId, { subject: "Python", pattern: "inclusive range end", quote: "I add one again for this loop." });
	assert.equal(successDetails(dismissed).dismissed, true);
	assert.match((dismissed as { content: { text: string }[] }).content[0]!.text, /dismissed by the owner/);
	const afterDismissed = stores.learnerProfileStore.read();
	assert.equal(afterDismissed.state, "ok");
	if (afterDismissed.state === "ok") {
		assert.equal(afterDismissed.profile.revision, revision);
		assert.equal(afterDismissed.profile.patterns?.[0]?.status, "dismissed");
		assert.equal(afterDismissed.profile.patterns?.[0]?.occurrences.length, 2);
	}
});

test("unknown target maps and skills fail without recording an occurrence", () => {
	const chatId = chatWith([userMessage("learner-1", "I use range(0, n + 1).")]);
	const absentMap = patternsService.notePatternFromChat(chatId, {
		subject: "Python",
		pattern: "off-by-one",
		quote: "I use range(0, n + 1).",
		target: { ...target, mapId: "map_00000000-0000-4000-8000-000000000000" },
	});
	assert.equal(failureDetails(absentMap).isError, true);
	const absentSkill = patternsService.notePatternFromChat(chatId, {
		subject: "Python",
		pattern: "off-by-one",
		quote: "I use range(0, n + 1).",
		target: { ...target, skillId: "missing" },
	});
	assert.equal(failureDetails(absentSkill).isError, true);
	assert.equal(stores.learnerProfileStore.read().state, "absent");
});

test("noting a targeted pattern leaves the map evidence projection and familiarity suggestions unchanged", async () => {
	const initial = stores.learnerProfileStore.read();
	assert.ok(initial.state === "absent" || initial.state === "ok");
	const seeded = stores.learnerProfileStore.replace({
		background: initial.profile.background,
		coursework: initial.profile.coursework,
		topics: initial.profile.topics,
		excerpts: initial.profile.excerpts,
		associations: initial.profile.associations,
		patterns: [],
		suggestions: [{
			id: "suggestion-1",
			mapId: map.id,
			skillId: "loop-bounds",
			skillRevision: 1,
			status: "pending",
			createdAt: timestamp,
			reason: { kind: "import", sourceName: "notes.md", quote: "I know loop bounds." },
		}],
	}, initial.profile.revision);
	const beforeProjection = subjectMapGapView(map);
	const beforeSuggestions = seeded.suggestions;
	const chatId = chatWith([userMessage("learner-1", "I use range(0, n + 1).")]);
	const result = patternsService.notePatternFromChat(chatId, {
		subject: "Python",
		pattern: "off-by-one in range() bounds",
		quote: "I use range(0, n + 1).",
		target,
	});
	assert.equal(successDetails(result).recorded, true);
	const { learnerContextFor } = await import("../src/server/learner.ts");
	assert.match(learnerContextFor(chatId) ?? "", /target: Programming — Loop bounds/);
	const afterProjection = subjectMapGapView(map);
	assert.deepEqual(afterProjection, beforeProjection);
	const afterProfile = stores.learnerProfileStore.read();
	assert.equal(afterProfile.state, "ok");
	if (afterProfile.state === "ok") {
		assert.deepEqual(afterProfile.profile.suggestions, beforeSuggestions);
		assert.deepEqual(afterProfile.profile.patterns?.[0]?.occurrences[0]?.target, target);
	}
});

test("learner context orders active patterns, includes target title and newest quote, limits ten, and omits empty section", () => {
	const patterns = [
		makePattern("p0", 2, "2026-03-11T00:00:00.000Z"),
		makePattern("p1", 3, "2026-03-10T00:00:00.000Z"),
		{
			...makePattern("p2", 3, "2026-03-12T00:00:00.000Z"),
			occurrences: [
				makeOccurrence(0),
				makeOccurrence(1),
				{ ...makeOccurrence(2), quote: "newest targeted quote", target },
			],
		},
		...Array.from({ length: 9 }, (_, index) =>
			makePattern(`p${index + 3}`, 1, `2026-03-${String(index + 3).padStart(2, "0")}T00:00:00.000Z`)),
	];
	const profile: LearnerProfileV1 = { ...emptyLearnerProfile(timestamp), patterns };
	const context = projectLearnerContext(profile, [], {
		targetTitle: (ref) => ref.mapId === map.id && ref.skillId === target.skillId
			? `${map.title} — ${map.skills[0]!.title}`
			: undefined,
	});
	assert.ok(context);
	assert.ok(context.includes("newest targeted quote"));
	assert.ok(context.includes("target: Programming — Loop bounds"));
	assert.ok(context.indexOf("p2 (×3)") < context.indexOf("p1 (×3)"));
	assert.ok(context.indexOf("p1 (×3)") < context.indexOf("p0 (×2)"));
	assert.equal((context.match(/- Subject — p\d+/g) ?? []).length, 10);
	assert.ok(!context.includes("p3 (×1)"));
	assert.ok(!context.includes("p4 (×1)"));
	assert.equal(projectLearnerContext({ ...emptyLearnerProfile(timestamp), patterns: [] }, []), null);
	assert.equal(projectLearnerContext({ ...emptyLearnerProfile(timestamp), patterns: [makePattern("resolved", 2, timestamp, "resolved")] }, []), null);
});

test("learner profile validation enforces weakness-pattern and target bounds", () => {
	const base = emptyLearnerProfile(timestamp);
	const valid = makePattern("valid", 1);
	assert.deepEqual(learnerProfileProblems({ ...base, patterns: [valid] }), []);
	assert.ok(learnerProfileProblems({
		...base,
		patterns: Array.from({ length: 201 }, (_, index) => makePattern(`many-${index}`, 1)),
	}).some((issue) => issue.includes("at most 200")));
	assert.ok(learnerProfileProblems({
		...base,
		patterns: [{ ...valid, subject: "s".repeat(61) }],
	}).some((issue) => issue.includes("subject")));
	assert.ok(learnerProfileProblems({
		...base,
		patterns: [{ ...valid, pattern: "p".repeat(81) }],
	}).some((issue) => issue.includes("label")));
	assert.ok(learnerProfileProblems({
		...base,
		patterns: [{ ...valid, occurrences: Array.from({ length: 21 }, (_, index) => makeOccurrence(index)) }],
	}).some((issue) => issue.includes("at most 20")));
	assert.ok(learnerProfileProblems({
		...base,
		patterns: [{ ...valid, occurrences: [{ ...makeOccurrence(0), quote: "q".repeat(301) }] }],
	}).some((issue) => issue.includes("quote")));
	assert.ok(learnerProfileProblems({
		...base,
		patterns: [{ ...valid, occurrences: [{ ...makeOccurrence(0), target: { kind: "bad" } as never }] }],
	}).some((issue) => issue.includes("subject-skill")));
});

test("legacy learner profiles without patterns load unchanged", () => {
	const directory = path.join(DATA_DIR, "legacy-profile");
	fs.mkdirSync(directory, { recursive: true });
	const legacy = {
		version: 1,
		revision: 4,
		updatedAt: timestamp,
		background: "Legacy learner",
		coursework: "",
		topics: [],
		excerpts: [],
		associations: [],
	};
	fs.writeFileSync(path.join(directory, "profile.json"), JSON.stringify(legacy));
	const read = createLearnerProfileStore(directory).read();
	assert.equal(read.state, "ok");
	if (read.state === "ok") {
		assert.deepEqual(read.profile, legacy);
		assert.equal(read.profile.patterns, undefined);
	}
});

test("pattern API lists patterns, changes status, and rejects stale or unknown updates", async () => {
	const chatId = chatWith([userMessage("learner-1", "I use range(0, n + 1).")]);
	patternsService.notePatternFromChat(chatId, {
		subject: "Python",
		pattern: "off-by-one",
		quote: "I use range(0, n + 1).",
		target,
	});
	const list = await patternsRoute.GET();
	assert.equal(list.status, 200);
	const listed = await list.json() as { patterns: { id: string; occurrences: { targetTitle?: string }[] }[] };
	assert.equal(listed.patterns.length, 1);
	assert.equal(listed.patterns[0]?.occurrences[0]?.targetTitle, "Programming — Loop bounds");
	const profile = stores.learnerProfileStore.read();
	assert.equal(profile.state, "ok");
	if (profile.state !== "ok") return;
	const id = profile.profile.patterns![0]!.id;
	const update = (body: unknown) => patternsRoute.POST(new Request("http://localhost/api/learner/patterns", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
	const dismissed = await update({ id, status: "dismissed", expectedRevision: profile.profile.revision });
	assert.equal(dismissed.status, 200);
	const dismissedBody = await dismissed.json() as { profile: LearnerProfileV1; patterns: { occurrences: { targetTitle?: string }[] }[] };
	assert.equal(dismissedBody.profile.patterns?.[0]?.status, "dismissed");
	assert.equal(dismissedBody.patterns[0]?.occurrences[0]?.targetTitle, "Programming — Loop bounds");
	const stale = await update({ id, status: "active", expectedRevision: profile.profile.revision });
	assert.equal(stale.status, 409);
	const reactivated = await update({ id, status: "active", expectedRevision: dismissedBody.profile.revision });
	assert.equal(reactivated.status, 200);
	const reactivatedBody = await reactivated.json() as { profile: LearnerProfileV1 };
	assert.equal(reactivatedBody.profile.patterns?.[0]?.status, "active");
	const resolved = await update({ id, status: "resolved", expectedRevision: reactivatedBody.profile.revision });
	assert.equal(resolved.status, 200);
	const resolvedBody = await resolved.json() as { profile: LearnerProfileV1 };
	assert.equal(resolvedBody.profile.patterns?.[0]?.status, "resolved");
	const unknown = await update({ id: "missing", status: "resolved", expectedRevision: resolvedBody.profile.revision });
	assert.equal(unknown.status, 404);
	const invalid = await update({ id, status: "pending", expectedRevision: resolvedBody.profile.revision });
	assert.equal(invalid.status, 400);
});
