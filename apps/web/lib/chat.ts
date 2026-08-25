import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";

// Derived from the route rather than restated, exactly as DocumentSummary is,
// so a change to the API's message shape surfaces here as a type error. Note
// this is the JSON-parsed shape: createdAt is a string, not a Date.
export type ChatMessage = InferResponseType<
  (typeof api.documents)[":id"]["messages"]["$get"],
  200
>[number];

/** The citation payload behind one chip: which chunk, which page, what it said. */
export type Source = NonNullable<ChatMessage["sources"]>[number];

export const messageKeys = {
  all: ["messages"] as const,
  thread: (documentId: string) =>
    [...messageKeys.all, "thread", documentId] as const,
};
