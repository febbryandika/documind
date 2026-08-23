"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FileTextIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUploadDocument } from "@/hooks/use-documents";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  MAX_UPLOAD_BYTES,
  type Category,
} from "@/lib/documents";

// Mirrors the server guards in apps/api/src/routes/documents.ts so the user
// finds out before the round trip. The API still re-checks — and additionally
// checks the magic bytes, which a client cannot be trusted to do.
const schema = z.object({
  file: z
    .instanceof(File, { error: "Choose a PDF to upload" })
    .refine((file) => file.type === "application/pdf", {
      error: "Only PDF files are accepted",
    })
    .refine((file) => file.size <= MAX_UPLOAD_BYTES, {
      error: "File must be 10MB or smaller",
    }),
  category: z.enum(CATEGORIES),
});

type Values = z.infer<typeof schema>;

const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function UploadForm() {
  const upload = useUploadDocument();
  const [isDragging, setIsDragging] = useState(false);

  const {
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { category: "other" },
  });

  const file = useWatch({ control, name: "file" }) as File | undefined;

  function selectFile(selected: File | undefined) {
    if (!selected) return;
    // A dropped file never passes through the input's change event, so RHF has
    // to be told about it directly.
    setValue("file", selected, { shouldValidate: true });
  }

  function onSubmit(values: Values) {
    upload.mutate({ file: values.file, category: values.category });
  }

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>Upload a document</CardTitle>
        <CardDescription>
          PDF, up to 10MB. Text is extracted so you can ask questions about it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="grid gap-4"
        >
          <div className="grid gap-2">
            <Label htmlFor="file">File</Label>
            {/* The file input is the real control and stays in the a11y tree;
                the label is the drop target and gives click-to-browse for free.
                has-[:focus-visible] surfaces the visually hidden input's focus. */}
            <label
              htmlFor="file"
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                selectFile(event.dataTransfer.files[0]);
              }}
              data-dragging={isDragging}
              data-invalid={!!errors.file}
              className="border-input hover:bg-muted/50 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 data-[invalid=true]:border-destructive data-[dragging=true]:border-ring data-[dragging=true]:bg-muted flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors has-[:focus-visible]:ring-3"
            >
              {file ? (
                <>
                  <FileTextIcon aria-hidden className="size-6" />
                  <span className="max-w-full truncate font-medium">
                    {file.name}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {formatSize(file.size)} · Choose a different file
                  </span>
                </>
              ) : (
                <>
                  <UploadIcon aria-hidden className="size-6" />
                  <span className="font-medium">
                    Drop a PDF here, or click to browse
                  </span>
                  <span className="text-muted-foreground text-sm">
                    Maximum 10MB
                  </span>
                </>
              )}
              <input
                id="file"
                type="file"
                accept="application/pdf"
                className="sr-only"
                aria-invalid={!!errors.file}
                aria-describedby={errors.file ? "file-error" : undefined}
                onChange={(event) => selectFile(event.target.files?.[0])}
              />
            </label>
            {errors.file && (
              <p id="file-error" className="text-destructive text-sm">
                {errors.file.message}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="category">Category</Label>
            {/* Radix Select is controlled, so it cannot use register(). */}
            <Controller
              control={control}
              name="category"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_LABELS[category as Category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <Button type="submit" disabled={upload.isPending}>
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
