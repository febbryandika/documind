import { hc } from "hono/client";
// SPEC §5 — type-only. A value import from apps/api would break the two-deploy
// split, since the web bundle would then pull in the API's server dependencies.
import type { AppType } from "@api/index";

// credentials: 'include' is what actually sends the httpOnly Better Auth session
// cookie across the origin boundary to the Hono API (SPEC §14).
export const api = hc<AppType>(process.env.NEXT_PUBLIC_API_URL!, {
  init: { credentials: "include" },
});

/**
 * Pull the API's `{ error }` body out of a failed response, with a fallback.
 *
 * Every route answers a failure with `{ error: "<a sentence>" }`, except
 * @hono/zod-validator, whose default 400 is `{ success, error: { issues } }` —
 * an object, not a string. That shape means the request never matched the
 * schema the form already mirrors, so it is unreachable from the UI and the
 * caller's fallback is the better sentence.
 */
export async function errorMessage(res: Response, fallback: string) {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The same job for the chat stream, which cannot use the helper above.
 *
 * useChat goes through DefaultChatTransport, and on a non-2xx that throws
 * `new Error(await response.text())` — so `error.message` is the raw response
 * *body*. Without unwrapping it, a 409 renders in the UI as the literal string
 * `{"error":"This document is not ready yet"}`. A failure that has already
 * started streaming arrives as a plain string instead, from the route's own
 * createUIMessageStream onError, and passes through untouched.
 */
export function explainStreamError(error: Error | undefined, fallback: string) {
  if (!error) return fallback;

  try {
    const body = JSON.parse(error.message) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON: either the server's own onError sentence, or a browser network
    // message like "Failed to fetch", which is not something to show anyone.
  }

  // Everything else is either a sentence this app's own stream onError chose,
  // which should be shown, or a browser network message, which should not.
  return NETWORK_FAILURE.test(error.message) || !error.message
    ? fallback
    : error.message;
}

/**
 * How each browser words "the request never arrived", plus the AI SDK's own
 * wording for a 200 with nothing in it. None of these mean anything to the
 * person reading them.
 */
const NETWORK_FAILURE =
  /failed to fetch|load failed|networkerror|network request failed|response body is empty/i;

/** The API being unreachable, in words rather than a browser exception. */
export const UNREACHABLE =
  "Could not reach the server. Check your connection and try again.";

/**
 * Wrap a call to the typed client so a transport failure — the API down, DNS
 * gone, offline — surfaces as a sentence instead of `TypeError: Failed to
 * fetch`. Only the throw is translated; a non-2xx still comes back as a
 * Response for errorMessage() to read.
 */
export async function send<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    // TanStack Query cancels in-flight requests with an AbortSignal. That is
    // not a failure, and rewriting it would make every navigation look like one.
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new Error(UNREACHABLE);
  }
}
