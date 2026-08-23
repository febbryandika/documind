import { Suspense } from "react";
import { DocumentList } from "@/components/document-list";
import { Skeleton } from "@/components/ui/skeleton";

// useSearchParams opts its subtree into client-side rendering, which Next
// requires a Suspense boundary for.
export default function DocumentListPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <DocumentList />
    </Suspense>
  );
}
