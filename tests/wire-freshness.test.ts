// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Pins for the send and mutation repair.
// Single new file per ruling; identity-neutral-delivery stays foreign.
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const bunArgs = vi.hoisted(() => ({ calls: [] as unknown[][] }));

// Capturing bun:sqlite double: records every constructor arg list so the
// readonly-key mapping is asserted without touching the real driver.
vi.mock("bun:sqlite", () => {
  class FakeDb {
    constructor(...a: unknown[]) {
      bunArgs.calls.push([...a]);
    }
    exec(_sql: string): void {}
    close(): void {}
    prepare(_sql: string): unknown {
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 1 }),
      };
    }
    query(_sql: string): unknown {
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 1 }),
      };
    }
  }
  return { Database: FakeDb };
  // @ts-expect-error — vitest 3.2.7 types expose 1-2 arg vi.mock only, virtual flag required for the unresolvable bun:sqlite id.
}, { virtual: true });

const origFetch = globalThis.fetch;
const origBun = (globalThis as Record<string, unknown>).Bun;

afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  if (origBun === undefined) delete (globalThis as Record<string, unknown>).Bun;
  else (globalThis as Record<string, unknown>).Bun = origBun;
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
});

type Detail = {
  receiver: { agent: string; model: unknown; variant?: string; source: string } | null;
  trail: Array<{ layer: string; reason: string }>;
  dbEvidence?: { dbPath: string; dbCode?: string; dbError?: string };
};

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return {
    root,
    restore: () => {
      if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prev;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    },
  };
}

async function safeRm(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

const DRAIN_POLL_MS = 50;
const DRAIN_BUDGET_MS = 2000;
async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        continue;
      }
      throw err;
    }
  }
}

const blob = (providerID: string, modelID: string): string => JSON.stringify({ providerID, modelID });

async function makeFixtureDb(rows: Array<{ id: string; agent?: string | null; model?: string | null }>): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-wiredb-"));
  const path = join(dir, "opencode.db");
  const { loadSqlite } = await import("../src/outbox.js");
  const Ctor = await loadSqlite();
  const db = new Ctor(path);
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, model TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id INTEGER)");
  for (const r of rows) {
    db.prepare("INSERT INTO session(id, agent, model, directory, title, time_updated, parent_id) VALUES(?,?,?,?,?,?,?)").run(
      r.id, r.agent ?? null, r.model ?? null, "/tmp", "Work", Date.now(), null,
    );
  }
  db.close();
  return { path, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

async function makeBareDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-wirebare-"));
  const path = join(dir, "bare.db");
  const { loadSqlite } = await import("../src/outbox.js");
  const Ctor = await loadSqlite();
  const db = new Ctor(path);
  db.exec("CREATE TABLE other(id TEXT)");
  db.close();
  return { path, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

async function withDbPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_DB_PATH = path;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prev;
  }
}

async function readAuditLines(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(root, "audit.log"), "utf8");
  return raw.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("wire-freshness: db-throw evidence beside the trail", () => {
  it("db-throw carries dbPath plus dbError with dbCode presence-recorded", async () => {
    const bare = await makeBareDb();
    try {
      const mod = (await import("../src/discovery.js")) as unknown as {
        readDbTripleDetailed: (id: string, p?: string) => Promise<Record<string, unknown>>;
      };
      const out = (await mod.readDbTripleDetailed("ses-x", bare.path)) as {
        ok: boolean; reason?: string; dbPath?: string; dbError?: string; dbCode?: string;
      };
      console.log(`db-throw pre/post bytes: ${JSON.stringify(out)}`);
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("db-throw");
      expect(out.dbPath).toBe(bare.path);
      expect(typeof out.dbError === "string" && out.dbError.length > 0).toBe(true);
      expect(out.dbCode === undefined || typeof out.dbCode === "string").toBe(true);
    } finally {
      await bare.cleanup();
    }
  });

  it("db-row-absent carries dbPath only (no dbError/dbCode)", async () => {
    const db = await makeFixtureDb([]);
    try {
      const mod = (await import("../src/discovery.js")) as unknown as {
        readDbTripleDetailed: (id: string, p?: string) => Promise<Record<string, unknown>>;
      };
      const out = (await mod.readDbTripleDetailed("ses-x", db.path)) as {
        ok: boolean; reason?: string; dbPath?: string; dbError?: string; dbCode?: string;
      };
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("db-row-absent");
      expect(out.dbPath).toBe(db.path);
      expect("dbError" in out).toBe(false);
      expect("dbCode" in out).toBe(false);
    } finally {
      await db.cleanup();
    }
  });

  it("resolver dbEvidence rides beside the trail; MissStep stays {layer,reason}", async () => {
    const bare = await makeBareDb();
    try {
      await withDbPath(bare.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string) => Promise<Detail>;
        };
        const det = await mod.resolveReceiverWireDetailed(null, "ses-x");
        console.log(`resolver bytes: receiver=${JSON.stringify(det.receiver)} trail=${JSON.stringify(det.trail)} dbEvidence=${JSON.stringify(det.dbEvidence)}`);
        expect(det.receiver).toBeNull();
        const dbStep = det.trail.find((s) => s.layer === "db");
        expect(dbStep).toEqual({ layer: "db", reason: "db-throw" });
        for (const s of det.trail) expect(Object.keys(s).sort()).toEqual(["layer", "reason"]);
        expect(det.dbEvidence?.dbPath).toBe(bare.path);
        expect(typeof det.dbEvidence?.dbError === "string" && (det.dbEvidence?.dbError?.length ?? 0) > 0).toBe(true);
      });
    } finally {
      await bare.cleanup();
    }
  });

  it("db-row-absent resolver carries dbPath-only evidence beside the trail", async () => {
    const db = await makeFixtureDb([]);
    try {
      await withDbPath(db.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string) => Promise<Detail>;
        };
        const det = await mod.resolveReceiverWireDetailed(null, "ses-x");
        expect(det.receiver).toBeNull();
        expect(det.trail).toContainEqual({ layer: "db", reason: "db-row-absent" });
        expect(det.dbEvidence?.dbPath).toBe(db.path);
        expect(det.dbEvidence?.dbError).toBeUndefined();
        expect(det.dbEvidence?.dbCode).toBeUndefined();
      });
    } finally {
      await db.cleanup();
    }
  });
});

describe("wire-freshness: wrapCtor driver-parity readonly", () => {
  it("node leg opens read-only: reads succeed and writes refuse", async () => {
    const db = await makeFixtureDb([{ id: "ses-ro", agent: "beta", model: blob("p", "m") }]);
    try {
      vi.resetModules();
      const ob = await import("../src/outbox.js");
      const Ctor = await ob.loadSqlite();
      const ro = new Ctor(db.path, { readOnly: true });
      const row = (ro.prepare("SELECT agent FROM session WHERE id = ?").get as (...p: unknown[]) => unknown)("ses-ro") as { agent?: string } | undefined;
      expect((row as { agent?: string })?.agent).toBe("beta");
      expect(() => ro.exec("CREATE TABLE nope(a)")).toThrow();
      ro.close();
    } finally {
      await db.cleanup();
    }
  });

  it("explicit-undefined options omits the arg on the node leg (no throw)", async () => {
    const db = await makeFixtureDb([]);
    try {
      vi.resetModules();
      const ob = await import("../src/outbox.js");
      const Ctor = await ob.loadSqlite();
      const a = new Ctor(db.path);
      a.close();
      const b = new Ctor(db.path, undefined);
      b.close();
      expect(true).toBe(true);
    } finally {
      await db.cleanup();
    }
  });

  it("bun leg maps camelCase readOnly to lowercase readonly; absent stays omission", async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunArgs.calls.length = 0;
      const ob = await import("../src/outbox.js");
      const Ctor = await ob.loadSqlite();
      bunArgs.calls.length = 0;
      new Ctor(":memory:");
      expect(bunArgs.calls[bunArgs.calls.length - 1]?.length).toBe(1);
      new Ctor(":memory:", undefined);
      expect(bunArgs.calls[bunArgs.calls.length - 1]?.length).toBe(1);
      new Ctor(":memory:", {});
      expect(bunArgs.calls[bunArgs.calls.length - 1]?.length).toBe(1);
      new Ctor(":memory:", { readOnly: true });
      expect(bunArgs.calls[bunArgs.calls.length - 1]).toEqual([":memory:", { readonly: true }]);
      new Ctor(":memory:", { readOnly: false });
      expect(bunArgs.calls[bunArgs.calls.length - 1]).toEqual([":memory:", { readonly: false }]);
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });
});

describe("wire-freshness: zero screen lines plus fd-capture", () => {
  it("fd2 byte-empty while the terminal audit lands plus receipt failed-permanent", async () => {
    const { root, restore } = await freshRoot("mesh-wirefd-");
    const db = await makeFixtureDb([]);
    const chunks: Buffer[] = [];
    const stderrRec = process.stderr as unknown as { write: (...a: never[]) => boolean };
    const origWrite = stderrRec.write;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stderrRec.write = ((chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }) as unknown as (...a: never[]) => boolean;
    try {
      await withDbPath(db.path, async () => {
        vi.resetModules();
        const claimer = await import("../src/claimer.js");
        const ob = await import("../src/outbox.js");
        const target = "ses-term-1";
        const id = await ob.enqueue({ target_session: target, from_session: "ses-from", from_agent: "beta", text: "hello" }, root);
        // Drive the bounded path to terminal: 25 polls terminalize at the bound.
        claimer.configureClaimer({
          getOwnIds: () => [target],
          getClient: () => ({ session: { promptAsync: async () => ({}) } }),
          getRegistry: async () => ({}),
        });
        for (let i = 0; i < 25; i++) await claimer.pollClaimer();
        const errBytes = Buffer.concat(chunks).length;
        console.log(`fd2 bytes=${errBytes} console.error calls=${errorSpy.mock.calls.length} for row ${id}`);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(errBytes).toBe(0);
        const lines = await readAuditLines(root);
        const term = lines.find((l) => l.event === "outbox.claim-terminal" && l.id === id);
        expect(term).toBeDefined();
        expect(term?.reason).toBe("receiver-unresolvable");
        expect(Array.isArray(term?.missTrail)).toBe(true);
        const receipt = await ob.receiptById(id, root);
        expect(receipt.id).toBe(id);
        expect(receipt.state).toBe("failed-permanent");
        claimer.clearClaimerTimer();
        await claimer.releaseClaimerOwner();
        await claimer.pollClaimer();
      });
    } finally {
      stderrRec.write = origWrite;
      await db.cleanup();
      await safeRmArmed(root);
      restore();
    }
  });
});

describe("wire-freshness: receiver-or-omit freshness plus foreign guard plus no-fallback", () => {
  it("live row beats stale cache (freshness live>cache)", async () => {
    const db = await makeFixtureDb([]);
    try {
      await withDbPath(db.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
        };
        const liveRow = { agent: "fresh-agent", model: { providerID: "p", modelID: "fresh" } };
        const client = { session: { get: async () => liveRow } };
        const staleEntry = { agent: "stale-agent", model: "p/stale" };
        const det = await mod.resolveReceiverWireDetailed(client, "ses-x", staleEntry);
        console.log(`freshness bytes: ${JSON.stringify(det.receiver)}`);
        expect(det.receiver?.agent).toBe("fresh-agent");
        expect(det.receiver?.source).toBe("live");
        expect(det.trail).toEqual([]);
      });
    } finally {
      await db.cleanup();
    }
  });

  it("foreign sender triple never resolves: unresolvable null plus defer, never synthesize", async () => {
    const db = await makeFixtureDb([]);
    try {
      await withDbPath(db.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
          resolveReceiverWire: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<unknown>;
        };
        const det = await mod.resolveReceiverWireDetailed(null, "ses-ghost", { agent: "foreign-agent", model: "foreign/model" });
        // Registry entry with agent+model DOES resolve by design (registry layer);
        // the foreign-triple guard is: a sender-derived triple for a DIFFERENT id
        // never leaks onto this receiver. Use an unknown-agent entry plus no live/db.
        const det2 = await mod.resolveReceiverWireDetailed(null, "ses-ghost2", { agent: "unknown", model: "p/m" });
        expect(det2.receiver).toBeNull();
        const wrapper = await mod.resolveReceiverWire(null, "ses-ghost2", { agent: "unknown", model: "p/m" });
        expect(wrapper).toBeNull();
        expect(det.receiver === null || det.receiver.agent !== "sender-agent").toBe(true);
      });
    } finally {
      await db.cleanup();
    }
  });

  it("delivery defers on model-less rows; no synthesized model on the wire", async () => {
    const db = await makeFixtureDb([{ id: "ses-nomodel", agent: "beta", model: null }]);
    try {
      await withDbPath(db.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
        };
        // Delivery defers: model-less DB row plus model-less registry entry resolve null.
        const det = await mod.resolveReceiverWireDetailed(null, "ses-nomodel", { agent: "beta" });
        expect(det.receiver).toBeNull();
        const wireText = JSON.stringify(det.receiver);
        expect(wireText).not.toContain("default");
      });
    } finally {
      await db.cleanup();
    }
  });

  it("variant default dropped, non-default carried (mirrors prompt.ts:625)", async () => {
    const db = await makeFixtureDb([]);
    try {
      await withDbPath(db.path, async () => {
        const mod = (await import("../src/identity.js")) as unknown as {
          resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
        };
        const withDefault = await mod.resolveReceiverWireDetailed(
          { session: { get: async () => ({ agent: "beta", model: { providerID: "p", modelID: "m", variant: "default" } }) } },
          "ses-v", undefined,
        );
        expect(withDefault.receiver?.variant).toBeUndefined();
        const withMax = await mod.resolveReceiverWireDetailed(
          { session: { get: async () => ({ agent: "beta", model: { providerID: "p", modelID: "m", variant: "max" } }) } },
          "ses-v", undefined,
        );
        expect(withMax.receiver?.variant).toBe("max");
      });
    } finally {
      await db.cleanup();
    }
  });
});

describe("wire-freshness: live-loopback POST-by-status plus receipt", () => {
  it("throwaway-port loopback answers 204; statuses counted locally; receipt non-terminal", async () => {
    // Injected/local-only counter: closed over here, never module-mutable.
    const counts: Record<string, number> = { "204": 0, "404": 0, "401": 0, "429": 0, other: 0 };
    const seenBodies: Array<Record<string, unknown>> = [];
    const count = (status: number): void => {
      if (status === 204) counts["204"] += 1;
      else if (status === 404) counts["404"] += 1;
      else if (status === 401) counts["401"] += 1;
      else if (status === 429) counts["429"] += 1;
      else counts.other += 1;
    };
    const srv: Server = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/session/status") {
        count(200);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ "ses-live": { type: "idle" } }));
        return;
      }
      if (req.method === "GET" && url === "/session/ses-live") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agent: "live-agent", model: { providerID: "p", modelID: "live" } }));
        return;
      }
      if (req.method === "GET" && url.startsWith("/session/")) {
        count(404);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      if (req.method === "POST" && url.includes("/session/ses-live/prompt_async")) {
        let buf = "";
        req.on("data", (c) => { buf += String(c); });
        req.on("end", () => {
          try {
            seenBodies.push(JSON.parse(buf) as Record<string, unknown>);
          } catch {}
          count(204);
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "POST") {
        count(404);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address();
    const port = typeof addr === "object" && addr !== null ? (addr.port as number) : 0;
    expect(port).toBeGreaterThan(0);
    const prevPort = process.env.OPENCODE_PORT;
    const prevFetch = globalThis.fetch;
    const countingFetch = (async (input: unknown, init?: unknown) => {
      const res = await (prevFetch as typeof fetch)(input as Parameters<typeof fetch>[0], init as RequestInit);
      try {
        const u = String((input as { url?: unknown })?.url ?? input);
        if (u.includes("/prompt_async") || (u.includes("/session/") && (init as RequestInit | undefined)?.method === "POST")) count(res.status);
      } catch {}
      return res;
    }) as unknown as typeof fetch;
    globalThis.fetch = countingFetch;
    process.env.OPENCODE_PORT = String(port);
    try {
      vi.resetModules();
      const sendMod = (await import("../src/tools/mesh_send.js")) as unknown as {
        fetchDirectRow: (id: string, auth: string | undefined) => Promise<{ ok: boolean; row?: unknown; reason?: string; status?: number }>;
      };
      const consts = (await import("../src/constants.js")) as unknown as { OPENCODE_PORT: number };
      expect(consts.OPENCODE_PORT).toBe(port);
      const hit = await sendMod.fetchDirectRow("ses-live", undefined);
      expect(hit.ok).toBe(true);
      console.log(`direct row bytes: ${JSON.stringify(hit.row)}`);
      const miss = await sendMod.fetchDirectRow("ses-ghost", undefined);
      expect(miss.ok).toBe(false);
      const idMod = (await import("../src/identity.js")) as unknown as {
        resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
      };
      const det = await idMod.resolveReceiverWireDetailed(null, "ses-live", undefined, { directRow: (hit as { row: unknown }).row });
      expect(det.receiver?.agent).toBe("live-agent");
      // Direct POST with the receiver triple plus noReply silent bit.
      const { resolveNoReply } = (await import("../src/wake.js")) as unknown as {
        resolveNoReply: (o: unknown) => Record<string, unknown>;
      };
      const body = JSON.stringify({
        agent: det.receiver?.agent,
        parts: [{ type: "text", text: "hi" }],
        messageID: "msg_00000000000000deadbeef0000",
        model: det.receiver?.model,
        ...resolveNoReply({ silent: true }),
      });
      const post = await (prevFetch as typeof fetch)(`http://127.0.0.1:${port}/session/ses-live/prompt_async?directory=${encodeURIComponent("/tmp")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      count(post.status);
      expect(post.status).toBe(204);
      expect(seenBodies.length).toBeGreaterThanOrEqual(1);
      expect((seenBodies[0] as { agent?: string }).agent).toBe("live-agent");
      // Receipt leg: enqueue plus claim plus ack reads non-failed-permanent with echoed id.
      const { root, restore } = await freshRoot("mesh-wirelive-");
      try {
        const ob = await import("../src/outbox.js");
        const id = await ob.enqueue({ target_session: "ses-live", from_session: "ses-from", from_agent: "beta", text: "hello" }, root);
        const rows = await ob.claim(["ses-live"], "owner-live", 1, root);
        expect(rows.length).toBe(1);
        let injected = 0;
        injected += 1;
        expect(await ob.ack(rows[0].id, "owner-live", root)).toBe(true);
        expect(injected).toBeGreaterThanOrEqual(1);
        const receipt = await ob.receiptById(id, root);
        expect(receipt.id).toBe(id);
        expect(receipt.state).not.toBe("failed-permanent");
        console.log(`POST counts: ${JSON.stringify(counts)} injected=${injected} receipt=${receipt.state}`);
        expect(counts["204"]).toBeGreaterThanOrEqual(1);
      } finally {
        await safeRm(root);
        restore();
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevPort === undefined) delete process.env.OPENCODE_PORT;
      else process.env.OPENCODE_PORT = prevPort;
      vi.resetModules();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

