import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesFor } from "../src/core/runtime.ts";
import { agentCapabilities, capabilitiesOverride, CapabilityDeniedError, capabilityFilter, subscriptionProviderAllowed } from "../src/agent/capabilities.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobPatch, JobStore } from "../src/core/ports.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { createWebTools } from "../src/agent/tools/web.ts";
import { realHeadless } from "../src/agent/subagents/headless.ts";
import { configureWebSubscriptionRuntime, webSubscriptionRequest, webSubscriptionsEnabled } from "../src/agent/subscription-runtime.ts";

test("hosted registration and direct boundaries deny before filesystem, network, or job work", async () => {
	const previous = capabilitiesOverride.current;
	capabilitiesOverride.current = capabilitiesFor("hosted");
	try {
		assert.deepEqual(agentCapabilities(), capabilitiesFor("hosted"));
		assert.equal(subscriptionProviderAllowed("chatgpt"), true);
		assert.equal(subscriptionProviderAllowed("github-copilot"), false);
		assert.equal(subscriptionProviderAllowed("xai"), false);
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
		configureWebSubscriptionRuntime(async <T>(channel: "lh:chatgpt" | "lh:subscriptions", op: string, fields: Record<string, unknown>): Promise<T> => ({ channel, op, fields } as T));
		assert.equal(webSubscriptionsEnabled(), true);
		assert.deepEqual(await webSubscriptionRequest("lh:chatgpt", "status", {}), { channel: "lh:chatgpt", op: "status", fields: {} });
		await assert.rejects(webSubscriptionRequest("lh:subscriptions", "list", {}), CapabilityDeniedError);

		for (const kind of ["research", "demo", "visual", "pdf"] as const) {
			const input = kind === "research" ? { question: "synthetic" } :
				kind === "demo" ? { title: "synthetic", brief: "synthetic" } :
					kind === "visual" ? { prompt: "synthetic" } : { path: "/synthetic.pdf", question: "synthetic" };
			const job = { id: `synthetic-${kind}`, kind, chatId: "synthetic-chat", status: "running", input } as JobRecord;
			const updates: JobPatch[] = [];
			let engineCalls = 0;
			const deliveries: string[] = [];
			const runner = createJobRunner({
				chatStore: { listChatIdsByRecency: () => [] } as unknown as ChatStore,
				jobStore: {
					getJob: () => job,
					updateJob: (_id: string, patch: JobPatch) => { updates.push(patch); return job; },
				} as unknown as JobStore,
				deliver: async (steer) => { deliveries.push(steer.content); },
				engineFor: () => { engineCalls++; return undefined; },
			});
			await runner.runJob(job.id);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const reason = new CapabilityDeniedError(kind === "research" ? "remoteResearch" : "generatedJobs").message;
			assert.equal(updates[0]?.error, reason);
			assert.equal(updates.at(-1)?.status, "error");
			assert.ok(updates.at(-1)?.result);
			assert.equal(updates.at(-1)?.delivery?.status, "pending");
			assert.equal(deliveries.length, 1);
			assert.ok(deliveries[0]?.includes(reason));
			assert.equal(engineCalls, 0);
		}
	} finally {
		capabilitiesOverride.current = previous;
	}
});
