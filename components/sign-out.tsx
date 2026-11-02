"use client";

import { useState } from "react";
import { useRuntime } from "@/components/runtime";

export function SignOut() {
	const runtime = useRuntime();
	const [busy, setBusy] = useState(false);
	if (runtime.mode !== "hosted") return null;

	async function signOut() {
		const confirmed = window.confirm(
			"Signing out closes this browser's live streams. Lessons, imports, and background jobs already running will keep running and may still bill your provider. Stop them first from the activity dock. Sign out?",
		);
		if (!confirmed) return;
		setBusy(true);
		try {
			await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store" });
		} finally {
			window.location.assign("/login");
		}
	}

	return (
		<button type="button" onClick={() => void signOut()} disabled={busy} className="flex items-center rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
			{busy ? "Signing out…" : "Sign out"}
		</button>
	);
}
