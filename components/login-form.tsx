"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

function safeNext(value: string | undefined): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
	return value;
}

export function LoginForm({ next }: { next?: string }) {
	const [passphrase, setPassphrase] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const errorRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ passphrase }),
				cache: "no-store",
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({})) as { error?: string };
				setError(data.error ?? "Sign-in failed.");
				return;
			}
			window.location.assign(safeNext(next));
		} catch {
			setError("Sign-in failed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
			<label htmlFor="owner-passphrase" className="text-sm font-medium">Owner passphrase</label>
			<input
				autoComplete="current-password"
				autoFocus
				id="owner-passphrase"
				name="passphrase"
				onChange={(event) => setPassphrase(event.currentTarget.value)}
				required
				type="password"
				value={passphrase}
				className="rounded-md border bg-background px-3 py-2"
			/>
			{error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-destructive">{error}</p>}
			<button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-60">
				{busy ? "Signing in…" : "Sign in"}
			</button>
		</form>
	);
}
