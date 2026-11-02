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
