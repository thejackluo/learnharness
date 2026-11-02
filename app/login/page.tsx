import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { publicRuntime } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
	const runtime = publicRuntime();
	if (runtime.mode !== "hosted") redirect("/");
	const { next } = await searchParams;
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-6">
			<section aria-labelledby="login-title" className="flex w-full max-w-sm flex-col items-center gap-6">
				<h1 id="login-title" className="text-xl font-semibold">Learning Harness</h1>
				<LoginForm next={next} />
			</section>
		</main>
	);
}
