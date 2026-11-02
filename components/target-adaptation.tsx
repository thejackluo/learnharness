"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adaptationMoveLabel, type TargetAdaptationView } from "@/src/core";

const VIA_LABEL = { linked: "linked by you", tutor: "marked by the tutor" } as const;

/**
 * The session target's advice, exactly as the tutor receives it: the move,
 * why, and the dated sources it rests on. Renders nothing for sessions
 * without a target. Refetches when a turn settles.
 */
export function SessionTargetPanel({ chatId, refreshKey }: { chatId: string; refreshKey?: unknown }) {
	const [view, setView] = useState<TargetAdaptationView | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		let live = true;
		fetch(`/api/chats/${encodeURIComponent(chatId)}/target`, { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error(String(response.status));
				const body = (await response.json()) as { view?: TargetAdaptationView | null };
				if (live) {
					setView(body.view ?? null);
					setError(false);
				}
			})
			.catch(() => {
				if (live) setError(true);
			});
		return () => {
			live = false;
		};
	}, [chatId, refreshKey]);

	if (error) {
		return <p role="status" className="px-6 py-1 text-xs text-muted-foreground" data-testid="target-panel-error">Session target advice is unavailable right now.</p>;
	}
	if (!view) return null;
	const title = view.skill?.title ?? view.target.skillId;
	return (
		<details className="border-b border-border/60 px-6 py-2 text-sm" data-testid="target-panel">
			<summary className="cursor-pointer text-xs text-muted-foreground">
				<span className="font-medium text-foreground">Target: {title}</span>
				{view.mapTitle && <span> · {view.mapTitle}</span>}
				<span data-testid="target-move">
					{" · "}
					{view.advice
						? `Advice: ${adaptationMoveLabel(view.advice.move)}${view.advice.qualified ? " (AI-evaluated support only)" : ""}`
						: "No advice (target not current)"}
				</span>
			</summary>
			<div className="mt-2 flex flex-col gap-2 text-xs">
				<p className="text-muted-foreground">
					Advisory, from the evidence below — not a mastery score. The tutor sees this same summary; what you do in this session outranks it.
				</p>
				<ul className="list-disc pl-5" data-testid="target-rationale">
					{view.rationale.map((line) => <li key={line}>{line}</li>)}
				</ul>
				{view.sample.length > 0 ? (
					<div>
						<p className="font-medium">Evidence for this objective (newest first)</p>
						<ul className="flex flex-col gap-1" data-testid="target-sample">
							{view.sample.map((item) => (
								<li key={item.evidenceId}>
									<time dateTime={item.observedAt}>{item.observedAt.slice(0, 10)}</time>
									{" · "}
									<Link href={`/chat/${encodeURIComponent(item.chatId)}`} className="underline underline-offset-2">{item.chatTitle}</Link>
									{" · "}
									{item.result}
									{" · "}
									{item.provenanceLabel}
									{" · "}
									{item.via.map((via) => VIA_LABEL[via]).join(", ")}
								</li>
							))}
						</ul>
					</div>
				) : view.advice ? (
					<p className="text-muted-foreground">No current observation is attached to this objective.</p>
				) : null}
				{view.unverifiedPrerequisites.length > 0 && (
					<div>
						<p className="font-medium">Prerequisites without unaided supporting evidence</p>
						<ul className="list-disc pl-5">
							{view.unverifiedPrerequisites.map((item) => <li key={item.skillId}>{item.title}: {adaptationMoveLabel(item.advice.move).toLowerCase()}</li>)}
						</ul>
					</div>
				)}
				{view.nextSteps.length > 0 && (
					<div>
						<p className="font-medium">Candidate next steps</p>
						<ul className="list-disc pl-5">
							{view.nextSteps.map((item) => <li key={`${item.goalId}-${item.skillId}`}>{item.title}</li>)}
						</ul>
					</div>
				)}
				<p className="text-muted-foreground" data-testid="target-coverage">
					Read {view.coverage.scannedChats - view.coverage.unreadableChats} of {view.coverage.totalChats} other sessions
					{view.coverage.unreadableChats > 0 ? ` (${view.coverage.unreadableChats} unreadable)` : ""}.{" "}
					<Link href={`/maps/${encodeURIComponent(view.target.mapId)}`} className="underline underline-offset-2">Open map</Link>
				</p>
			</div>
		</details>
	);
}
