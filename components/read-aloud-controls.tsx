"use client";

import { SquareIcon, Volume2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDictationActive } from "@/components/dictation-state";
import {
	cancelSpeech,
	readSpeech,
	selectReadAloudVoice,
	useReadAloud,
	type ReadAloudSupport,
} from "@/components/read-aloud";

export function readAloudDisabledReason(state: {
	speech: { key: string; text: string } | null;
	dictationActive: boolean;
	support: ReadAloudSupport;
	disabledReason?: string;
}): string | undefined {
	return (
		state.disabledReason ??
		(!state.speech
			? "No readable text is available."
			: state.dictationActive
				? "Finish dictation first"
				: state.support === "unsupported"
					? "Read-aloud unavailable: this browser does not support speech synthesis"
					: state.support === "noLocalVoice"
						? "Read-aloud unavailable: this browser has no on-device voice"
						: undefined)
	);
}

export function toggleReadAloud(
	speech: { key: string; text: string } | null,
	speakingKey: string | null,
	start: (key: string, text: string) => void = readSpeech,
	stop: () => void = cancelSpeech,
): void {
	if (!speech) return;
	if (speakingKey === speech.key) stop();
	else start(speech.key, speech.text);
}

export function ReadAloudButton({
	speech,
	label,
	disabledReason,
}: {
	speech: { key: string; text: string } | null;
	label: string;
	disabledReason?: string;
}) {
	const state = useReadAloud();
	const dictationActive = useDictationActive();
	const speaking = !!speech && state.speakingKey === speech.key;
	const reason = readAloudDisabledReason({ speech, dictationActive, support: state.support, disabledReason });
	const disabled = !speech || !!disabledReason || dictationActive || state.support !== "ready";

	return (
		<div className="flex items-center gap-2">
			<Button
				type="button"
				variant="outline"
				size="xs"
				disabled={disabled}
				title={disabled ? reason : undefined}
				aria-description={disabled ? reason : undefined}
				aria-label={speaking ? `Stop ${label.toLowerCase()}` : label}
				aria-pressed={speaking}
				onClick={() => toggleReadAloud(speech, state.speakingKey)}
				className="gap-1.5 text-muted-foreground"
			>
				{speaking ? <SquareIcon aria-hidden className="size-3" /> : <Volume2Icon aria-hidden className="size-3" />}
				{speaking ? "Stop" : label}
			</Button>
			{state.voices.length > 1 && (
				<select
					aria-label="Local read-aloud voice"
					title="Local read-aloud voice"
					value={state.voiceURI ?? ""}
					disabled={dictationActive}
					onChange={(event) => selectReadAloudVoice(event.currentTarget.value)}
					className="max-w-40 rounded border bg-background px-2 py-1 text-xs text-muted-foreground"
				>
					{state.voices.map((voice) => (
						<option key={voice.voiceURI} value={voice.voiceURI}>
							{voice.name} ({voice.lang})
						</option>
					))}
				</select>
			)}
		</div>
	);
}
