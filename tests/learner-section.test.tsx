import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import test from "node:test";
import { LearnerSection, LearnerSectionBody } from "../components/settings/learner-section.tsx";
import type { LearnerObservation, LearnerProfileV1 } from "../src/core/contracts/learner.ts";
import { emptyLearnerProfile } from "../src/core/learner.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;

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

test("confirming reviewed excerpts preserves unsaved profile edits", async () => {
	const timestamp = "2026-03-01T00:00:00.000Z";
	const initialProfile: LearnerProfileV1 = {
		...emptyLearnerProfile(timestamp),
		revision: 7,
		background: "Saved background",
		coursework: "Saved coursework",
		topics: [{
			id: "topic-1",
			topic: "Saved topic",
			familiarity: "unfamiliar",
			note: "Saved note",
			updatedAt: timestamp,
		}],
	};
	const confirmedProfile: LearnerProfileV1 = {
		...initialProfile,
		revision: 8,
		excerpts: [{
			id: "excerpt-1",
			sourceName: "lesson.md",
			text: "Reviewed excerpt",
			importedAt: timestamp,
		}],
	};
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url === "/api/learner/profile") return Response.json({ state: "ok", profile: initialProfile });
		if (url.startsWith("/api/learner/evidence")) {
			return Response.json({
				availability: "complete",
				observations: [],
				nextCursor: null,
				coverage: { scannedChats: 0, totalChats: 0, unreadableChats: 0 },
			});
		}
		if (url === "/api/learner/import/preview") {
			return Response.json({ drafts: [{ sourceName: "lesson.md", text: "Reviewed excerpt", bytes: 16 }] });
		}
		if (url === "/api/learner/import/confirm") {
			assert.equal(init?.method, "POST");
			return Response.json({ state: "ok", profile: confirmedProfile });
		}
		throw new Error(`Unexpected learner request: ${url}`);
	};

	let root: Root | undefined;
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		root = createRoot(host);
		await act(async () => { root!.render(createElement(LearnerSection)); });

		const setField = (selector: string, value: string) => {
			const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
			const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
			descriptor?.set?.call(field, value);
			field.dispatchEvent(new window.Event("input", { bubbles: true }));
		};
		await act(async () => {
			setField("#learner-background", "Unsaved background");
			setField("#learner-coursework", "Unsaved coursework");
			setField("#learner-topic-0", "Unsaved topic");
		});

		const fileInput = host.querySelector<HTMLInputElement>("#learner-import-files")!;
		Object.defineProperty(fileInput, "files", {
			configurable: true,
			value: [new File(["reviewed"], "lesson.md")],
		});
		await act(async () => { fileInput.dispatchEvent(new window.Event("change", { bubbles: true })); });
		const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
			.find((element) => element.textContent?.trim() === label)!;
		await act(async () => { button("Preview selected files").click(); });
		await act(async () => { button("Confirm reviewed excerpts").click(); });

		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-background")?.value, "Unsaved background");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-coursework")?.value, "Unsaved coursework");
		assert.equal(host.querySelector<HTMLInputElement>("#learner-topic-0")?.value, "Unsaved topic");
		assert.match(host.textContent ?? "", /Profile revision 8/);
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-excerpt-1")?.value, "Reviewed excerpt");
	} finally {
		await act(async () => { root?.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});
