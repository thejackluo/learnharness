import assert from "node:assert/strict";
import test from "node:test";
import {
	ReadAloudController,
	browserSpeechAdapter,
	cancelSpeechWhenHidden,
	type SpeechAdapter,
	type SpeechHandlers,
	type SpeechVoice,
} from "../components/read-aloud.ts";

class FakeSpeechAdapter implements SpeechAdapter {
	calls: Array<{ text: string; voice: SpeechVoice; handlers: SpeechHandlers }> = [];
	cancelled = 0;
	private changed?: () => void;

	constructor(public available: SpeechVoice[]) {}
	voices() { return this.available; }
	speak(text: string, voice: SpeechVoice, handlers: SpeechHandlers) { this.calls.push({ text, voice, handlers }); }
	cancel() { this.cancelled++; }
	onVoicesChanged(callback: () => void) {
		this.changed = callback;
		return () => { this.changed = undefined; };
	}
	emitVoicesChanged() { this.changed?.(); }
}

function voice(voiceURI: string, lang: string, localService = true, isDefault = false): SpeechVoice {
	return { voiceURI, name: voiceURI, lang, localService, default: isDefault };
}

function memoryStorage(initial?: string) {
	const values = new Map<string, string>();
	if (initial) values.set("lh:read-aloud-voice", initial);
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value); },
	};
}

test("controller chooses a matching local default and exposes no remote voices", () => {
	const primary = (typeof navigator === "undefined" ? "en" : navigator.language.split("-")[0]) || "en";
	const adapter = new FakeSpeechAdapter([
		voice("matching-first", `${primary}-GB`),
		voice("matching-default", `${primary}-US`, true, true),
		voice("remote-default", "zz-ZZ", false, true),
	]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	assert.equal(controller.getSnapshot().support, "ready");
	assert.equal(controller.getSnapshot().voiceURI, "matching-default");
	assert.deepEqual(controller.getSnapshot().voices.map((item) => item.voiceURI), ["matching-first", "matching-default"]);
	assert.equal(controller.selectVoice("remote-default"), false);
	controller.destroy();

	const nonmatching = new FakeSpeechAdapter([
		voice("first-local", primary === "zz" ? "yy-ZZ" : "zz-ZZ"),
		voice("later-default", primary === "yy" ? "zz-ZZ" : "yy-ZZ", true, true),
	]);
	const fallback = new ReadAloudController(nonmatching, memoryStorage());
	assert.equal(fallback.getSnapshot().voiceURI, "first-local");
	fallback.destroy();
});

test("saved local selection wins, persists locally, and cannot select a remote voice", () => {
	const adapter = new FakeSpeechAdapter([voice("local-a", "en-US"), voice("local-b", "fr-FR"), voice("remote", "en-US", false)]);
	const storage = memoryStorage("local-b");
	const controller = new ReadAloudController(adapter, storage);
	assert.equal(controller.getSnapshot().voiceURI, "local-b");
	assert.equal(controller.selectVoice("local-a"), true);
	assert.equal(storage.values.get("lh:read-aloud-voice"), "local-a");
	assert.equal(controller.selectVoice("remote"), false);
	assert.equal(controller.getSnapshot().voiceURI, "local-a");
	controller.destroy();
});

test("chunks are spoken sequentially, and completion clears the active key", () => {
	const adapter = new FakeSpeechAdapter([voice("local", "en-US", true, true)]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	controller.read("reply:one", "First sentence. Second sentence!");
	assert.equal(adapter.calls.length, 1);
	assert.equal(adapter.calls[0]!.text, "First sentence.");
	assert.equal(controller.getSnapshot().speakingKey, "reply:one");
	adapter.calls[0]!.handlers.onEnd();
	assert.equal(adapter.calls.length, 2);
	assert.equal(adapter.calls[1]!.text, "Second sentence!");
	adapter.calls[1]!.handlers.onEnd();
	assert.equal(controller.getSnapshot().speakingKey, null);
	controller.destroy();
});

test("cancel, replay, and late callbacks are generation-safe", () => {
	const adapter = new FakeSpeechAdapter([voice("local", "en-US", true, true)]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	controller.read("reply:old", "Old sentence. Old second.");
	const stale = adapter.calls[0]!.handlers;
	controller.stop();
	controller.read("reply:new", "New sentence. Next.");
	stale.onEnd();
	assert.equal(adapter.calls.length, 2);
	assert.equal(controller.getSnapshot().speakingKey, "reply:new");
	adapter.calls[1]!.handlers.onEnd();
	assert.equal(adapter.calls.length, 3);
	adapter.calls[1]!.handlers.onError();
	assert.equal(controller.getSnapshot().speakingKey, "reply:new", "the old chunk's late error is ignored");
	adapter.calls[2]!.handlers.onError();
	assert.equal(controller.getSnapshot().speakingKey, null);
	controller.destroy();
});

test("unsupported and no-local-voice states never invoke speech; voice loss cancels playback", () => {
	const unsupported = new ReadAloudController(null, memoryStorage());
	unsupported.read("reply:x", "Do not speak");
	assert.equal(unsupported.getSnapshot().support, "unsupported");
	unsupported.destroy();

	const adapter = new FakeSpeechAdapter([voice("remote", "en-US", false)]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	controller.read("reply:x", "Do not speak");
	assert.equal(controller.getSnapshot().support, "noLocalVoice");
	assert.equal(adapter.calls.length, 0);
	adapter.available = [voice("local", "en-US", true, true)];
	adapter.emitVoicesChanged();
	controller.read("reply:x", "Now speak.");
	assert.equal(adapter.calls.length, 1);
	adapter.available = [];
	adapter.emitVoicesChanged();
	assert.equal(adapter.calls.length, 1);
	assert.equal(adapter.cancelled > 0, true);
	assert.equal(controller.getSnapshot().speakingKey, null);
	assert.equal(controller.getSnapshot().support, "noLocalVoice");
	controller.destroy();
});

test("late callbacks from a prior generation cannot restart chunks after replay", () => {
	const adapter = new FakeSpeechAdapter([voice("local", "en-US", true, true)]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	controller.read("reply:a", "A first. A second.");
	const staleEnd = adapter.calls[0]!.handlers.onEnd;
	controller.read("reply:b", "B only.");
	staleEnd();
	assert.equal(adapter.calls.length, 2);
	assert.equal(controller.getSnapshot().speakingKey, "reply:b");
	adapter.calls[1]!.handlers.onEnd();
	assert.equal(controller.getSnapshot().speakingKey, null);
	controller.destroy();
});

test("browser adapter is absent without browser speech synthesis and tab hiding cancels only when hidden", () => {
	assert.equal(browserSpeechAdapter(), null);
	let cancellations = 0;
	cancelSpeechWhenHidden("visible", () => cancellations++);
	assert.equal(cancellations, 0);
	cancelSpeechWhenHidden("hidden", () => cancellations++);
	assert.equal(cancellations, 1);
});

test("stopKey cancels only the playback started for that key", () => {
	const adapter = new FakeSpeechAdapter([voice("local", "en-US", true, true)]);
	const controller = new ReadAloudController(adapter, memoryStorage());
	controller.read("prompt:q", "Prompt sentence.");
	controller.stopKey("reply:other");
	assert.equal(controller.getSnapshot().speakingKey, "prompt:q");
	assert.equal(adapter.cancelled, 1, "only read()'s own pre-stop cancelled");
	controller.stopKey("prompt:q");
	assert.equal(controller.getSnapshot().speakingKey, null);
	assert.equal(adapter.cancelled, 2);
	controller.destroy();
});

test("browser adapter speaks only through a local native voice and settles its held utterance", () => {
	const spoken: Array<{ text: string; voice: unknown; onend: (() => void) | null; onerror: (() => void) | null }> = [];
	let cancels = 0;
	const local = { voiceURI: "local", name: "Local", lang: "en-US", localService: true, default: true };
	const remote = { voiceURI: "remote", name: "Remote", lang: "en-US", localService: false, default: false };
	const synthesis = {
		getVoices: () => [local, remote],
		speak: (utterance: (typeof spoken)[number]) => { spoken.push(utterance); },
		cancel: () => { cancels++; },
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	const globals = globalThis as Record<string, unknown>;
	const previous = { window: globals.window, SpeechSynthesisUtterance: globals.SpeechSynthesisUtterance };
	globals.window = { speechSynthesis: synthesis };
	globals.SpeechSynthesisUtterance = class {
		voice: unknown = null;
		onend: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(readonly text: string) {}
	};
	try {
		const adapter = browserSpeechAdapter();
		assert.ok(adapter);
		assert.deepEqual(adapter.voices().map((item) => item.voiceURI), ["local", "remote"]);
		const events: string[] = [];
		const handlers = { onEnd: () => events.push("end"), onError: () => events.push("error") };

		adapter.speak("Remote is refused.", { ...remote }, handlers);
		assert.equal(spoken.length, 0, "a remote voice is never handed to synthesis");
		assert.deepEqual(events, ["error"]);

		adapter.speak("Local chunk.", { ...local }, handlers);
		assert.equal(spoken.length, 1);
		assert.equal(spoken[0]!.text, "Local chunk.");
		assert.equal(spoken[0]!.voice, local);
		spoken[0]!.onend?.();
		assert.deepEqual(events, ["error", "end"]);

		adapter.speak("Cancelled chunk.", { ...local }, handlers);
		adapter.cancel();
		assert.equal(cancels, 1);
		spoken[1]!.onerror?.();
		assert.deepEqual(events, ["error", "end", "error"], "the controller's generation guard owns late errors");
	} finally {
		globals.window = previous.window;
		globals.SpeechSynthesisUtterance = previous.SpeechSynthesisUtterance;
		if (previous.window === undefined) delete globals.window;
		if (previous.SpeechSynthesisUtterance === undefined) delete globals.SpeechSynthesisUtterance;
	}
});
