import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesFor } from "../src/core/runtime.ts";
import { agentCapabilities, capabilitiesOverride, CapabilityDeniedError, capabilityFilter } from "../src/agent/capabilities.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobPatch, JobStore } from "../src/core/ports.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { createWebTools } from "../src/agent/tools/web.ts";
import { realHeadless } from "../src/agent/subagents/headless.ts";
import { webSubscriptionRequest, webSubscriptionsEnabled } from "../src/agent/subscription-runtime.ts";

test("hosted registration and direct boundaries deny before filesystem, network, or job work", async () => {
	const previous = capabilitiesOverride.current;
	capabilitiesOverride.current = capabilitiesFor("hosted");
	try {
		assert.deepEqual(agentCapabilities(), capabilitiesFor("hosted"));
		assert.deepEqual(Object.keys(capabilityFilter({
			read: {}, ls: {}, research: {}, demo: {}, visual: {}, pdf: {}, quiz: {},
		})), ["quiz"]);

		let storeCalls = 0;
		let spawnCalls = 0;
		const jobStore = {
			findJobByToolCallId: () => { storeCalls++; return null; },
			createJob: () => { storeCalls++; throw new Error("unexpected job creation"); },
		} as unknown as JobStore;
		const research = jobTools({
			chatId: "synthetic-chat",
			jobStore,
			spawn: () => { spawnCalls++; },
		}).research!;
		await assert.rejects(research.execute("synthetic-call", { question: "synthetic query" }), CapabilityDeniedError);
		assert.equal(storeCalls, 0);
		assert.equal(spawnCalls, 0);

		await assert.rejects(readTool.execute("synthetic-call", { path: "/synthetic/learner-file.txt" }), CapabilityDeniedError);

		let searches = 0;
		const web = createWebTools(() => { searches++; return null; }).web_search!;
		await assert.rejects(web.execute("synthetic-call", { query: "synthetic query", count: 1 }), CapabilityDeniedError);
		assert.equal(searches, 0);

		await assert.rejects(realHeadless.runDemo("<html></html>"), CapabilityDeniedError);
		await assert.rejects(realHeadless.renderSvg("<svg/>"), CapabilityDeniedError);
		await assert.rejects(realHeadless.renderPdfPages("/synthetic/file.pdf", [1]), CapabilityDeniedError);
		assert.equal(webSubscriptionsEnabled(), false);
		await assert.rejects(webSubscriptionRequest("lh:subscriptions", "list", {}), CapabilityDeniedError);

		for (const kind of ["research", "demo", "visual", "pdf"] as const) {
			const job = { id: `synthetic-${kind}`, kind, chatId: "synthetic-chat", status: "running" } as JobRecord;
			let update: Partial<JobRecord> | undefined;
			let engineCalls = 0;
			let deliveryCalls = 0;
			const runner = createJobRunner({
				chatStore: {} as ChatStore,
				jobStore: {
					getJob: () => job,
					updateJob: (_id: string, patch: JobPatch) => { update = patch; return job; },
				} as unknown as JobStore,
				deliver: async () => { deliveryCalls++; },
				engineFor: () => { engineCalls++; return undefined; },
			});
			await runner.runJob(job.id);
			assert.equal(update?.status, "error");
			assert.equal(engineCalls, 0);
			assert.equal(deliveryCalls, 0);
		}
	} finally {
		capabilitiesOverride.current = previous;
	}
});
