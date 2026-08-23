import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Two modules have to be mocked. ../auth reaches ../db and throws without
// DATABASE_URL (vitest runs under node, which does not auto-load .env the way
// Bun does); ../db is mocked because these routes query drizzle directly and
// the point of the suite is the guards, not Postgres. vi.hoisted is required
// because vi.mock is hoisted above the imports.
const { getSession, db } = vi.hoisted(() => ({
  getSession: vi.fn(),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../auth", () => ({ auth: { api: { getSession } } }));
vi.mock("../db", () => ({ db }));

import { documentFilters, documentsRoutes } from "./documents";
import { documents } from "../db/schema";

const app = new Hono().route("/documents", documentsRoutes);

const SESSION = {
  user: { id: "user_1", email: "demo@documind.app", name: "Demo" },
  session: { id: "session_1", userId: "user_1" },
};

const ROW = {
  id: "doc_1",
  filename: "warehouse-safety.pdf",
  category: "manual",
  language: null,
  status: "processing",
  error: null,
  pageCount: null,
  chunkCount: null,
  createdAt: "2026-08-23T00:00:00.000Z",
};

const CHAIN_METHODS = [
  "from",
  "where",
  "orderBy",
  "limit",
  "offset",
  "values",
  "returning",
] as const;

// A mapped type over the literal method names rather than Record<string, …>:
// noUncheckedIndexedAccess only widens index signatures, so this keeps
// `page.offset` non-optional at the call sites below.
type Chain = Promise<unknown> & Record<(typeof CHAIN_METHODS)[number], Mock>;

/**
 * Stands in for drizzle's fluent builder: a thenable whose chain methods each
 * return itself, so `await db.select().from(x).where(y)` resolves to `result`
 * while every call stays assertable.
 */
function chain(result: unknown): Chain {
  const self = Promise.resolve(result) as Chain;
  for (const method of CHAIN_METHODS) self[method] = vi.fn(() => self);
  return self;
}

/** A minimal but genuinely valid PDF part for the upload route. */
function pdf(name = "safety.pdf") {
  return new File(["%PDF-1.7\n%âãÏÓ\n"], name, {
    type: "application/pdf",
  });
}

function upload(file: File, category = "manual") {
  const body = new FormData();
  body.append("file", file);
  body.append("category", category);
  return app.request("/documents", { method: "POST", body });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(SESSION);
});

describe("session guard", () => {
  // SPEC §14 — no route may be reachable without a server-resolved session.
  const routes = [
    ["GET", "/documents"],
    ["POST", "/documents"],
    ["GET", "/documents/doc_1"],
    ["DELETE", "/documents/doc_1"],
  ] as const;

  it.each(routes)(
    "%s %s rejects a request with no session",
    async (method, path) => {
      getSession.mockResolvedValue(null);

      const res = await app.request(path, { method });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    },
  );
});

describe("documentFilters", () => {
  it("always scopes to the session user", () => {
    expect(documentFilters("user_1", {})).toEqual([
      eq(documents.userId, "user_1"),
    ]);
  });

  it("combines category and status on top of the owner filter", () => {
    expect(
      documentFilters("user_1", { category: "manual", status: "ready" }),
    ).toEqual([
      eq(documents.userId, "user_1"),
      eq(documents.category, "manual"),
      eq(documents.status, "ready"),
    ]);
  });

  it("applies either filter on its own", () => {
    expect(documentFilters("user_1", { category: "contract" })).toEqual([
      eq(documents.userId, "user_1"),
      eq(documents.category, "contract"),
    ]);
    expect(documentFilters("user_1", { status: "failed" })).toEqual([
      eq(documents.userId, "user_1"),
      eq(documents.status, "failed"),
    ]);
  });
});

describe("GET /documents", () => {
  function mockList(items: unknown[], total: number) {
    const page = chain(items);
    const counted = chain([{ value: total }]);
    db.select.mockReturnValueOnce(page).mockReturnValueOnce(counted);
    return { page, counted };
  }

  it("returns items with a real total, page and limit", async () => {
    mockList([ROW], 42);

    const res = await app.request("/documents");

    expect(res.status).toBe(200);
    // total comes from the count query, not items.length.
    await expect(res.json()).resolves.toEqual({
      items: [ROW],
      total: 42,
      page: 1,
      limit: 20,
    });
  });

  it("defaults to page 1 with a limit of 20", async () => {
    const { page } = mockList([], 0);

    await app.request("/documents");

    expect(page.limit).toHaveBeenCalledWith(20);
    expect(page.offset).toHaveBeenCalledWith(0);
  });

  it("computes the offset from page and limit", async () => {
    const { page } = mockList([], 0);

    const res = await app.request("/documents?page=3&limit=10");

    expect(res.status).toBe(200);
    expect(page.limit).toHaveBeenCalledWith(10);
    expect(page.offset).toHaveBeenCalledWith(20);
    await expect(res.json()).resolves.toMatchObject({ page: 3, limit: 10 });
  });

  it("scopes both queries to the session user and both filters", async () => {
    const { page, counted } = mockList([], 0);

    await app.request("/documents?category=manual&status=ready");

    // The id comes from the session, never from the request. Comparing against
    // a freshly built condition also pins the combined category + status case.
    const expected = and(
      eq(documents.userId, "user_1"),
      eq(documents.category, "manual"),
      eq(documents.status, "ready"),
    );
    for (const query of [page, counted]) {
      expect(query.where).toHaveBeenCalledTimes(1);
      expect(query.where).toHaveBeenCalledWith(expected);
    }
  });

  it("does not filter on category or status when neither is given", async () => {
    const { page } = mockList([], 0);

    await app.request("/documents");

    expect(page.where).toHaveBeenCalledWith(
      and(eq(documents.userId, "user_1")),
    );
  });

  it.each([
    ["page=0", "/documents?page=0"],
    ["limit=500", "/documents?limit=500"],
    ["limit=0", "/documents?limit=0"],
    ["an unknown category", "/documents?category=nope"],
    ["an unknown status", "/documents?status=done"],
  ])("rejects %s", async (_label, path) => {
    const res = await app.request(path);

    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("POST /documents", () => {
  it("inserts a processing row and responds 202", async () => {
    db.insert.mockReturnValueOnce(chain([ROW]));

    const res = await upload(pdf());

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual(ROW);

    const values = db.insert.mock.results[0]?.value as Chain;
    expect(values.values).toHaveBeenCalledWith({
      userId: "user_1",
      filename: "safety.pdf",
      category: "manual",
    });
  });

  it("defaults the category to other", async () => {
    db.insert.mockReturnValueOnce(chain([ROW]));

    const body = new FormData();
    body.append("file", pdf());
    const res = await app.request("/documents", { method: "POST", body });

    expect(res.status).toBe(202);
    const values = db.insert.mock.results[0]?.value as Chain;
    expect(values.values).toHaveBeenCalledWith(
      expect.objectContaining({ category: "other" }),
    );
  });

  it("rejects a non-PDF content type", async () => {
    const res = await upload(
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    );

    expect(res.status).toBe(415);
    expect(db.insert).not.toHaveBeenCalled();
  });

  // The multipart Content-Type is attacker-controlled, so the magic bytes are
  // what actually decide whether this is a PDF.
  it("rejects a file that claims to be a PDF but is not", async () => {
    const res = await upload(
      new File(["MZ not a pdf"], "payload.pdf", {
        type: "application/pdf",
      }),
    );

    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({
      error: "That file is not a PDF",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects an upload larger than 10MB before parsing the body", async () => {
    const res = await app.request("/documents", {
      method: "POST",
      // Content-Length is enough: the cap has to bite before parseBody buffers.
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(11 * 1024 * 1024),
      },
      body: "--x--",
    });

    expect(res.status).toBe(413);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a request with no file part", async () => {
    const body = new FormData();
    body.append("category", "manual");

    const res = await app.request("/documents", { method: "POST", body });

    expect(res.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects an unknown category", async () => {
    const res = await upload(pdf(), "invoice");

    expect(res.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("GET /documents/:id", () => {
  it("returns the document when the session user owns it", async () => {
    db.select.mockReturnValueOnce(chain([ROW]));

    const res = await app.request("/documents/doc_1");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ROW);
  });

  // Asserting only that an empty result 404s would still pass if the userId
  // condition were dropped, so the where clause itself is pinned here.
  it("filters on the session user as well as the id", async () => {
    const query = chain([ROW]);
    db.select.mockReturnValueOnce(query);

    await app.request("/documents/doc_1");

    expect(query.where).toHaveBeenCalledWith(
      and(eq(documents.id, "doc_1"), eq(documents.userId, "user_1")),
    );
  });

  // A row owned by someone else must be indistinguishable from a missing one.
  it("404s a document owned by another user", async () => {
    db.select.mockReturnValueOnce(chain([]));

    const res = await app.request("/documents/someone-elses-doc");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("DELETE /documents/:id", () => {
  it("deletes a document the session user owns", async () => {
    db.delete.mockReturnValueOnce(chain([{ id: "doc_1" }]));

    const res = await app.request("/documents/doc_1", { method: "DELETE" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "doc_1" });
  });

  // Same reasoning as the GET above: an unscoped delete would wipe another
  // user's row and still return 200, so the where clause is the real guard.
  it("filters on the session user as well as the id", async () => {
    const query = chain([{ id: "doc_1" }]);
    db.delete.mockReturnValueOnce(query);

    await app.request("/documents/doc_1", { method: "DELETE" });

    expect(query.where).toHaveBeenCalledWith(
      and(eq(documents.id, "doc_1"), eq(documents.userId, "user_1")),
    );
  });

  it("404s instead of deleting another user's document", async () => {
    db.delete.mockReturnValueOnce(chain([]));

    const res = await app.request("/documents/someone-elses-doc", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });
});
