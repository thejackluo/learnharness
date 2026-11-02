import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { stepConfidenceIndex, CONFIDENCE_STOPS, type QuestionAnswerData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const input = { question: "Closest planet?", options: [{ label: "Mercury" }, { label: "Venus" }], correctAnswer: "Mercury", explanation: "Innermost." };

async function answerWith(steps: (host: HTMLElement) => Promise<void>): Promise<QuestionAnswerData> {
	let answer: QuestionAnswerData | undefined;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<QuestionDock toolName="probe" toolCallId="conf_q" input={input} expanded
			dictationClaim={false} onExpand={() => {}} onSubmit={a => { answer = a; }} />));
		const choice = host.querySelector<HTMLButtonElement>('[role="radio"]')!;
		await act(async () => choice.click());
		await steps(host);
		await act(async () => host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
	} finally { await act(async () => root.unmount()); host.remove(); }
	assert.ok(answer);
	return answer;
}

function arrow(key: "ArrowRight" | "ArrowLeft") {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false });
	document.dispatchEvent(event);
}

test("confidence stays unset until used; an explicit 50 stays 50", async () => {
	const untouched = await answerWith(async (host) => {
		assert.equal(host.querySelector('[data-testid="confidence-value"]')!.textContent, "—");
		assert.ok(host.querySelector('[data-testid="confidence-unset"]'));
	});
	assert.equal(untouched.confidence, undefined);
	assert.ok(!("confidence" in untouched));

	const fifty = await answerWith(async (host) => {
		await act(async () => arrow("ArrowRight"));
		assert.equal(host.querySelector('[data-testid="confidence-value"]')!.textContent, "50%");
	});
	assert.equal(fifty.confidence, 50);

	const seventy = await answerWith(async () => {
		await act(async () => arrow("ArrowRight"));
		await act(async () => arrow("ArrowRight"));
	});
	assert.equal(seventy.confidence, 70);

	const cleared = await answerWith(async (host) => {
		await act(async () => arrow("ArrowLeft"));
		await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="confidence-clear"]')!.click());
		assert.equal(host.querySelector('[data-testid="confidence-value"]')!.textContent, "—");
	});
	assert.equal(cleared.confidence, undefined);
});

test("the first step from unset lands on the default stop", () => {
	assert.equal(CONFIDENCE_STOPS[stepConfidenceIndex(null, 1)], 50);
	assert.equal(CONFIDENCE_STOPS[stepConfidenceIndex(null, -1)], 50);
	assert.equal(stepConfidenceIndex(5, 1), 5);
	assert.equal(stepConfidenceIndex(0, -1), 0);
});
