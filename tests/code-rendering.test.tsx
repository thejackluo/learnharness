import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { questionSpeech } from "../src/core/speech.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import type { QuestionAnswerData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const input = {
	question: "Write add(a, b).",
	correctAnswer: "Secret",
	parts: [{
		id: "sum",
		kind: "code",
		language: "python",
		prompt: "Return the sum.",
		starter: "def add(a, b):\n    return a + b",
		tests: [{ id: "positive", name: "Positive values", call: "add(2, 3)", expected: "5" }],
		points: 1,
	}],
};
const answer: QuestionAnswerData = {
	kind: "explain",
	questionText: input.question,
	answers: [],
	partResponses: [{
		partId: "sum",
		kind: "code",
		source: "def add(a, b):\n    return a - b",
		results: [{ testId: "positive", status: "fail", actual: "-1", error: "AssertionError: values differ", stdout: "" }],
	}],
	dontKnow: false,
	answeredAt: "2026-10-28T00:00:00.000Z",
};

test("answered code cards show submitted Python and test details", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<AnsweredCard answer={answer} input={input} />));
		assert.match(host.textContent ?? "", /def add\(a, b\):/);
		assert.match(host.textContent ?? "", /Positive values: fail/);
		assert.match(host.textContent ?? "", /Call: add\(2, 3\) · Expected: 5/);
		assert.match(host.textContent ?? "", /Actual: -1/);
		assert.match(host.textContent ?? "", /AssertionError: values differ/);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

test("Python exercises are described in speech and rendered in session markdown", () => {
	assert.match(questionSpeech("explain", "speech-code", input)?.text ?? "", /Python code exercise/);
	const call = {
		id: "call-message",
		role: "assistant",
		content: [{ type: "toolCall", id: "code-call", name: "explain", arguments: input }],
	};
	const result = {
		id: "answer-message",
		role: "toolResult",
		toolCallId: "code-call",
		toolName: "explain",
		content: [],
		details: answer,
		isError: false,
		timestamp: 1,
	};
	const markdown = sessionMarkdown([call, result] as never, { anchors: false });
	assert.match(markdown, /Python source/);
	assert.match(markdown, /add\(2, 3\)/);
	assert.match(markdown, /Expected: `5`/);
	assert.match(markdown, /Actual: `-1`/);
	assert.match(markdown, /AssertionError: values differ/);
});
