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
