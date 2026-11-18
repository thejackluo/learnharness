"use client";

import { useContext, useEffect, useState } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { ChatActionsContext } from "@/components/chat";

const BUTTON = "rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

type MapLinkDetails = {
	mapTitle: string;
	skillTitle: string;
};

type MapDraftDetails = {
	subject: string;
	goal: string;
	framework?: string;
};

type Decision = "accepted" | "dismissed";
type TargetResponse = { mapSuggestions?: Record<string, Decision> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function linkDetails(value: unknown): MapLinkDetails | null {
	if (!isRecord(value) || typeof value.mapTitle !== "string" || typeof value.skillTitle !== "string") return null;
	return { mapTitle: value.mapTitle, skillTitle: value.skillTitle };
}

function draftDetails(value: unknown): MapDraftDetails | null {
	if (!isRecord(value) || typeof value.subject !== "string" || typeof value.goal !== "string") return null;
	if (value.framework !== undefined && typeof value.framework !== "string") return null;
	return {
		subject: value.subject,
		goal: value.goal,
		...(value.framework === undefined ? {} : { framework: value.framework }),
	};
}

function useSuggestionDecision(chatId: string, callId: string) {
	const [decision, setDecision] = useState<Decision | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/target`, { cache: "no-store" })
			.then(async (response) => {
				const body = await response.json().catch(() => ({})) as TargetResponse;
				if (!response.ok) throw new Error("Unable to load map suggestion state.");
				if (live) setDecision(body.mapSuggestions?.[callId]);
			})
			.catch((cause) => {
				if (live) setError(cause instanceof Error ? cause.message : "Unable to load map suggestion state.");
			});
		return () => {
			live = false;
		};
	}, [chatId, callId]);

	const decide = async (next: "accept" | "dismiss") => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/target`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callId, decision: next }),
			});
			const body = await response.json().catch(() => ({})) as TargetResponse & { error?: unknown };
			if (!response.ok) {
				setError(typeof body.error === "string" ? body.error : "Unable to update this map suggestion.");
				return;
			}
			setDecision(body.mapSuggestions?.[callId] ?? (next === "accept" ? "accepted" : "dismissed"));
			window.dispatchEvent(new CustomEvent("lh:chat-target-changed", { detail: { chatId } }));
		} catch {
			setError("Unable to update this map suggestion.");
		} finally {
			setBusy(false);
		}
	};

	return { decision, busy, error, decide };
}

export function MapLinkChip({ part }: ArtifactPartProps) {
	const chat = useContext(ChatActionsContext);
	const details = linkDetails(part.output);
	if (part.state !== "output-available" || !details || !chat?.chatId) return null;
	return <MapLinkChipView chatId={chat.chatId} callId={part.toolCallId} details={details} />;
}

function MapLinkChipView({ chatId, callId, details }: { chatId: string; callId: string; details: MapLinkDetails }) {
	const { decision, busy, error, decide } = useSuggestionDecision(chatId, callId);
	const label = `${details.mapTitle} → ${details.skillTitle}`;
	if (decision === "accepted") return <p className="my-1 text-xs text-muted-foreground">Linked to {label}</p>;
	if (decision === "dismissed") return <p className="my-1 text-xs text-muted-foreground">Not linked</p>;
	return (
		<div className="my-1 flex flex-wrap items-center gap-2 text-xs">
			<span>Use your {details.mapTitle} map → {details.skillTitle}?</span>
			<button type="button" className={BUTTON} disabled={busy} onClick={() => void decide("accept")}>Link</button>
			<button type="button" className={BUTTON} disabled={busy} onClick={() => void decide("dismiss")}>Not now</button>
			{error && <span role="alert" className="text-destructive">{error}</span>}
		</div>
	);
}

export function MapDraftChip({ part }: ArtifactPartProps) {
	const chat = useContext(ChatActionsContext);
	const details = draftDetails(part.output);
	if (part.state !== "output-available" || !details || !chat?.chatId) return null;
	return <MapDraftChipView chatId={chat.chatId} callId={part.toolCallId} details={details} />;
}

function MapDraftChipView({ chatId, callId, details }: { chatId: string; callId: string; details: MapDraftDetails }) {
	const { decision, busy, error, decide } = useSuggestionDecision(chatId, callId);
	if (decision === "dismissed" || decision === "accepted") return null;
	const params = new URLSearchParams({ draftGoal: details.goal });
	if (details.framework !== undefined) params.set("draftFramework", details.framework);
	return (
		<div className="my-1 flex flex-wrap items-center gap-2 text-xs">
			<a className={BUTTON} href={`/maps?${params.toString()}`}>Draft a {details.subject} map?</a>
			<button type="button" className={BUTTON} disabled={busy} onClick={() => void decide("dismiss")}>Not now</button>
			{error && <span role="alert" className="text-destructive">{error}</span>}
		</div>
	);
}
