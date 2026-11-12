import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import test from "node:test";
import { LearnerSection, LearnerSectionBody } from "../components/settings/learner-section.tsx";
import type {
	LearnerObservation,
	LearnerProfileV1,
	WeaknessPattern,
	WeaknessPatternOccurrence,
	WeaknessPatternStatus,
} from "../src/core/contracts/learner.ts";
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

test("recurring weaknesses render quotes and target titles; status buttons dispatch changes", async () => {
	type DisplayPattern = WeaknessPattern & {
		occurrences: (WeaknessPatternOccurrence & { targetTitle?: string })[];
	};
	const pattern: DisplayPattern = {
		id: "pattern-1",
		subject: "Python",
		pattern: "off-by-one in range() bounds",
		status: "active",
		occurrences: [{
			chatId: "chat-1",
			messageId: "message-1",
			quote: "I use range(0, n + 1).",
			at: "2026-03-01T00:00:00.000Z",
			target: { kind: "subject-skill", mapId: "map-1", skillId: "loops", skillRevision: 1 },
			targetTitle: "Programming — Loop bounds",
		}],
		createdAt: "2026-03-01T00:00:00.000Z",
		updatedAt: "2026-03-01T00:00:00.000Z",
	};
	const changes: [string, WeaknessPatternStatus][] = [];
	let root: Root | undefined;
	const host = document.createElement("div");
	document.body.appendChild(host);
	globalThis.fetch = async () => Response.json({ profileRevision: 0, suggestions: [] });
	try {
		root = createRoot(host);
		await act(async () => {
			root!.render(createElement(LearnerSectionBody, {
				profileState: "ok",
				patterns: [pattern],
				onPatternStatusChange: (id, status) => changes.push([id, status]),
			}));
		});
		assert.match(host.textContent ?? "", /Recurring weaknesses/);
		assert.match(host.textContent ?? "", /×1/);
		assert.match(host.textContent ?? "", /Programming — Loop bounds/);
		assert.match(host.textContent ?? "", /I use range\(0, n \+ 1\)\./);
		const patternSection = host.querySelector<HTMLElement>('[aria-labelledby="learner-patterns-heading"]')!;
		const button = (label: string) => [...patternSection.querySelectorAll<HTMLButtonElement>("button")]
			.find((element) => element.textContent?.trim() === label)!;
		await act(async () => {
			button("Dismiss").click();
			button("Mark resolved").click();
		});
		assert.deepEqual(changes, [["pattern-1", "dismissed"], ["pattern-1", "resolved"]]);
		const dismissedPattern = { ...pattern, status: "dismissed" as const };
		await act(async () => {
			root!.render(createElement(LearnerSectionBody, {
				profileState: "ok",
				patterns: [dismissedPattern],
				onPatternStatusChange: (id, status) => changes.push([id, status]),
			}));
		});
		await act(async () => { button("Reactivate").click(); });
		assert.deepEqual(changes, [["pattern-1", "dismissed"], ["pattern-1", "resolved"], ["pattern-1", "active"]]);
	} finally {
		await act(async () => { root?.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});

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

test("Override details are collapsed by default", () => {
	const html = renderToStaticMarkup(createElement(LearnerSectionBody, {}));
	const details = html.match(/<details[^>]*>/)?.[0];
	assert.ok(details);
	assert.doesNotMatch(details, /\bopen(?:=|\s|>)/);
	assert.match(html, /<summary[^>]*>Override<\/summary>/);
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
		if (url === "/api/learner/patterns") return Response.json({ patterns: [] });
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
			setField("#learner-excerpt-excerpt-existing", "Edited excerpt");
			host.querySelector<HTMLTextAreaElement>("#learner-excerpt-excerpt-removed")?.parentElement?.querySelector("button")?.click();
		});
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-background")?.value, "Unsaved background");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-coursework")?.value, "Unsaved coursework");
		assert.equal(host.querySelector<HTMLSelectElement>("#learner-familiarity-0")?.value, "familiar");
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-excerpt-existing")?.value, "Edited excerpt");
		assert.equal(host.querySelector("#learner-excerpt-excerpt-removed"), null);

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
		assert.equal(host.querySelector<HTMLTextAreaElement>("#learner-excerpt-excerpt-existing")?.value, "Edited excerpt");
		assert.equal(host.querySelector("#learner-excerpt-excerpt-removed"), null);
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
		if (url === "/api/learner/patterns") return Response.json({ patterns: [] });
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

test("import drafts can be removed and the import cancelled without any write", async () => {
	const requests: string[] = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/learner/profile") return Response.json({ state: "absent", profile: emptyLearnerProfile("2026-03-01T00:00:00.000Z") });
		if (url === "/api/learner/patterns") return Response.json({ patterns: [] });
		if (url.startsWith("/api/learner/evidence")) {
			return Response.json({
				availability: "complete",
				observations: [],
				nextCursor: null,
				coverage: { scannedChats: 0, totalChats: 0, unreadableChats: 0 },
			});
		}
		if (url === "/api/learner/import/preview") {
			return Response.json({
				drafts: [
					{ sourceName: "first.md", text: "First draft", bytes: 11 },
					{ sourceName: "second.txt", text: "Second draft", bytes: 12 },
				],
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
		const fileInput = host.querySelector<HTMLInputElement>("#learner-import-files")!;
		assert.match(fileInput.getAttribute("accept") ?? "", /\.markdown/);
		Object.defineProperty(fileInput, "files", {
			configurable: true,
			value: [new File(["first"], "first.md"), new File(["second"], "second.txt")],
		});
		await act(async () => { fileInput.dispatchEvent(new window.Event("change", { bubbles: true })); });
		const buttons = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
			.filter((element) => element.textContent?.trim() === label);
		await act(async () => { buttons("Preview selected files")[0]!.click(); });
		assert.equal(buttons("Remove draft").length, 2);

		await act(async () => { buttons("Remove draft")[0]!.click(); });
		const remaining = host.querySelector<HTMLTextAreaElement>("#learner-import-draft-0");
		assert.equal(remaining?.value, "Second draft");
		assert.equal(host.querySelector("#learner-import-draft-1"), null);

		await act(async () => { buttons("Cancel import")[0]!.click(); });
		assert.equal(host.querySelector("#learner-import-draft-0"), null);
		assert.equal(buttons("Confirm reviewed excerpts").length, 0);
		assert.equal(buttons("Cancel import").length, 0);
		const freshInput = host.querySelector<HTMLInputElement>("#learner-import-files")!;
		assert.notEqual(freshInput, fileInput);
		assert.ok(requests.every((request) => !request.includes("/api/learner/import/confirm") && !request.startsWith("PUT ")));
	} finally {
		await act(async () => { root?.unmount(); });
		host.remove();
		globalThis.fetch = originalFetch;
	}
});
