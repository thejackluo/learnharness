import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import test from "node:test";
import { LearnerSection, LearnerSectionBody } from "../components/settings/learner-section.tsx";
import type { LearnerObservation, LearnerProfileV1 } from "../src/core/contracts/learner.ts";
import { emptyLearnerProfile } from "../src/core/learner.ts";

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
});
const { createRoot } = await import("react-dom/client");
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
		excerpts: [
			{ id: "excerpt-existing", sourceName: "notes.txt", text: "Original excerpt", importedAt: timestamp },
			{ id: "excerpt-removed", sourceName: "old.md", text: "Excerpt to remove", importedAt: timestamp },
		],
	};
	const confirmedProfile: LearnerProfileV1 = {
		...initialProfile,
		revision: 8,
		excerpts: [
			...initialProfile.excerpts,
			{ id: "excerpt-imported", sourceName: "lesson.md", text: "Reviewed excerpt", importedAt: timestamp },
		],
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
			const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
			if (field.tagName === "SELECT") {
				Object.defineProperty(field, "value", { configurable: true, writable: true, value });
				field.dispatchEvent(new window.Event("change", { bubbles: true }));
				return;
			}
			const prototype = field.tagName === "TEXTAREA"
				? window.HTMLTextAreaElement.prototype
				: window.HTMLInputElement.prototype;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
			descriptor?.set?.call(field, value);
			field.dispatchEvent(new window.Event("input", { bubbles: true }));
			field.dispatchEvent(new window.Event("change", { bubbles: true }));
		};
		await act(async () => {
			setField("#learner-background", "Unsaved background");
			setField("#learner-coursework", "Unsaved coursework");
			setField("#learner-familiarity-0", "familiar");
			setField("#learner-excerpt-existing", "Edited excerpt");
			host.querySelector<HTMLTextAreaElement>("#learner-excerpt-removed")?.parentElement?.querySelector("button")?.click();
		});
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-background")?.value, "Unsaved background");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-coursework")?.value, "Unsaved coursework");
		assert.equal(host.querySelector<HTMLSelectElement>("#learner-familiarity-0")?.value, "familiar");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-existing")?.value, "Edited excerpt");
		assert.equal(host.querySelector("#learner-excerpt-removed"), null);

		const fileInput = host.querySelector<HTMLInputElement>("#learner-import-files")!;
		Object.defineProperty(fileInput, "files", {
			configurable: true,
			value: [new File(["reviewed"], "lesson.md")],
		});
		await act(async () => { fileInput.dispatchEvent(new window.Event("change", { bubbles: true })); });
		const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
			.find((element) => element.textContent?.trim() === label)!;
		await act(async () => { button("Preview selected files").click(); });
		assert.equal(host.querySelector<HTMLSelectElement>("#learner-familiarity-0")?.value, "familiar");
		await act(async () => { button("Confirm reviewed excerpts").click(); });

		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-background")?.value, "Unsaved background");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-coursework")?.value, "Unsaved coursework");
		assert.equal(host.querySelector<HTMLSelectElement>("#learner-familiarity-0")?.value, "familiar");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-existing")?.value, "Edited excerpt");
		assert.equal(host.querySelector("#learner-excerpt-removed"), null);
		assert.match(host.textContent ?? "", /Profile revision 8/);
		assert.ok(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-excerpt-imported"));
		assert.match(host.textContent ?? "", /lesson\.md/);
	} finally {
		await act(async () => { root?.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});

test("appended evidence pages stay ordered and deduplicated", async () => {
	const observedAt = {
		newest: "2026-03-04T00:00:00.000Z",
		middle: "2026-03-03T00:00:00.000Z",
		tie: "2026-03-02T00:00:00.000Z",
		oldest: "2026-03-01T00:00:00.000Z",
	};
	const observation = (id: string, prompt: string, at: string): LearnerObservation => ({
		id,
		chatId: "source-chat",
		chatTitle: "Evidence source",
		chatKind: "teach",
		resultMessageId: `${id}-result`,
		sourceCallId: `${id}-call`,
		observedAt: at,
		prompt,
		provenance: "deterministic",
		targets: [],
		kind: "choice",
		outcome: "correct",
		tool: "quiz",
	});
	const firstPage = [
		observation("middle", "Middle", observedAt.middle),
		observation("tie-z", "Tie Z", observedAt.tie),
		observation("oldest", "Oldest", observedAt.oldest),
	];
	const secondPage = [
		observation("newest", "Newest", observedAt.newest),
		observation("tie-z", "Tie Z", observedAt.tie),
		observation("tie-a", "Tie A", observedAt.tie),
	];
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url === "/api/learner/profile") return Response.json({ state: "absent", profile: null });
		if (url === "/api/learner/evidence") {
			return Response.json({
				availability: "partial",
				observations: firstPage,
				nextCursor: "next",
				coverage: { scannedChats: 2, totalChats: 5, unreadableChats: 0 },
			});
		}
		if (url === "/api/learner/evidence?cursor=next") {
			return Response.json({
				availability: "complete",
				observations: secondPage,
				nextCursor: null,
				coverage: { scannedChats: 5, totalChats: 5, unreadableChats: 0 },
			});
		}
		throw new Error(`Unexpected learner request: ${url}`);
	};

	let root: Root | undefined;
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		root = createRoot(host);
		await act(async () => { root!.render(createElement(LearnerSection)); });
		const loadMore = [...host.querySelectorAll<HTMLButtonElement>("button")]
			.find((element) => element.textContent?.trim() === "Load more observations")!;
		await act(async () => { loadMore.click(); });

		const prompts = [...host.querySelectorAll<HTMLParagraphElement>("li p.font-prose")]
			.map((element) => element.textContent);
		assert.deepEqual(prompts, ["Newest", "Middle", "Tie A", "Tie Z", "Oldest"]);
	} finally {
		await act(async () => { root?.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});
