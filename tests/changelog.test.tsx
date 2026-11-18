import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ChangelogPage from "../app/changelog/page.tsx";

test("changelog page renders the Markdown content and its links", () => {
	const html = renderToStaticMarkup(<ChangelogPage />);

	assert.match(html, /LearnHarness changelog: everything changed in this work/);
	assert.match(html, /<table/);
	assert.match(html, /data-streamdown="link"/);
	assert.match(html, />PR</);
	assert.match(html, /href="\/"/);
	assert.match(html, /Back to app/);
});
