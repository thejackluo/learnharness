import assert from "node:assert/strict";
import test from "node:test";
import {
	practiceSpeech,
	questionSpeech,
	replyReadable,
	replySpeech,
	speechChunks,
	speechTextOfMarkdown,
} from "../src/core/speech.ts";
import { questionDataOf } from "../src/core/canonical-question.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as unknown as LhMessage;
}

function assistant(id: string, content: unknown[], stopReason = "stop"): LhMessage {
	return { id, role: "assistant", content, stopReason, timestamp: 2 } as unknown as LhMessage;
}

function toolResult(id: string, toolName: string, toolCallId = `${id}-call`, isError = false): LhMessage {
	return { id, role: "toolResult", toolCallId, toolName, content: [], details: null, isError, timestamp: 3 } as unknown as LhMessage;
}

test("Markdown speech keeps prose and explicit omission cues, not markup or hidden script text", () => {
	const text = speechTextOfMarkdown([
		"# A title",
		"",
		"> Quoted **prose** with [a link](https://example.test) and ![diagram](image.png).",
		"",
		"`inline code` and $x + 1$ and \\(y\\).",
		"",
		"$$",
		"x^2",
		"$$",
		"",
		"| Name | Value |",
		"| --- | --- |",
		"| A | 1 |",
		"",
		"```mermaid",
		"graph TD",
		"```",
		"",
		"    const hidden = true;",
		"",
		"<script>doNotSpeak()</script><em>Visible HTML prose</em>",
	].join("\n"));
	assert.match(text, /^A title\nQuoted prose with a link and \(image: diagram\)\./);
	assert.match(text, /\(code\).*?\(math\).*?\(math\)/);
	assert.match(text, /\(table omitted\)/);
	assert.match(text, /\(diagram omitted\)/);
	assert.match(text, /\(code block omitted\)/);
	assert.match(text, /Visible HTML prose$/);
	assert.doesNotMatch(text, /doNotSpeak|graph TD|const hidden|<em>|https:/);
});

test("speech chunks break sentences and newlines, cap long runs, and never emit blanks", () => {
	const long = "word ".repeat(80).trim();
	const chunks = speechChunks(`First sentence. Second sentence!\nThird?\n${long}`, 40);
	assert.deepEqual(chunks.slice(0, 3), ["First sentence.", "Second sentence!", "Third?"]);
	assert.ok(chunks.length > 3);
	assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 40));
	assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), `First sentence. Second sentence! Third? ${long}`);
	assert.ok(speechChunks("x".repeat(85), 40).every((chunk) => chunk.length <= 40));
	assert.deepEqual(speechChunks(" \n\t "), []);
});

test("reply projection is latest-turn assistant text only and rejects temporary or failed replies", () => {
	const messages = [
		user("u-old", "Old question"),
		assistant("a-old", [{ type: "text", text: "Old answer" }]),
		user("u-latest", "Current question"),
		assistant("a-reply", [
			{ type: "thinking", thinking: "PRIVATE REASONING" },
			{ type: "toolCall", id: "call-1", name: "private_tool", arguments: { secret: "PRIVATE TOOL" } },
			{ type: "text", text: "The settled answer." },
		]),
		{ id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "private_tool", content: [{ type: "text", text: "PRIVATE RESULT" }], details: null, isError: false, timestamp: 3 } as unknown as LhMessage,
	];
	assert.deepEqual(replySpeech(messages), { key: "reply:a-reply", text: "The settled answer." });
	assert.equal(replySpeech([user("u", "question"), assistant("c_temporary", [{ type: "text", text: "Still streaming" }])]), null);
	assert.equal(replySpeech([user("u", "question"), assistant("a-error", [{ type: "text", text: "Partial" }], "error")]), null);
	assert.equal(replySpeech([user("u", "question"), assistant("a-aborted", [{ type: "text", text: "Partial" }], "aborted")]), null);
	assert.equal(replySpeech([user("u", "question"), assistant("a-empty", [{ type: "thinking", thinking: "PRIVATE" }])]), null);
	assert.equal(replySpeech([user("u", "question"), assistant("c_tool", [{ type: "text", text: "Answer" }]), { id: "result", role: "toolResult" } as unknown as LhMessage]), null);
});

test("reply starts after the latest learner answer, including tool and practice thinking messages", () => {
	const messages = [
		user("u-1", "First question"),
		assistant("a-1", [{ type: "text", text: "First reply." }]),
		toolResult("answer-1", "quiz"),
		assistant("a-2", [{ type: "text", text: "Second reply." }]),
		toolResult("answer-2", "ask_user_question"),
		assistant("a-3", [{ type: "text", text: "Reply after the latest answer." }]),
	];
	assert.deepEqual(replySpeech(messages), { key: "reply:a-3", text: "Reply after the latest answer." });

	const practice = [
		user("u-practice", "Start practice"),
		assistant("a-before-thinking", [{ type: "text", text: "Earlier feedback." }]),
		{ id: "thinking", role: "custom", customType: "practice-thinking", content: "Your thinking:\nMy work.", display: true, details: {}, timestamp: 4 } as unknown as LhMessage,
		assistant("a-after-thinking", [{ type: "text", text: "Feedback after thinking." }]),
	];
	assert.deepEqual(replySpeech(practice), { key: "reply:a-after-thinking", text: "Feedback after thinking." });
});

test("reply reads send_to_user prose, excludes failed output calls and failed assistant fragments", () => {
	const send = (id: string, text: string) => ({ type: "toolCall", id, name: "send_to_user", arguments: { message: text } });
	assert.deepEqual(replySpeech([
		user("u", "Question"),
		assistant("a-send", [send("send-ok", "Explicit tutor reply.")]),
	]), { key: "reply:a-send", text: "Explicit tutor reply." });
	assert.equal(replySpeech([
		user("u-failed-send", "Question"),
		assistant("a-failed-send", [send("send-error", "Not delivered.")]),
		toolResult("send-error-result", "send_to_user", "send-error", true),
	]), null);

	assert.deepEqual(replySpeech([
		user("u-retry", "Question"),
		assistant("a-failed-fragment", [
			{ type: "text", text: "Failed fragment." },
			send("send-failed-fragment", "Failed output."),
		], "error"),
		toolResult("failed-fragment-result", "send_to_user", "send-failed-fragment", true),
		assistant("a-retry", [{ type: "text", text: "Successful retry." }]),
	]), { key: "reply:a-retry", text: "Successful retry." });
});

test("question prompt follows canonical shuffled options and excludes answer, rubric, and grading data", () => {
	const input = {
		question: "Choose the visible claim.",
		details: "Visible context.",
		options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
		correctAnswer: "Alpha",
		explanation: "SECRET EXPLANATION",
		parts: [{
			id: "part-a",
			label: "Part A",
			prompt: "Visible part prompt",
			criteria: [{ id: "criterion", description: "SECRET CRITERION", maxPoints: 2, expectedEvidence: "SECRET EVIDENCE" }],
		}],
	};
	const canonical = questionDataOf("quiz", "quiz-call", input)!;
	const speech = questionSpeech("quiz", "quiz-call", input)!;
	assert.equal(speech.key, "prompt:quiz-call");
	assert.match(speech.text, /Choose the visible claim\.\nVisible context\.\nPart A: Visible part prompt/);
	const optionPositions = canonical.options.map((option, index) => speech.text.indexOf(`Option ${index + 1}: ${option.label}`));
	assert.ok(optionPositions.every((position) => position >= 0));
	assert.deepEqual(optionPositions, [...optionPositions].sort((a, b) => a - b));
	assert.match(speech.text, /Or: I don't know/);
	assert.doesNotMatch(speech.text, /SECRET|correctAnswer|explanation/);

	const ask = questionSpeech("ask_user_question", "ask-call", {
		question: "Which description fits?",
		options: [{ label: "One", description: "Visible option detail" }, { label: "Two" }],
		correctAnswer: "PRIVATE",
	});
	assert.match(ask!.text, /Option 1: One Visible option detail/);
	assert.doesNotMatch(ask!.text, /I don't know|PRIVATE/);
});

test("practice prompt includes statement and multipart prompts without commitments or criteria", () => {
	const input = {
		statement: "Visible problem statement.",
		modelSolution: "SECRET SOLUTION",
		parts: [{
			id: "part-b",
			label: "B",
			prompt: "Visible part B.",
			criteria: [{ id: "c", description: "SECRET RUBRIC", maxPoints: 1, expectedEvidence: "SECRET EVIDENCE" }],
		}],
	};
	const prompt = practiceSpeech("problem-1", input)!;
	assert.equal(prompt.key, "prompt:problem-1");
	assert.equal(prompt.text, "Visible problem statement.\nPart B: Visible part B.");
	assert.doesNotMatch(prompt.text, /SECRET|modelSolution|criteria/);
});

test("reply is offered only for a settled, idle, non-error transcript", () => {
	const ready = { status: "ready", busy: false, compacting: false, error: null, retryable: false };
	assert.equal(replyReadable(ready), true);
	for (const patch of [
		{ status: "streaming" },
		{ busy: true },
		{ compacting: true },
		{ error: new Error("failed") },
		{ retryable: true },
	]) {
		assert.equal(replyReadable({ ...ready, ...patch }), false);
	}
});
