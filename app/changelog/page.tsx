import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { MessageResponse } from "@/components/ai-elements/message";

export const dynamic = "force-dynamic";

const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");

export default function ChangelogPage() {
	return (
		<main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
			<Link
				href="/"
				className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				← Back to app
			</Link>
			<article className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-8">
				<MessageResponse mode="static">{changelog}</MessageResponse>
			</article>
		</main>
	);
}
