"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, errorMessage, send } from "@/lib/api";
import {
  documentKeys,
  type Category,
  type DocumentListParams,
} from "@/lib/documents";

type DocumentList = {
  items: unknown[];
  total: number;
};

export function useDocuments(params: DocumentListParams) {
  return useQuery({
    queryKey: documentKeys.list(params),
    queryFn: async ({ signal }) => {
      const res = await send(() =>
        api.documents.$get(
          {
            // The route coerces, so everything goes over the wire as a string.
            // Optional filters are omitted entirely rather than sent as
            // "undefined".
            query: {
              page: String(params.page),
              limit: String(params.limit),
              ...(params.category ? { category: params.category } : {}),
              ...(params.status ? { status: params.status } : {}),
            },
          },
          { init: { signal } },
        ),
      );

      if (!res.ok)
        throw new Error(await errorMessage(res, "Could not load documents"));
      return res.json();
    },
    // Paging swaps the query key, which would otherwise blank the grid on every
    // click. Keeping the previous page visible makes pagination feel instant.
    placeholderData: keepPreviousData,
    // Mirrors useDocument: poll only while something on this page is still
    // ingesting, and return false once nothing is, so a settled list stops its
    // timer entirely rather than polling for the rest of the session.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === "processing")
        ? 2000
        : false,
  });
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: documentKeys.detail(id),
    queryFn: async ({ signal }) => {
      const res = await send(() =>
        api.documents[":id"].$get({ param: { id } }, { init: { signal } }),
      );

      if (res.status === 404) throw new Error("Document not found");
      if (!res.ok)
        throw new Error(await errorMessage(res, "Could not load the document"));
      return res.json();
    },
    // SPEC §8 — poll only while ingest is still running. Returning false stops
    // the timer entirely, so a 'ready' or 'failed' document (or an errored
    // query, where there is no data at all) never schedules another request.
    refetchInterval: (query) =>
      query.state.data?.status === "processing" ? 2000 : false,
    retry: false,
  });
}

export function useUploadDocument() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: { file: File; category: Category }) => {
      // hc switches to multipart automatically once a form value is a File.
      const res = await send(() =>
        api.documents.$post({
          form: { file: input.file, category: input.category },
        }),
      );

      // 202 is the success path here — the row exists, ingest has not run.
      if (!res.ok) throw new Error(await errorMessage(res, "Upload failed"));
      return res.json();
    },
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.setQueryData(documentKeys.detail(document.id), document);
      router.push(`/documents/${document.id}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await send(() =>
        api.documents[":id"].$delete({ param: { id } }),
      );
      if (!res.ok)
        throw new Error(
          await errorMessage(res, "Could not delete the document"),
        );
      return res.json();
    },
    // The only optimistic update in this phase: a delete the user just
    // confirmed should leave the list immediately.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: documentKeys.lists() });
      const snapshot = queryClient.getQueriesData({
        queryKey: documentKeys.lists(),
      });

      queryClient.setQueriesData<DocumentList>(
        { queryKey: documentKeys.lists() },
        (list) =>
          list && {
            ...list,
            items: list.items.filter(
              (item) => (item as { id: string }).id !== id,
            ),
            // Keep total in step or the page count flickers back on refetch.
            total: Math.max(0, list.total - 1),
          },
      );

      return { snapshot };
    },
    onError: (error: Error, _id, context) => {
      for (const [key, data] of context?.snapshot ?? []) {
        queryClient.setQueryData(key, data);
      }
      toast.error(error.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}
