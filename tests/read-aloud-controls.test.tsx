import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadAloudButton, readAloudDisabledReason, toggleReadAloud } from "../components/read-aloud-controls.tsx";
import { handleEscapeFallback } from "../components/keyboard-shortcuts.tsx";

test("button stays honestly disabled without browser speech synthesis", () => {
	const markup = renderToStaticMarkup(<ReadAloudButton speech={{ key: "reply:a", text: "A settled reply." }} label="Read reply" />);
	assert.match(markup, /disabled/);
	assert.match(markup, /does not support speech synthesis/);
	assert.match(markup, /Read reply/);
	assert.doesNotMatch(markup, /<select/);
});

test("disabled reasons cover missing text, dictation, unsupported, and no-local-voice states", () => {
	const speech = { key: "prompt:q", text: "Question" };
	assert.match(readAloudDisabledReason({ speech: null, dictationActive: false, support: "ready" })!, /No readable text/);
	assert.equal(readAloudDisabledReason({ speech, dictationActive: true, support: "ready" }), "Finish dictation first");
	assert.equal(readAloudDisabledReason({ speech, dictationActive: false, support: "unsupported" }), "Read-aloud unavailable: this browser does not support speech synthesis");
	assert.equal(readAloudDisabledReason({ speech, dictationActive: false, support: "noLocalVoice" }), "Read-aloud unavailable: this browser has no on-device voice");
	assert.equal(readAloudDisabledReason({ speech, dictationActive: false, support: "ready" }), undefined);
});

test("button action starts the selected speech, stops its active key, and ignores missing text", () => {
	const actions: string[] = [];
	const speech = { key: "reply:a", text: "Tutor reply." };
	toggleReadAloud(speech, null, (key, text) => actions.push(`read:${key}:${text}`), () => actions.push("stop"));
	toggleReadAloud(speech, "reply:a", (key) => actions.push(`read:${key}`), () => actions.push("stop"));
	toggleReadAloud(null, null, (key) => actions.push(`read:${key}`), () => actions.push("stop"));
	assert.deepEqual(actions, ["read:reply:a:Tutor reply.", "stop"]);
});

test("Escape fallback gives active dictation precedence, then speech, then turn abort", () => {
	const events: string[] = [];
	let prevented = 0;
	const event = { preventDefault: () => prevented++ };
	handleEscapeFallback(event, () => true, () => { throw new Error("speech state must not be queried before dictation"); }, () => events.push("stop"), (name) => events.push(name));
	assert.deepEqual(events, ["lh:kbd-cancel-dictation"]);
	assert.equal(prevented, 1);

	events.length = 0;
	handleEscapeFallback(event, () => false, () => true, () => events.push("stop"), (name) => events.push(name));
	assert.deepEqual(events, ["stop"]);
	assert.equal(prevented, 2);

	events.length = 0;
	handleEscapeFallback(event, () => false, () => false, () => events.push("stop"), (name) => events.push(name));
	assert.deepEqual(events, ["lh:kbd-abort-turn"]);
	assert.equal(prevented, 2);
});

test("unmounting or swapping a Read control stops only its own playback", async () => {
	const { act } = await import("react");
	const { parseHTML } = await import("linkedom");
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const events: string[] = [];
	Object.defineProperty(dom.window, "speechSynthesis", {
		configurable: true,
		value: {
			getVoices: () => [{ voiceURI: "local", name: "Local", lang: "en-US", localService: true, default: true }],
			speak: (utterance: { text: string }) => events.push(`speak:${utterance.text}`),
			cancel: () => events.push("cancel"),
			addEventListener: () => {},
			removeEventListener: () => {},
		},
	});
	const globals = globalThis as Record<string, unknown>;
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: { language: "en-US", userAgent: "" },
		IS_REACT_ACT_ENVIRONMENT: true,
		SpeechSynthesisUtterance: class {
			voice: unknown = null;
			onend: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(readonly text: string) {}
		},
	})) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const { readSpeech, useReadAloud } = await import("../components/read-aloud.ts");
	let speakingKey: string | null = null;
	function Probe() {
		speakingKey = useReadAloud().speakingKey;
		return null;
	}
	const root = createRoot(dom.document.getElementById("root")!);
	const render = (speech: { key: string; text: string } | null) =>
		act(async () => {
			root.render(<><Probe />{speech && <ReadAloudButton speech={speech} label="Read prompt" />}</>);
		});

	await render({ key: "prompt:a", text: "Prompt A." });
	await act(async () => { readSpeech("reply:other", "Other reply."); });
	assert.equal(speakingKey, "reply:other");
	await render(null);
	assert.equal(speakingKey, "reply:other", "a control does not stop speech it did not start");

	await render({ key: "prompt:a", text: "Prompt A." });
	const button = dom.document.querySelector("button")!;
	assert.equal(button.hasAttribute("disabled"), false);
	await act(async () => { button.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
	assert.equal(speakingKey, "prompt:a");
	events.length = 0;
	await render({ key: "prompt:b", text: "Prompt B." });
	assert.equal(speakingKey, null, "a swapped prompt stops the stale prompt's playback");
	assert.deepEqual(events, ["cancel"]);

	await act(async () => { dom.document.querySelector("button")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
	assert.equal(speakingKey, "prompt:b");
	await act(async () => { root.unmount(); });
	assert.equal(speakingKey, "prompt:b", "the probe unmounted too; check the controller directly");
	const { isSpeaking } = await import("../components/read-aloud.ts");
	assert.equal(isSpeaking(), false, "unmounting the control stops its playback");
	for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "SpeechSynthesisUtterance"]) delete globals[key];
});
