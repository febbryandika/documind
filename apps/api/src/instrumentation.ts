import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

// SPEC §13. Loaded only from the import.meta.main guard in src/index.ts, so the
// vitest suites, eval/run.ts and the dump-* scripts never start an exporter —
// `bun run eval` would otherwise push 15 questions of spans on every tuning run.
//
// ai@7 no longer emits OpenTelemetry spans itself (it has no @opentelemetry/*
// dependency at all). It publishes lifecycle events that an integration
// registered via registerTelemetry() turns into spans, which is what
// LangfuseVercelAiSdkIntegration does. SPEC §8's
// `experimental_telemetry: { metadata: { userId, ... } }` no longer typechecks:
// TelemetryOptions has no metadata field in v7. propagateAttributes() at the
// call sites carries userId/sessionId instead.
//
// NodeTracerProvider rather than NodeSDK: the only spans wanted are the ones
// registerTelemetry produces. NodeSDK's auto-instrumentation would trace every
// pg query and http call, and its module patching is the part least likely to
// survive Bun.

// `bun run --hot` re-evaluates modules on save. Registering a second provider
// or a second integration per save would double-export every span, the same
// reason src/db/index.ts caches its pool here.
const cache = globalThis as unknown as { __documindTracing?: boolean };

/**
 * The processor, exported so a caller can force a flush. Undefined when tracing
 * is off, which is the normal state for a fresh clone with no Langfuse keys.
 */
export let spanProcessor: LangfuseSpanProcessor | undefined;

if (!cache.__documindTracing) {
  cache.__documindTracing = true;

  // Absent keys disable tracing rather than failing the boot: someone who has
  // just cloned the repo should still get a working `bun run dev`.
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.log(
      JSON.stringify({
        level: "info",
        message: "Langfuse tracing disabled — LANGFUSE_* keys not set",
      }),
    );
  } else {
    spanProcessor = new LangfuseSpanProcessor();

    new NodeTracerProvider({ spanProcessors: [spanProcessor] }).register();
    registerTelemetry(new LangfuseVercelAiSdkIntegration());

    // Spans are batched. Fly.io sends SIGTERM on deploy and on a scale-down, so
    // without this the last batch — including the trace for whatever request was
    // in flight — is dropped.
    const flush = async () => {
      await spanProcessor?.forceFlush().catch(() => {});
      process.exit(0);
    };
    process.on("SIGTERM", () => void flush());
    process.on("SIGINT", () => void flush());

    console.log(
      JSON.stringify({ level: "info", message: "Langfuse tracing enabled" }),
    );
  }
}
