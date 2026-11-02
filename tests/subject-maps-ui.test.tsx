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
	// next/link's viewport prefetch schedules through self.requestIdleCallback.
	self: globalThis,
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
		assert.equal(container.querySelector("img"), null, "skill titles render as text, never markup");
		assert.match(container.textContent ?? "", /<img src=x>/);
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

test("evidence attachment sends the saved objective revision and reloads after a stale objective conflict", async () => {
	let mapReads = 0;
	let attachedBody: unknown;
	const updatedMap = { ...map, revision: 5, skills: map.skills.map((skill) => skill.id === "proc" ? { ...skill, revision: 2, objective: "Compare processes" } : skill) };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/maps/map_ui") {
			mapReads++;
			const current = mapReads === 1 ? map : updatedMap;
			return Response.json({ state: "ok", map: current, view: { ...view, skills: view.skills.map((entry) => ({ ...entry, skill: current.skills.find((skill) => skill.id === entry.skill.id) })) } });
		}
		if (init?.method === "POST") {
			attachedBody = JSON.parse(String(init.body));
			return Response.json({ code: "skill_revision_conflict", current: updatedMap.skills[0] }, { status: 409 });
		}
		if (url.startsWith("/api/learner/evidence")) return Response.json({ observations: [observation], nextCursor: null });
		if (url === "/api/graph") return Response.json({ propositions: [] });
		if (url === "/api/learner/profile") return Response.json({ state: "ok", profile: { revision: 3, topics: [] } });
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	try {
		const { root, container } = await mount(createElement(SubjectMapEditor, { mapId: "map_ui" }));
		const select = container.querySelector('select[id$="-evidence"]')!;
		await act(async () => {
			select.querySelectorAll("option").forEach((option) => { option.selected = option.value === observation.id; });
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		await click(select.parentElement!.querySelector("button")!);
		assert.deepEqual(attachedBody, { mapId: map.id, skillId: "proc", skillRevision: 1, expectedRevision: 3 });
		assert.equal(mapReads, 2);
		assert.match(container.textContent ?? "", /skill objective changed elsewhere; reloaded the latest version/);
		assert.equal((container.querySelector('textarea[id$="-objective"]') as HTMLTextAreaElement).value, "Compare processes");
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

test("skill launch checks model setup before creating a session and ignores a double click", async () => {
	const posts: string[] = [];
	let configured = false;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/maps/map_ui") return Response.json({ state: "ok", map, view });
		if (url.startsWith("/api/learner/evidence")) return Response.json({ availability: "complete", observations: [], nextCursor: null, profileRevision: 3 });
		if (url === "/api/graph") return Response.json({ propositions: [] });
		if (url === "/api/learner/profile") return Response.json({ state: "ok", profile: { revision: 3, topics: [] } });
		if (url === "/api/models") {
			const model = configured ? { model: { provider: "openrouter", id: "m" } } : {};
			return Response.json({ slots: { strong: model, cheap: model, vision: model }, providers: [{ keyPresent: configured }], models: [{ provider: "openrouter", id: "m" }] });
		}
		if (url === "/api/chats" && init?.method === "POST") {
			posts.push(String(init.body));
			await new Promise((resolve) => setTimeout(resolve, 5));
			return Response.json({ id: "chat_started", title: "t" });
		}
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	const assigned: string[] = [];
	const stored = new Map<string, string>();
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } } });
	const originalLocation = Object.getOwnPropertyDescriptor(dom.window, "location");
	Object.defineProperty(dom.window, "location", { configurable: true, value: { assign: (url: string) => { assigned.push(url); } } });
	try {
		const { root, container } = await mount(createElement(SubjectMapEditor, { mapId: "map_ui" }));
		await click(button(container, "Start a session on this skill"));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
		assert.equal(posts.length, 0, "no session is created without models and a key");
		assert.match(container.textContent ?? "", /Set up your models and a provider key/);
		configured = true;
		const start = button(container, "Start a session on this skill");
		await click(start);
		await click(start);
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
		assert.equal(posts.length, 1, "a double click creates one session");
		assert.deepEqual(JSON.parse(posts[0]!).target, { mapId: "map_ui", skillId: "proc", skillRevision: 1 });
		assert.deepEqual(assigned, ["/chat/chat_started"]);
		await act(async () => root.unmount());
	} finally {
		globalThis.fetch = originalFetch;
		if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
		else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
		if (originalLocation) Object.defineProperty(dom.window, "location", originalLocation);
		else delete (dom.window as { location?: unknown }).location;
	}
});
