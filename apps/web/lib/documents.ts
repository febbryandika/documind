import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";

export const CATEGORIES = ["contract", "manual", "procedure", "other"] as const;
export const STATUSES = ["processing", "ready", "failed"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Status = (typeof STATUSES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  contract: "Contract",
  manual: "Manual",
  procedure: "Procedure",
  other: "Other",
};

export const STATUS_LABELS: Record<Status, string> = {
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

// Derived from the Hono route rather than restated, so a change to the API
// response shape surfaces here as a type error instead of a runtime surprise.
// Note this is the JSON-parsed shape: createdAt is a string, not a Date.
export type DocumentSummary = InferResponseType<
  (typeof api.documents)[":id"]["$get"],
  200
>;

export const DEFAULT_LIMIT = 20;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type DocumentListParams = {
  page: number;
  limit: number;
  category?: Category;
  status?: Status;
};

function asOption<T extends string>(
  allowed: readonly T[],
  value: string | null,
): T | undefined {
  return allowed.find((option) => option === value);
}

/**
 * The URL is the single source of truth for the list view, so this is the one
 * place that translates search params into both the query key and the request.
 * Anything unparseable falls back to the default rather than erroring — a
 * hand-edited `?page=abc` should show page 1, not a broken screen.
 */
export function parseListParams(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike,
): DocumentListParams {
  const page = Number(searchParams.get("page"));
  const limit = Number(searchParams.get("limit"));

  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit:
      Number.isInteger(limit) && limit > 0 && limit <= 100
        ? limit
        : DEFAULT_LIMIT,
    category: asOption(CATEGORIES, searchParams.get("category")),
    status: asOption(STATUSES, searchParams.get("status")),
  };
}

// next/navigation's ReadonlyURLSearchParams is not exported as a type in a way
// that is convenient to depend on; this is the only member actually used.
type ReadonlyURLSearchParamsLike = { get(name: string): string | null };

export const documentKeys = {
  all: ["documents"] as const,
  lists: () => [...documentKeys.all, "list"] as const,
  list: (params: DocumentListParams) =>
    [...documentKeys.lists(), params] as const,
  detail: (id: string) => [...documentKeys.all, "detail", id] as const,
};
