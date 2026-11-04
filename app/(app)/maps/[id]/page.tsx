import { SubjectMapEditor } from "@/components/subject-map-editor";

export const dynamic = "force-dynamic";

export default async function SubjectMapPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <SubjectMapEditor mapId={id} />;
}
