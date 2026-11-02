import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-context-"));
process.env.LH_DATA_DIR = DATA_DIR;
process.env.OPENROUTER_API_KEY ??= "test-context-key-presence-gate";

const [{ stores }, { handleChatRequest }, { createTeacherAgent }, learnerService, turnRuns] = await Promise.all([
	import("../src/server/stores.ts"),
	import("../src/server/chat-handler.ts"),
	import("../src/agent/teacher-agent.ts"),
	import("../src/server/learner.ts"),
	import("../src/server/turn-runs.ts"),
]);

test.after(() => {
	fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("learner context is projected for another chat and injected only into the model request", async () => {
	const source = stores.chatStore.createChat("Source assessment");
	stores.chatStore.saveMessages(source.id, [{
		id: "source-result",
		role: "toolResult",
		toolCallId: "source-call",
		toolName: "quiz",
		content: [],
		details: {
			kind: "quiz",
			questionText: "SOURCE_EVIDENCE_SENTINEL",
			correct: false,
			dontKnow: false,
			gradingProvenance: "deterministic",
			answeredAt: "2026-03-01T00:00:00.000Z",
		},
		isError: false,
		timestamp: Date.parse("2026-03-01T00:00:00.000Z"),
	}]);

	const read = stores.learnerProfileStore.read();
	assert.equal(read.state, "absent");
	stores.learnerProfileStore.replace({
		background: "PROFILE_CONTEXT_SENTINEL",
		coursework: "Current coursework",
		topics: [],
		excerpts: [],
		associations: [],
	}, 0);

	const current = stores.chatStore.createChat("Current session");
	stores.chatStore.saveSettings(current.id, {
		model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
	});

	const contextForSource = learnerService.learnerContextFor(source.id);
	assert.match(contextForSource ?? "", /PROFILE_CONTEXT_SENTINEL/);
	assert.doesNotMatch(contextForSource ?? "", /Source assessment · choice · incorrect · auto-graded/);
	const contextForCurrent = learnerService.learnerContextFor(current.id);
	assert.match(contextForCurrent ?? "", /PROFILE_CONTEXT_SENTINEL/);
	assert.match(contextForCurrent ?? "", /Source assessment · choice · incorrect · auto-graded/);

	let modelMessages: Array<{ role: string; content: unknown }> = [];
	const faux = createFauxCore({});
	faux.setResponses([
		(context) => {
			modelMessages = context.messages as Array<{ role: string; content: unknown }>;
			return fauxAssistantMessage([fauxText("Synthetic context response.")]);
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	let buildOptions: Parameters<typeof createTeacherAgent>[1] | undefined;
	const request = new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId: current.id, input: { type: "text", text: "Continue the lesson." } }),
	});
	const ack = await handleChatRequest(request, (options) => {
		buildOptions = options;
		const agent = createTeacherAgent(undefined, { ...options, engine });
		assert.doesNotMatch(agent.state.systemPrompt, /PROFILE_CONTEXT_SENTINEL|SOURCE_EVIDENCE_SENTINEL/);
		return agent;
	});
	assert.equal(ack.status, 200);
	const handle = turnRuns.runningTurn(current.id);
	assert.ok(handle);
	await new Response(handle.subscribe()).text();

	assert.equal(modelMessages[0]?.role, "user");
	assert.match(JSON.stringify(modelMessages[0]?.content), /PROFILE_CONTEXT_SENTINEL/);
	assert.match(JSON.stringify(modelMessages[0]?.content), /Source assessment · choice · incorrect · auto-graded/);
	assert.ok(buildOptions?.learnerContext);
	assert.ok(!JSON.stringify(buildOptions?.messages).includes("PROFILE_CONTEXT_SENTINEL"));
	const persisted = stores.chatStore.getChat(current.id)?.messages ?? [];
	assert.ok(!JSON.stringify(persisted).includes("PROFILE_CONTEXT_SENTINEL"));
	assert.ok(!JSON.stringify(persisted).includes("Source assessment · choice · incorrect · auto-graded"));
});
