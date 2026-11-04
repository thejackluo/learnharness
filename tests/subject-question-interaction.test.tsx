import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
});
const { createRoot } = await import("react-dom/client");

test("typed controls accept numeric, exact, and structured answers and submit their typed responses", async () => {
	const input = {
		question: "Answer each part",
		correctAnswer: "Committed answer",
		parts: [
			{ id: "distance", kind: "numeric", prompt: "Distance", answer: 1000, units: [{ symbol: "m", factor: 1 }, { symbol: "km", factor: 1000 }], tolerance: { kind: "absolute", value: 0.1 }, points: 1 },
			{ id: "word", kind: "exact", prompt: "Word", accepted: ["orbit"], normalize: "nfkc-trim-casefold", points: 1 },
			{ id: "reason", kind: "structured", prompt: "Explain", fields: [{ id: "why", label: "Why", kind: "paragraph" }], criteria: [{ id: "logic", description: "Logic", maxPoints: 1, expectedEvidence: "A reason" }] },
		],
	};
	let submitted: QuestionAnswerData | undefined;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(
			<QuestionDock toolName="explain" toolCallId="interactive" input={input} expanded dictationClaim={false}
				onExpand={() => {}} onSubmit={answer => { submitted = answer; }} />,
		));
		const enter = (id: string, value: string) => {
			const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
			const prototype = Object.getPrototypeOf(field) as object;
			const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
			if (setter) setter.call(field, value);
			else Object.defineProperty(field, "value", { configurable: true, writable: true, value });
			field.dispatchEvent(new window.Event("input", { bubbles: true }));
		};
		await act(async () => enter("question-interactive-distance-value", "1"));
		await act(async () => enter("question-interactive-distance-unit", "km"));
		await act(async () => enter("question-interactive-word-text", "orbit"));
		await act(async () => enter("question-interactive-reason-why", "Because the evidence supports it."));
		const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Submit answer"))!;
		assert.equal(submit.disabled, false);
		await act(async () => submit.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		assert.deepEqual(submitted?.partResponses, [
			{ partId: "distance", kind: "numeric", value: 1, unit: "km" },
			{ partId: "word", kind: "exact", text: "orbit" },
			{ partId: "reason", kind: "structured", fields: [{ id: "why", text: "Because the evidence supports it." }] },
		]);
		assert.equal(submitted?.text, undefined);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
