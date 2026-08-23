"use client";

import Link from "next/link";
import { Trash2Icon } from "lucide-react";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { DocumentStatusBadge } from "@/components/document-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  CATEGORY_LABELS,
  type Category,
  type DocumentSummary,
  type Status,
} from "@/lib/documents";

const dateFormat = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function DocumentCard({ document }: { document: DocumentSummary }) {
  const isFailed = document.status === "failed";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/documents/${document.id}`}
              className="block truncate font-medium underline-offset-4 hover:underline"
              title={document.filename}
            >
              {document.filename}
            </Link>
            <p className="text-muted-foreground mt-1 text-sm">
              {CATEGORY_LABELS[document.category as Category]}
              {" · "}
              {/* pageCount stays null until ingest runs (build-order step 5). */}
              {document.pageCount === null
                ? "Pages pending"
                : `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`}
              {" · "}
              <time dateTime={document.createdAt}>
                {dateFormat.format(new Date(document.createdAt))}
              </time>
            </p>
          </div>
          <DocumentStatusBadge status={document.status as Status} />
        </div>

        {isFailed && (
          <div className="flex items-start justify-between gap-3 border-t pt-3">
            <p className="text-destructive min-w-0 text-sm break-words">
              {document.error ?? "Ingest failed."}
            </p>
            <DeleteDocumentDialog
              id={document.id}
              filename={document.filename}
              trigger={
                <Button variant="destructive" size="sm">
                  <Trash2Icon aria-hidden />
                  Delete
                </Button>
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
