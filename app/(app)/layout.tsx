import { ActivityProvider } from "@/components/activity-dock";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ServerEventsProvider } from "@/components/server-events";
import { RuntimeProvider } from "@/components/runtime";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { publicRuntime, requireOwnerPage } from "@/src/server";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function PrivateLayout({ children }: { children: ReactNode }) {
	await requireOwnerPage();
	const runtime = publicRuntime();
	return (
		<RuntimeProvider runtime={runtime}>
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
				<UpdateBanner />
			</ServerEventsProvider>
		</RuntimeProvider>
	);
}
