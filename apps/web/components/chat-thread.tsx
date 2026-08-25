"use client";

import { useChat } from "@ai-sdk/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { SourceChips } from "@/components/source-chips";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/hooks/use-messages";
import { messageKeys, type ChatMessage } from "@/lib/chat";
// Type-only, like AppType: the API owns the shape of the data-sources part
// (SPEC §5). A value import here would break the two-deploy split.
import type { DocumentUIMessage } from "@api/index";

// Mirrors askBody in apps/api/src/routes/chat.ts so the user finds out before
// the round trip. The API still re-validates.
const schema = z.object({
  question: z
    .string()
    .trim()
    .min(1, { error: "Ask a question first" })
    .max(1000, { error: "Questions are limited to 1000 characters" }),
});

type Values = z.infer<typeof schema>;

/** Concatenate the text parts of a message; sources live in their own part. */
function textOf(message: DocumentUIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Stored rows become the same part shape the stream produces — sources first,
 * then text — so one renderer covers both a live answer and a reloaded one,
 * and citation chips survive a refresh.
 */
function toUIMessages(rows: ChatMessage[]): DocumentUIMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: [
      ...(row.sources && row.sources.length > 0
        ? [{ type: "data-sources" as const, data: row.sources }]
        : []),
      { type: "text" as const, text: row.content },
    ],
  }));
}

export function ChatThread({ documentId }: { documentId: string }) {
  const { data, isPending, isError, error } = useMessages(documentId);

  // useChat takes `messages` as a seed at mount only, so the thread has to be
  // loaded before the panel exists rather than synced into it afterwards.
  if (isPending) return <Skeleton className="h-24 w-full" />;

  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    );
  }

  return <ChatPanel documentId={documentId} history={data} />;
}

function ChatPanel({
  documentId,
  history,
}: {
  documentId: string;
  history: ChatMessage[];
}) {
  const queryClient = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<DocumentUIMessage>({
        // Not the hc client: useChat needs a URL it can stream from, and the
        // typed RPC client is for JSON responses.
        api: `${process.env.NEXT_PUBLIC_API_URL}/documents/${documentId}/chat`,
        // The Better Auth session is an httpOnly cookie on another origin
        // (SPEC §14); without this the request arrives unauthenticated.
        credentials: "include",
        // SPEC §3.4 — the route takes { question }. History is deliberately not
        // sent: the server reads the last 6 messages from the database, so the
        // client cannot widen its own context window.
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages.at(-1);
          return { body: { question: last ? textOf(last) : "" } };
        },
      }),
    [documentId],
  );

  const { messages, sendMessage, status, error } = useChat<DocumentUIMessage>({
    messages: useMemo(() => toUIMessages(history), [history]),
    transport,
    onFinish: () => {
      // The server persisted both rows as the stream ended. Mark the cached
      // thread stale without refetching — useChat already holds the live copy,
      // so this only matters the next time this component mounts.
      void queryClient.invalidateQueries({
        queryKey: messageKeys.thread(documentId),
        refetchType: "none",
      });
    },
  });

  const isBusy = status === "submitted" || status === "streaming";

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { question: "" },
  });

  // On message count, not on the message array: re-running for every token
  // would fight the user's own scrolling all the way down a long answer.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const ask = handleSubmit(({ question }) => {
    void sendMessage({ text: question });
    reset();
  });

  return (
    <div className="flex flex-col gap-4">
      {messages.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Ask a question about this document. Answers are drawn only from its
          pages and cite the page they came from.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {messages.map((message) => (
            <li
              key={message.id}
              className={
                message.role === "user"
                  ? "flex justify-end"
                  : "flex flex-col gap-2"
              }
            >
              {message.role === "user" ? (
                <p className="bg-muted max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
                  {textOf(message)}
                </p>
              ) : (
                message.parts.map((part, index) =>
                  part.type === "data-sources" ? (
                    <SourceChips key={index} sources={part.data} />
                  ) : part.type === "text" ? (
                    <p key={index} className="text-sm whitespace-pre-wrap">
                      {part.text}
                    </p>
                  ) : null,
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {status === "submitted" && (
        <p className="text-muted-foreground text-sm" role="status">
          Searching the document…
        </p>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      )}

      <div ref={endRef} />

      <form onSubmit={ask} noValidate className="flex flex-col gap-2">
        <Textarea
          {...register("question")}
          rows={2}
          placeholder="What are the payment terms?"
          aria-label="Your question"
          aria-invalid={Boolean(errors.question)}
          aria-describedby={errors.question ? "question-error" : undefined}
          disabled={isBusy}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter starts a new line — the convention every
            // chat UI has trained people to expect.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
        />

        {errors.question && (
          <p
            id="question-error"
            role="alert"
            className="text-destructive text-sm"
          >
            {errors.question.message}
          </p>
        )}

        <Button type="submit" disabled={isBusy} className="w-fit">
          <SendIcon aria-hidden />
          {isBusy ? "Answering…" : "Ask"}
        </Button>
      </form>
    </div>
  );
}
