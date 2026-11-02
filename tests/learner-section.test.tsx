import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { LearnerSectionBody } from "../components/settings/learner-section.tsx";
import type { LearnerObservation } from "../src/core/contracts/learner.ts";
import { emptyLearnerProfile } from "../src/core/learner.ts";

test("learner section body renders escaped profile/evidence text and source-linked evidence", () => {
	const observation: LearnerObservation = {
		id: "evidence-id",
		chatId: "chat-id",
		chatTitle: "<img src=x onerror=alert(1)>",
		chatKind: "teach",
		resultMessageId: "result-id",
		sourceCallId: "call-id",
		observedAt: "2026-03-01T00:00:00.000Z",
		prompt: "<script>untrusted()</script>",
		provenance: "legacyClientGraded",
		targets: [],
		kind: "choice",
		outcome: "incorrect",
		tool: "quiz",
	};
	const html = renderToStaticMarkup(createElement(LearnerSectionBody, {
		background: "<script>background()</script>",
		observations: [observation],
		coverage: { scannedChats: 1, totalChats: 1, unreadableChats: 0 },
		availability: "complete",
		profileState: "ok",
	}));

	assert.ok(html.includes("&lt;script&gt;background()&lt;/script&gt;"));
	assert.ok(html.includes("&lt;script&gt;untrusted()&lt;/script&gt;"));
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("legacy, client-graded (unverified)"));
	assert.ok(html.includes('href="/chat/chat-id"'));
	assert.ok(html.includes('for="learner-background"'));
	assert.doesNotMatch(html, /mastery|understanding|\d+(?:\.\d+)?%/i);
});

test("empty completed evidence uses the required message", () => {
	const html = renderToStaticMarkup(createElement(LearnerSectionBody, {
		availability: "complete",
		coverage: { scannedChats: 0, totalChats: 0, unreadableChats: 0 },
	}));
	assert.match(html, /<p class="text-sm text-muted-foreground">No assessed work yet\.<\/p>/);
});

test("revision conflict alert is programmatically focusable", () => {
	const html = renderToStaticMarkup(createElement(LearnerSectionBody, {
		conflictProfile: emptyLearnerProfile("2026-03-01T00:00:00.000Z"),
	}));
	assert.ok(html.includes('tabindex="-1"'));
	assert.ok(html.includes('role="alert"'));
});

test("unwritable profile alert disables editing and save controls", () => {
	const html = renderToStaticMarkup(createElement(LearnerSectionBody, {
		profileState: "profile_unwritable",
	}));
	assert.ok(html.includes("cannot be edited (profile_unwritable)"));
	assert.match(html, /<fieldset[^>]*disabled=""/);
	const saveButton = html.match(/<button[^>]*>Save profile<\/button>/)?.[0];
	assert.ok(saveButton?.includes("disabled"));
});
