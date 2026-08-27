"use client";

import { useQuery } from "@tanstack/react-query";
import { api, errorMessage, send } from "@/lib/api";
import { messageKeys } from "@/lib/chat";

/**
 * The stored thread for one document, oldest-first. This seeds useChat and is
 * never refetched while a question is in flight — the stream is the live view,
 * and the server writes the same two rows back when it finishes.
 */
export function useMessages(documentId: string) {
  return useQuery({
    queryKey: messageKeys.thread(documentId),
    queryFn: async ({ signal }) => {
      const res = await send(() =>
        api.documents[":id"].messages.$get(
          { param: { id: documentId } },
          { init: { signal } },
        ),
      );

      if (!res.ok)
        throw new Error(await errorMessage(res, "Could not load the chat"));
      return res.json();
    },
    // The thread only changes as a result of asking, which this component
    // already knows about. Refetching on focus would fight the stream.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
