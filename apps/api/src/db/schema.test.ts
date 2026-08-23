import { describe, expect, it } from "vitest";
import { documents } from "./schema";

type DocumentInsert = typeof documents.$inferInsert;

describe("documents enums", () => {
  it("category is a closed union at the type level (SPEC §4)", () => {
    const ok: DocumentInsert["category"] = "contract";
    // @ts-expect-error - drizzle's text({ enum }) is type-level only; the DB has
    // no CHECK constraint, so this union is the only guard we get. Enforced by
    // `bun run typecheck`, not by vitest.
    const bad: DocumentInsert["category"] = "invoice";
    expect([ok, bad]).toHaveLength(2);
  });
});
