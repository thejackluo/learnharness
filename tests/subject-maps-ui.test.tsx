import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import test from "node:test";
import { SubjectMapEditor } from "../components/subject-map-editor.tsx";
import { SubjectMapsHome } from "../components/subject-maps.tsx";
import type { LearnerObservation } from "../src/core/contracts/learner.ts";
import type { SubjectMapV1 } from "../src/core/contracts/subject-map.ts";
import { projectSubjectMapGaps } from "../src/core/subject-map.ts";

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
const NOW = "2026-11-02T00:00:00.000Z";

const map: SubjectMapV1 = {
	version: 1,
	id: "map_ui",
	revision: 4,
	createdAt: NOW,
	updatedAt: NOW,
	title: "<b>OS</b>",
	description: "",
	skills: [
		{ id: "proc", title: "Processes", objective: "Explain processes", revision: 1 },
		{ id: "thr", title: "<img src=x>", objective: "Explain threads", revision: 2 },
		{ id: "sched", title: "Scheduling", objective: "Trace schedules", revision: 1 },
	],
	edges: [{ prerequisite: "proc", dependent: "thr" }, { prerequisite: "thr", dependent: "sched" }],
	goals: ["sched"],
	retired: [],
	links: { propositions: [], topics: [] },
};

const observation = {
	id: "ev:c:r:k:",
	chatId: "chat-1",
	chatTitle: "Lesson",
	chatKind: "teach",
	resultMessageId: "r",
	sourceCallId: "k",
	observedAt: NOW,
	prompt: "q",
	provenance: "deterministic",
	targets: [],
	kind: "choice",
	outcome: "incorrect",
	tool: "quiz",
} as LearnerObservation;

const view = projectSubjectMapGaps({
	map,
	associations: {
		availability: "available",
		items: [
			{ evidenceId: observation.id, target: { kind: "subject-skill", mapId: map.id, skillId: "thr", skillRevision: 2 }, attachedAt: NOW, observation },
			{ evidenceId: "ev:gone:r:k:", target: { kind: "subject-skill", mapId: map.id, skillId: "thr", skillRevision: 1 }, attachedAt: NOW, observation: null },
		],
	},
	topics: { availability: "available", claims: [] },
	propositions: { availability: "available", names: new Map() },
});

async function mount(element: ReturnType<typeof createElement>): Promise<{ root: Root; container: HTMLElement }> {
	const container = dom.document.createElement("div");
	dom.document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { root, container: container as unknown as HTMLElement };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
	assert.ok(found, `button ${label}`);
	return found as HTMLButtonElement;
}

async function click(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("map editor lists gaps with goal paths, text statuses, escaped titles and historical/unavailable evidence", async () => {
	const requests: { url: string; method: string; headers: Headers }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
		if (url === "/api/maps/map_ui" && (init?.method ?? "GET") === "GET") return Response.json({ state: "ok", map, view });
		if (url === "/api/maps/map_ui") return Response.json({ error: "Map changed", code: "revision_conflict", current: { ...map, revision: 5 } }, { status: 412 });
		if (url.startsWith("/api/learner/evidence")) return Response.json({ availability: "complete", observations: [observation], nextCursor: null, profileRevision: 3 });
		if (url === "/api/graph") return Response.json({ propositions: [{ id: "n_1", name: "Context switch" }] });
		if (url === "/api/learner/profile") return Response.json({ state: "ok", profile: { revision: 3, topics: [] } });
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	try {
		const { root, container } = await mount(createElement(SubjectMapEditor, { mapId: "map_ui" }));
		const html = container.innerHTML;
		assert.ok(html.includes("&lt;b&gt;OS&lt;/b&gt;"));
		assert.ok(!html.includes("<img src=x>"));
		const gaps = container.querySelector('[aria-label="Gaps toward your goals"]');
		assert.ok(gaps);
		const gapText = gaps.textContent ?? "";
		assert.match(gapText, /Processes — Not checked/);
		assert.match(gapText, /Needs practice/);
		assert.match(gapText, /Needed for Scheduling: Processes → <img src=x> → Scheduling/);
		assert.match(html, /Historical \(objective revision 1, review needed\): source unavailable/);
		assert.match(html, /auto-graded/);
		assert.match(html, /href="\/chat\/chat-1"/);
		assert.match(html, /keyboard-accessible view/);
		assert.doesNotMatch(container.textContent ?? "", /mastery \d|\d+(?:\.\d+)?%/i);

		await click(button(container, "Delete map"));
		await click(button(container, "Confirm delete"));
		const del = requests.find((entry) => entry.method === "DELETE");
		assert.ok(del);
		assert.equal(del.headers.get("if-match"), "\"4\"");
		assert.match(container.textContent ?? "", /changed elsewhere \(now revision 5\)/);
		await act(async () => root.unmount());
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("maps index lists unreadable files honestly and unlinking a deleted-map link sends the exact target", async () => {
	const requests: { url: string; method: string; body: string | null }[] = [];
	const target = { kind: "subject-skill", mapId: "map_gone", skillId: "sched", skillRevision: 2 };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
		if (url === "/api/maps") return Response.json({ maps: [
			{ id: "map_ok", state: "ok", title: "Japanese", revision: 2, updatedAt: NOW, skills: 3, goals: 1 },
			{ id: "map_future", state: "future" },
		] });
		if (url === "/api/learner/targets") return Response.json({ availability: "available", profileRevision: 9, links: [
			{ evidenceId: "ev:a:b:c:", target, attachedAt: NOW, sourceStatus: "unavailable", targetStatus: "missingMap", mapTitle: null, skillTitle: null },
		] });
		if (url.startsWith("/api/learner/evidence/")) return Response.json({ state: "ok", profile: { revision: 10 } });
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	try {
		const { root, container } = await mount(createElement(SubjectMapsHome));
		const text = container.textContent ?? "";
		assert.match(text, /Japanese/);
		assert.match(text, /saved by a newer app version/);
		assert.match(text, /map deleted · ⚠ source session unavailable/);
		await click(button(container, "Unlink"));
		const del = requests.find((entry) => entry.method === "DELETE");
		assert.ok(del);
		assert.equal(del.url, `/api/learner/evidence/${encodeURIComponent("ev:a:b:c:")}/targets`);
		assert.deepEqual(JSON.parse(del.body!), { target, expectedRevision: 9 });
		assert.ok(!requests.some((entry) => entry.method === "POST"), "no writes besides the explicit unlink");
		await act(async () => root.unmount());
	} finally {
		globalThis.fetch = originalFetch;
	}
});
