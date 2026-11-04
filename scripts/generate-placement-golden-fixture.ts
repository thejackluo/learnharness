import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { handleChatRequest } from "../src/server/chat-handler.ts";
import type { TurnInput } from "../src/core/input-events.ts";

type ChatBuilder = NonNullable<Parameters<typeof handleChatRequest>[1]>;
const PLACEMENT_FIXTURE_TITLE = "Golden placement nudge fixture";

export interface PlacementGoldenArtifact {
	chatId: string;
	mapId: string;
	chatPath: string;
	mapPath: string;
}

export async function generatePlacementGoldenArtifact(dataDir: string): Promise<PlacementGoldenArtifact> {
	const previousDataDir = process.env.LH_DATA_DIR;
	const previousAuthFile = process.env.LH_AUTH_FILE;
	const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
	let restoreTurnRunner: (() => void) | undefined;
	process.env.LH_DATA_DIR = dataDir;
	process.env.LH_AUTH_FILE = path.join(dataDir, "auth.json");
	process.env.OPENROUTER_API_KEY = "placement-fixture-test-key";

	try {
		const [{ stores }, chatHandler, jobs, turnRuns, teacher] = await Promise.all([
			import("../src/server/stores.ts"),
			import("../src/server/chat-handler.ts"),
			import("../src/server/jobs.ts"),
			import("../src/server/turn-runs.ts"),
			import("../src/agent/teacher-agent.ts"),
		]);
		restoreTurnRunner = () => jobs.setTurnRunner(async (chatId, input) => {
			const response = await chatHandler.handleChatInput(chatId, input);
			await response.arrayBuffer().catch(() => undefined);
			return response.status;
		});

		const quizOne = {
			question: "What is two plus two?",
			options: [{ label: "Four" }, { label: "Five" }],
			correctAnswer: "Four",
			explanation: "Two plus two is four.",
			type: "check",
			nodeId: "addition-two",
			onTarget: true,
		};
		const quizTwo = {
			question: "What is three plus three?",
			options: [{ label: "Six" }, { label: "Seven" }],
			correctAnswer: "Six",
			explanation: "Three plus three is six.",
			type: "check",
			nodeId: "addition-three",
			onTarget: true,
		};
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("quiz", quizOne, { id: "placement-quiz-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Choose the correct answer.")]),
			() => fauxAssistantMessage([fauxText("Correct.")]),
			() => fauxAssistantMessage([fauxToolCall("quiz", quizTwo, { id: "placement-quiz-2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Choose the next answer.")]),
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const buildAgent: ChatBuilder = (opts) =>
			teacher.createTeacherAgent(undefined, { engine, messages: opts.messages, learnerContext: opts.learnerContext });
		const questionCore = await import("../src/core/question-core.ts");

		const map = stores.subjectMapStore.create({
			title: "Synthetic placement fixture map",
			description: "A tiny arithmetic map for deterministic placement coverage.",
			skills: [
				{ id: "addition-two", title: "Adding two", objective: "Explain two plus two", revision: 1 },
				{ id: "addition-three", title: "Adding three", objective: "Explain three plus three", revision: 1 },
			],
			edges: [],
			alternatives: [],
			goals: ["addition-three"],
			retired: [],
		});
		const chat = stores.chatStore.createChat(
			PLACEMENT_FIXTURE_TITLE,
			undefined,
			{ kind: "subject-skill", mapId: map.id, skillId: "addition-two", skillRevision: 1 },
			{
				mapId: map.id,
				maxProbes: 15,
				probes: [
					{ skillId: "addition-two", revision: 1 },
					{ skillId: "addition-three", revision: 1 },
				],
			},
		);
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
		});
		stores.chatStore.saveTree(chat.id, {
			nodes: [
				{ id: "addition-two", title: "Adding two" },
				{ id: "addition-three", title: "Adding three" },
			],
			edges: [],
			version: 1,
		});

		const request = (chatId: string, input: TurnInput) => new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input }),
		});
		const drainTurn = async (chatId: string, input: TurnInput): Promise<number> => {
			const response = await chatHandler.handleChatRequest(request(chatId, input), buildAgent);
			if (response.status !== 200) {
				throw new Error(`Synthetic turn returned ${response.status}: ${await response.text()}`);
			}
			const turn = turnRuns.runningTurn(chatId);
			if (turn) await new Response(turn.subscribe()).arrayBuffer();
			return response.status;
		};

		const wakes: Array<{ chatId: string; input: TurnInput }> = [];
		jobs.setTurnRunner(async (chatId, input) => {
			wakes.push({ chatId, input });
			return drainTurn(chatId, input);
		});

		assert.equal(await drainTurn(chat.id, { type: "text", text: "Start synthetic placement." }), 200);
		const posed = stores.chatStore.getChat(chat.id);
		assert.ok(
			posed?.messages.some((message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "placement-quiz-1"),
			),
			`the fake model posed the first probe: ${JSON.stringify(posed?.messages)}`,
		);
		const options = [{ label: "Four" }, { label: "Five" }];
		const normalized = questionCore.normalizeOptions(options);
		const answer = questionCore.buildAnswer(
			{
				id: "placement-quiz-1",
				kind: "quiz",
				question: quizOne.question,
				mode: "single-select",
				options: normalized,
				correctIndices: questionCore.resolveCorrect(quizOne.correctAnswer, normalized).indices,
				explanation: quizOne.explanation,
				createdAt: new Date().toISOString(),
			},
			{ values: ["Four"] },
		);
		assert.equal(answer.correct, true);
		assert.equal(await drainTurn(chat.id, { type: "answer", toolCallId: "placement-quiz-1", answer }), 200);

		const deadline = Date.now() + 30_000;
		let saved = stores.chatStore.getChat(chat.id);
		while (
			Date.now() < deadline &&
			(!saved?.messages.some((message) => (message as { customType?: string }).customType === "placement-next") ||
				!saved.messages.some((message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && part.id === "placement-quiz-2"),
				) ||
				!saved.messages.some((message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "Choose the next answer."),
				) ||
				!!turnRuns.runningTurn(chat.id))
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			saved = stores.chatStore.getChat(chat.id);
		}
		assert.ok(saved, "the generated placement chat remains readable");
		const nudgeIndex = saved.messages.findIndex(
			(message) => (message as { customType?: string }).customType === "placement-next",
		);
		const nextQuizIndex = saved.messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "placement-quiz-2"),
		);
		assert.ok(
			nudgeIndex >= 0,
			`the handler persisted a placement-next marker; placement=${JSON.stringify(saved.placement)} messages=${JSON.stringify(saved.messages)}`,
		);
		assert.ok(nextQuizIndex > nudgeIndex, "the pump's fresh wake asked the next placement quiz");
		assert.ok(
			wakes.some(
				(wake) =>
					wake.chatId === chat.id &&
					wake.input.type === "steers" &&
					wake.input.steers.some((steer) => (steer as { customType?: string }).customType === "placement-next"),
			),
			"the pump delivered the nudge to this chat's wake turn",
		);
		assert.equal(saved.placement?.probes[0]?.result, "supports");

		return {
			chatId: chat.id,
			mapId: map.id,
			chatPath: path.join(dataDir, "chats", `${chat.id}.json`),
			mapPath: path.join(dataDir, "maps", `${map.id}.json`),
		};
	} finally {
		restoreTurnRunner?.();
		restoreEnv("LH_DATA_DIR", previousDataDir);
		restoreEnv("LH_AUTH_FILE", previousAuthFile);
		restoreEnv("OPENROUTER_API_KEY", previousOpenRouterKey);
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function main(): Promise<void> {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const fixtureChats = path.join(root, "tests", "fixtures", "golden-data", "chats");
	const fixtureMaps = path.join(root, "tests", "fixtures", "golden-data", "maps");
	for (const filename of fs.readdirSync(fixtureChats)) {
		const existing = JSON.parse(fs.readFileSync(path.join(fixtureChats, filename), "utf8")) as { title?: string };
		if (existing.title === PLACEMENT_FIXTURE_TITLE) {
			throw new Error("The placement fixture already exists. Remove its generated chat and map before regenerating.");
		}
	}
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placement-golden-"));
	try {
		const artifact = await generatePlacementGoldenArtifact(scratch);
		const chatDestination = path.join(fixtureChats, path.basename(artifact.chatPath));
		const mapDestination = path.join(fixtureMaps, path.basename(artifact.mapPath));
		if (fs.existsSync(chatDestination) || fs.existsSync(mapDestination)) {
			throw new Error("Generated fixture destination already exists; refusing to overwrite it.");
		}
		fs.mkdirSync(fixtureMaps, { recursive: true });
		fs.copyFileSync(artifact.chatPath, chatDestination);
		fs.copyFileSync(artifact.mapPath, mapDestination);
		console.log(`Added ${path.relative(root, chatDestination)} and ${path.relative(root, mapDestination)}.`);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function isMain(): boolean {
	const entry = process.argv[1];
	return !!entry && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
	void main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
