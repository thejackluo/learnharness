import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { cancelDictationOrSpeech } from "../components/read-aloud.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

describe("the reading-thinking field (owner round, 2026-10-07)", () => {
	it("carries vertical padding — the 1px-scrollbar absorption", () => {
		const html = renderToStaticMarkup(
			<ReadingThinkingField value="" onChange={() => {}} claim={false} />,
		);
		// The fix (empirically diagnosed): Source Sans 3's font box (22px at
		// 16px) exceeds lh-input's 20px line box by 1px; Chromium counts that
		// in scrollHeight and a zero-padding field-sizing textarea becomes a
		// permanent 1px scroll (a bar shown empty AND at every expansion below
		// max-h). py-0.5 absorbs it — the composer/dock fields get the same
		// absorption implicitly from py-2. Line-height stays 1.25 (caret law).
		assert.ok(html.includes("py-0.5"), "the vertical padding is on the textarea");
		// The cap survives: growth past max-h-40 still scrolls honestly.
		assert.ok(html.includes("max-h-40"), "the 160px growth cap stays");
	});

	it("Escape in the reading-thinking field stops dictation first, otherwise speech, without aborting the turn", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const calls: string[] = [];
		let dictationActive = false;
		let abortTurnEvents = 0;
		const onAbortTurn = () => abortTurnEvents++;
		document.addEventListener("lh:kbd-abort-turn", onAbortTurn);
		const onEscape = () => cancelDictationOrSpeech(
			() => dictationActive,
			() => calls.push("dictation"),
			() => calls.push("speech"),
		);
		const pressEscape = async () => {
			const event = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			await act(async () => host.querySelector("textarea")!.dispatchEvent(event));
			assert.equal(event.defaultPrevented, true);
		};
		try {
			await act(async () => root.render(
				<ReadingThinkingField value="" onChange={() => {}} onEscape={onEscape} claim={false} />,
			));
			await pressEscape();
			assert.deepEqual(calls, ["speech"]);
			assert.equal(abortTurnEvents, 0);

			dictationActive = true;
			await pressEscape();
			assert.deepEqual(calls, ["speech", "dictation"]);
			assert.equal(abortTurnEvents, 0);
		} finally {
			document.removeEventListener("lh:kbd-abort-turn", onAbortTurn);
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
