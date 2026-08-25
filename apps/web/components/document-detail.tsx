"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { ChatThread } from "@/components/chat-thread";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { DocumentStatusBadge } from "@/components/document-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocument } from "@/hooks/use-documents";
import { CATEGORY_LABELS, type Category, type Status } from "@/lib/documents";

export function DocumentDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: document, isPending, isError, error } = useDocument(id);

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            <ArrowLeftIcon aria-hidden />
            Back to documents
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="w-fit -ml-2.5">
        <Link href="/">
          <ArrowLeftIcon aria-hidden />
          Documents
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className="truncate text-2xl font-semibold tracking-tight"
            title={document.filename}
          >
            {document.filename}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {CATEGORY_LABELS[document.category as Category]}
            {" · "}
            {document.pageCount === null
              ? "Pages pending"
              : `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DocumentStatusBadge status={document.status as Status} />
          <DeleteDocumentDialog
            id={document.id}
            filename={document.filename}
            onDeleted={() => router.push("/")}
            trigger={
              <Button variant="destructive" size="sm">
                <Trash2Icon aria-hidden />
                Delete
              </Button>
            }
          />
        </div>
      </div>

      <Card>
        <CardContent>
          {document.status === "processing" ? (
            // Ingest lands in build-order step 5; until then this is where a
            // freshly uploaded document sits, polling every 2s.
            <p className="text-muted-foreground text-sm">
              Extracting text from this document. The status updates on its own.
            </p>
          ) : document.status === "failed" ? (
            <div className="flex flex-col gap-2">
              <p className="font-medium">
                This document could not be processed
              </p>
              <p className="text-destructive text-sm break-words">
                {document.error ?? "Ingest failed."}
              </p>
              <p className="text-muted-foreground text-sm">
                Delete it and upload the file again.
              </p>
            </div>
          ) : (
            <ChatThread documentId={document.id} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
