"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileTextIcon, UploadIcon } from "lucide-react";
import { DocumentCard } from "@/components/document-card";
import { DocumentFilters } from "@/components/document-filters";
import { DocumentPagination } from "@/components/document-pagination";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocuments } from "@/hooks/use-documents";
import {
  DEFAULT_LIMIT,
  parseListParams,
  type DocumentListParams,
  type DocumentSummary,
} from "@/lib/documents";

export function DocumentList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const params = parseListParams(searchParams);
  const { data, isPending, isError, error } = useDocuments(params);

  function updateParams(next: Partial<DocumentListParams>) {
    const merged = { ...params, ...next };
    const query = new URLSearchParams();

    // A filter changed on page 3 would otherwise land on a page that no longer
    // exists, so any change other than paging itself resets to page 1.
    const page = "page" in next ? merged.page : 1;
    if (page > 1) query.set("page", String(page));
    if (merged.limit !== DEFAULT_LIMIT)
      query.set("limit", String(merged.limit));
    if (merged.category) query.set("category", merged.category);
    if (merged.status) query.set("status", merged.status);

    const search = query.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, {
      scroll: false,
    });
  }

  const isFiltered = Boolean(params.category ?? params.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <Button asChild>
          <Link href="/upload">
            <UploadIcon aria-hidden />
            Upload
          </Link>
        </Button>
      </div>

      <DocumentFilters params={params} onChange={updateParams} />

      {isPending ? (
        <ul className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-24 w-full" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : data.items.length === 0 ? (
        <EmptyState isFiltered={isFiltered} onClear={updateParams} />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {(data.items as DocumentSummary[]).map((document) => (
              <li key={document.id}>
                <DocumentCard document={document} />
              </li>
            ))}
          </ul>
          <DocumentPagination
            page={params.page}
            limit={params.limit}
            total={data.total}
            onPageChange={(page) => updateParams({ page })}
          />
        </>
      )}
    </div>
  );
}

// Two genuinely different situations: an account with nothing in it needs a
// call to action, an over-filtered list needs a way back out.
function EmptyState({
  isFiltered,
  onClear,
}: {
  isFiltered: boolean;
  onClear: (next: Partial<DocumentListParams>) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      <FileTextIcon aria-hidden className="text-muted-foreground size-6" />
      {isFiltered ? (
        <>
          <p className="font-medium">No documents match these filters</p>
          <p className="text-muted-foreground text-sm">
            Try a different category or status.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClear({ category: undefined, status: undefined })}
          >
            Clear filters
          </Button>
        </>
      ) : (
        <>
          <p className="font-medium">No documents yet</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Upload a contract, manual or procedure and ask questions about it in
            plain language.
          </p>
          <Button asChild size="sm">
            <Link href="/upload">
              <UploadIcon aria-hidden />
              Upload a document
            </Link>
          </Button>
        </>
      )}
    </div>
  );
}
