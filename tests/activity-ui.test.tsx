import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ActivityCard, ActivityView } from "../components/activity-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { normalizeActivity } from "../src/core/activity.ts";
import { buildAnswer } from "../src/core/question-core.ts";
import { questionDataOf } from "../src/core/canonical-question.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const activity = normalizeActivity({
	kind: "case-comparison",
	title: "<img src=x onerror=alert(1)> Slopes",
	objective: "Notice the slope.",
	instructions: "Switch cases.",
	xAxis: { label: "time", unit: "s" },
	yAxis: { label: "distance" },
	cases: [
		{ id: "slow", label: "<script>slow</script>", series: [{ id: "a", label: "Line A", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
		{ id: "fast", label: "Fast case", description: "Steeper.", series: [{ id: "a", label: "Line A", points: [{ x: 0, y: 0 }, { x: 1, y: 7 }] }, { id: "b", label: "Line B", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] },
	],
	textAlternative: "Slow rises 1; fast rises 7. ![x](https://evil.example/t.png)",
});

test("HTML-like labels and markdown render as escaped plain text; nothing loads remotely", () => {
	const markup = renderToStaticMarkup(<ActivityView activity={activity} toolCallId="act-1" />);
	assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt; Slopes/);
	assert.match(markup, /&lt;script&gt;slow&lt;\/script&gt;/);
	assert.doesNotMatch(markup, /<img|<script|<iframe|<a | src="| href="/);
	assert.match(markup, /!\[x\]\(https:\/\/evil.example\/t.png\)/);
	// Non-color encoding: a distinct dash pattern per series; no animation.
	assert.doesNotMatch(markup, /animate|transition/);
	assert.match(markup, /viewBox="0 0 480 280"/);
	assert.equal(artifactRenderers.activity, ActivityCard);
	assert.equal(renderToStaticMarkup(<ActivityCard part={{ type: "tool-activity", toolCallId: "act-1", state: "input-available" }} />), "");
	assert.equal(renderToStaticMarkup(<ActivityCard part={{ type: "tool-activity", toolCallId: "act-1", state: "output-available", output: { ...activity, html: "<b>" } }} />), "");
});

test("keyboard case switching changes the figure, table and caption", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<ActivityCard part={{ type: "tool-activity", toolCallId: "act-1", state: "output-available", output: JSON.parse(JSON.stringify(activity)) }} />));
	try {
		const radios = () => [...host.querySelectorAll('[role="radio"]')] as HTMLElement[];
		assert.deepEqual(radios().map((r) => r.getAttribute("aria-checked")), ["true", "false"]);
		assert.deepEqual(radios().map((r) => r.getAttribute("tabindex")), ["0", "-1"]);
		const before = { plot: host.querySelector('[data-testid="activity-plot"]')!.innerHTML, table: host.querySelector('[data-testid="activity-table"]')!.textContent };
		assert.equal(host.querySelectorAll("[data-series]").length, 1);
		const key = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(key, { key: "ArrowRight" });
		await act(async () => radios()[0]!.dispatchEvent(key));
		assert.deepEqual(radios().map((r) => r.getAttribute("aria-checked")), ["false", "true"]);
		assert.equal(host.querySelectorAll("[data-series]").length, 2);
		assert.notEqual(host.querySelector('[data-testid="activity-plot"]')!.innerHTML, before.plot);
		assert.notEqual(host.querySelector('[data-testid="activity-table"]')!.textContent, before.table);
		assert.match(host.querySelector('[data-testid="activity-table"]')!.textContent!, /Line B/);
		assert.match(host.querySelector('[data-testid="activity-caption"]')!.textContent!, /Fast case.*Steeper\./);
		assert.equal(host.querySelector('[data-testid="activity-caption"]')!.getAttribute("aria-live"), "polite");
		const dashes = [...host.querySelectorAll("polyline")].map((p) => p.getAttribute("stroke-dasharray"));
		assert.equal(new Set(dashes).size, 2);
		const home = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(home, { key: "Home" });
		await act(async () => radios()[1]!.dispatchEvent(home));
		assert.equal(radios()[0]!.getAttribute("aria-checked"), "true");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

test("the dock and answered card reference the exact activity via the shared explanation field", () => {
	const input = { type: "check", nodeId: "n1", question: "Explain the change", correctAnswer: "correct answer stays server-only", parts: [{ id: "p", prompt: "Why", criteria: [{ id: "c", description: "d", maxPoints: 1, expectedEvidence: "expected evidence stays server-only" }] }], stimulus: { kind: "teaching-stimulus", toolCallId: "act-1" } };
	const dock = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="q1" input={input as never} stimulusGuide={{ title: "<b>Slopes</b>", objective: "Notice <i>k</i>", instructions: "x" }} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.equal((dock.match(/<textarea/g) ?? []).length, 1);
	assert.match(dock, /href="#activity-act-1"/);
	assert.match(dock, /&lt;b&gt;Slopes&lt;\/b&gt;/);
	assert.match(dock, /Goal: Notice &lt;i&gt;k&lt;\/i&gt;/);
	assert.doesNotMatch(dock, /<\/?[bi](?:\s|>)/i);
	assert.doesNotMatch(dock, /correct answer stays server-only|expected evidence stays server-only/);
	const withoutGuide = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="q1" input={input as never} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.match(withoutGuide, /About the activity above/);
	const answer = { ...buildAnswer(questionDataOf("explain", "q1", input)!, { text: "because" }), stimulus: { kind: "teaching-stimulus" as const, messageId: "result-act-1", toolCallId: "act-1", guide: { title: "<b>T</b>", objective: "o", instructions: "i" }, provenance: "appRenderedActivity" as const } };
	const answered = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
	assert.match(answered, /&lt;b&gt;T&lt;\/b&gt;/);
	assert.match(answered, /href="#activity-act-1"/);
});
