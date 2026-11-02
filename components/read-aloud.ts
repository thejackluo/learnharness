"use client";

import { useSyncExternalStore } from "react";
import { speechChunks } from "@/src/core";

export interface SpeechVoice {
	voiceURI: string;
	name: string;
	lang: string;
	localService: boolean;
	default: boolean;
}

export interface SpeechHandlers {
	onEnd: () => void;
	onError: () => void;
}

export interface SpeechAdapter {
	voices(): SpeechVoice[];
	speak(text: string, voice: SpeechVoice, handlers: SpeechHandlers): void;
	cancel(): void;
	onVoicesChanged(callback: () => void): () => void;
}

export type ReadAloudSupport = "unsupported" | "noLocalVoice" | "ready";

export interface ReadAloudSnapshot {
	support: ReadAloudSupport;
	voices: readonly SpeechVoice[];
	voiceURI: string | null;
	speakingKey: string | null;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const STORAGE_KEY = "lh:read-aloud-voice";
const UNSUPPORTED_SNAPSHOT: ReadAloudSnapshot = {
	support: "unsupported",
	voices: [],
	voiceURI: null,
	speakingKey: null,
};

function browserStorage(): StorageLike | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.sessionStorage;
	} catch {
		return undefined;
	}
}

function browserLanguage(): string {
	return typeof navigator === "undefined" ? "" : navigator.language ?? "";
}

/** Return a browser-native adapter, or null when Web Speech synthesis is unavailable. */
export function browserSpeechAdapter(): SpeechAdapter | null {
	if (
		typeof window === "undefined" ||
		typeof window.speechSynthesis === "undefined" ||
		typeof SpeechSynthesisUtterance === "undefined"
	) {
		return null;
	}
	const synthesis = window.speechSynthesis;
	return {
		voices: () =>
			synthesis.getVoices().map((voice) => ({
				voiceURI: voice.voiceURI,
				name: voice.name,
				lang: voice.lang,
				localService: voice.localService,
				default: voice.default,
			})),
		speak: (text, voice, handlers) => {
			const nativeVoice = synthesis.getVoices().find((candidate) => candidate.voiceURI === voice.voiceURI && candidate.localService);
			if (!nativeVoice) {
				handlers.onError();
				return;
			}
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.voice = nativeVoice;
			utterance.onend = handlers.onEnd;
			utterance.onerror = handlers.onError;
			synthesis.speak(utterance);
		},
		cancel: () => synthesis.cancel(),
		onVoicesChanged: (callback) => {
			synthesis.addEventListener("voiceschanged", callback);
			return () => synthesis.removeEventListener("voiceschanged", callback);
		},
	};
}

function chooseDefaultVoice(voices: readonly SpeechVoice[]): SpeechVoice | undefined {
	if (!voices.length) return undefined;
	const language = browserLanguage().split("-")[0]?.toLowerCase();
	const matching = language
		? voices.filter((voice) => voice.lang.split("-")[0]?.toLowerCase() === language)
		: [];
	return matching.find((voice) => voice.default) ?? matching[0] ?? voices[0];
}

/** Injectable controller used by the browser singleton and synthetic tests. */
export class ReadAloudController {
	private snapshot: ReadAloudSnapshot;
	private readonly listeners = new Set<() => void>();
	private unsubscribeVoices: (() => void) | undefined;
	private generation = 0;
	private chunks: string[] = [];
	private chunkIndex = -1;
	private runVoiceURI: string | null = null;

	constructor(
		private readonly adapter: SpeechAdapter | null,
		private readonly storage: StorageLike | undefined = browserStorage(),
	) {
		this.snapshot = adapter ? { ...UNSUPPORTED_SNAPSHOT, support: "noLocalVoice" } : UNSUPPORTED_SNAPSHOT;
		this.unsubscribeVoices = undefined;
		if (adapter) {
			this.refreshVoices();
			this.unsubscribeVoices = adapter.onVoicesChanged(() => this.refreshVoices());
		}
	}

	getSnapshot = (): ReadAloudSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private publish(next: ReadAloudSnapshot): void {
		if (
			this.snapshot.support === next.support &&
			this.snapshot.voiceURI === next.voiceURI &&
			this.snapshot.speakingKey === next.speakingKey &&
			this.snapshot.voices === next.voices
		) {
			return;
		}
		this.snapshot = next;
		for (const listener of this.listeners) listener();
	}

	private savedVoiceURI(): string | null {
		try {
			return this.storage?.getItem(STORAGE_KEY) ?? null;
		} catch {
			return null;
		}
	}

	private refreshVoices(): void {
		if (!this.adapter) return;
		const voices = this.adapter.voices().filter((voice) => voice.localService);
		const saved = this.savedVoiceURI();
		const selectedStillExists = voices.some((voice) => voice.voiceURI === this.snapshot.voiceURI);
		const voiceURI = selectedStillExists
			? this.snapshot.voiceURI
			: voices.find((voice) => voice.voiceURI === saved)?.voiceURI ?? chooseDefaultVoice(voices)?.voiceURI ?? null;
		const next: ReadAloudSnapshot = {
			support: voices.length ? "ready" : "noLocalVoice",
			voices,
			voiceURI,
			speakingKey: this.snapshot.speakingKey,
		};
		this.publish(next);
		if (this.snapshot.speakingKey && !voices.some((voice) => voice.voiceURI === this.runVoiceURI)) this.stop();
	}

	selectVoice(voiceURI: string): boolean {
		const voice = this.snapshot.voices.find((candidate) => candidate.voiceURI === voiceURI && candidate.localService);
		if (!voice) return false;
		try {
			this.storage?.setItem(STORAGE_KEY, voice.voiceURI);
		} catch {
			// Voice selection remains available when session storage is blocked.
		}
		this.publish({ ...this.snapshot, voiceURI: voice.voiceURI });
		return true;
	}

	read(key: string, text: string): void {
		this.stop();
		if (!this.adapter || this.snapshot.support !== "ready") return;
		const voice = this.snapshot.voices.find((candidate) => candidate.voiceURI === this.snapshot.voiceURI && candidate.localService);
		const chunks = speechChunks(text);
		if (!voice || !chunks.length) return;

		const generation = this.generation;
		this.chunks = chunks;
		this.chunkIndex = -1;
		this.runVoiceURI = voice.voiceURI;
		this.publish({ ...this.snapshot, speakingKey: key });
		this.speakChunk(generation, 0, voice);
	}

	private speakChunk(generation: number, index: number, voice: SpeechVoice): void {
		if (generation !== this.generation || !this.adapter) return;
		this.chunkIndex = index;
		try {
			this.adapter.speak(this.chunks[index]!, voice, {
				onEnd: () => {
					if (generation !== this.generation || this.chunkIndex !== index) return;
					if (index + 1 < this.chunks.length) {
						this.speakChunk(generation, index + 1, voice);
						return;
					}
					this.generation++;
					this.chunks = [];
					this.chunkIndex = -1;
					this.runVoiceURI = null;
					this.publish({ ...this.snapshot, speakingKey: null });
				},
				onError: () => {
					if (generation === this.generation && this.chunkIndex === index) this.stop();
				},
			});
		} catch {
			if (generation === this.generation && this.chunkIndex === index) this.stop();
		}
	}

	stop(): void {
		this.generation++;
		this.chunks = [];
		this.chunkIndex = -1;
		this.runVoiceURI = null;
		try {
			this.adapter?.cancel();
		} catch {
			// Cancellation must never prevent microphone capture or submission.
		}
		if (this.snapshot.speakingKey) this.publish({ ...this.snapshot, speakingKey: null });
	}

	destroy(): void {
		this.stop();
		this.unsubscribeVoices?.();
		this.listeners.clear();
	}
}

let singleton: ReadAloudController | null = null;

function getController(): ReadAloudController | null {
	if (typeof window === "undefined") return null;
	if (!singleton) {
		singleton = new ReadAloudController(browserSpeechAdapter());
		document.addEventListener("visibilitychange", () => {
			cancelSpeechWhenHidden(document.visibilityState, cancelSpeech);
		});
	}
	return singleton;
}

export function cancelSpeechWhenHidden(visibilityState: string, cancel: () => void): void {
	if (visibilityState === "hidden") cancel();
}

function subscribe(listener: () => void): () => void {
	return getController()?.subscribe(listener) ?? (() => {});
}

function getSnapshot(): ReadAloudSnapshot {
	return getController()?.getSnapshot() ?? UNSUPPORTED_SNAPSHOT;
}

/** Lazily subscribe to browser-local read-aloud state. */
export function useReadAloud(): ReadAloudSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot, () => UNSUPPORTED_SNAPSHOT);
}

export function readSpeech(key: string, text: string): void {
	getController()?.read(key, text);
}

export function selectReadAloudVoice(voiceURI: string): void {
	getController()?.selectVoice(voiceURI);
}

export function cancelSpeech(): void {
	singleton?.stop();
}

export function isSpeaking(): boolean {
	return singleton?.getSnapshot().speakingKey !== null && singleton !== null;
}
