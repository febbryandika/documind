"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useDeleteDocument } from "@/hooks/use-documents";

export function DeleteDocumentDialog({
  id,
  filename,
  onDeleted,
  trigger,
}: {
  id: string;
  filename: string;
  onDeleted?: () => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteDocument();

  async function confirm() {
    try {
      await remove.mutateAsync(id);
      setOpen(false);
      onDeleted?.();
    } catch {
      // The hook already surfaced a toast and rolled the optimistic removal
      // back; keeping the dialog open lets the user retry.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this document?</DialogTitle>
          <DialogDescription>
            {filename} and everything extracted from it will be removed. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={remove.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
