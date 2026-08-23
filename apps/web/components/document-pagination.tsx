"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DocumentPagination({
  page,
  limit,
  total,
  onPageChange,
}: {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  // `total` is a real count from the API, so the last page is knowable rather
  // than inferred from whether the current page came back full.
  const pageCount = Math.max(1, Math.ceil(total / limit));
  if (pageCount === 1) return null;

  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <nav
      aria-label="Document list pages"
      className="flex items-center justify-between gap-4"
    >
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {first}–{last} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeftIcon aria-hidden />
          Previous
        </Button>
        <span className="text-muted-foreground text-sm">
          Page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
        >
          Next
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
