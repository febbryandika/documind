import { DocumentDetail } from "@/components/document-detail";

export default async function DocumentDetailPage({
  params,
}: PageProps<"/documents/[id]">) {
  const { id } = await params;

  return <DocumentDetail id={id} />;
}
