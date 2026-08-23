"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  STATUSES,
  STATUS_LABELS,
  type DocumentListParams,
} from "@/lib/documents";

// Radix Select has no concept of "no value selected" for a controlled item, so
// the all-documents case needs a real sentinel value in the option list.
const ANY = "any";

export function DocumentFilters({
  params,
  onChange,
}: {
  params: DocumentListParams;
  onChange: (next: Partial<DocumentListParams>) => void;
}) {
  const isFiltered = Boolean(params.category ?? params.status);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={params.category ?? ANY}
        onValueChange={(value) =>
          onChange({
            category:
              value === ANY
                ? undefined
                : (value as DocumentListParams["category"]),
          })
        }
      >
        <SelectTrigger aria-label="Filter by category" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All categories</SelectItem>
          {CATEGORIES.map((category) => (
            <SelectItem key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={params.status ?? ANY}
        onValueChange={(value) =>
          onChange({
            status:
              value === ANY
                ? undefined
                : (value as DocumentListParams["status"]),
          })
        }
      >
        <SelectTrigger aria-label="Filter by status" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All statuses</SelectItem>
          {STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {STATUS_LABELS[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isFiltered && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ category: undefined, status: undefined })}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
