// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Per-layer miss reasons beside byte-identical decisions.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
});

type Step = { layer: string; reason: string };
type Detail = {
  receiver: { agent: string; model: unknown; source: string } | null;
  trail: Step[];
};
type IdentityMod = {
  resolveReceiverWire: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<unknown>;
  resolveReceiverWireDetailed: (c: unknown, id: string, e?: unknown, x?: unknown) => Promise<Detail>;
};
type DiscoveryMod = {
  readDbTriple: (id: string, dbPath?: string) => Promise<unknown>;
  readDbTripleDetailed: (id: string, dbPath?: string) => Promise<unknown>;
};
type FetchOutcome = { ok: true; row: unknown } | { ok: false; reason: string; status?: number };
type SendMod = {
  fetchDirectRow: (peerId: string, viaAuth: string | undefined) => Promise<FetchOutcome>;
};

async function loadIdentity(): Promise<IdentityMod> {
  return (await import("../src/identity.js")) as unknown as IdentityMod;
}

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
      if ((code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") && attempt < 2) {
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
      if ((code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        continue;
      }
      throw err;
    }
  }
}

async function drivePolls(n: number): Promise<void> {
  const seam = await import("../plugin/test-seam.js");
  for (let i = 0; i < n; i++) {
    await (seam.pollClaimer as () => Promise<void>)();
  }
}

type DbFixtureRow = { id: string; agent?: string | null; model?: string | null };

const blob = (providerID: string, modelID: string): string => JSON.stringify({ providerID, modelID });

async function makeFixtureDb(rows: DbFixtureRow[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-missdb-"));
  const path = join(dir, "opencode.db");
  const { loadSqlite } = await import("../src/outbox.js");
  const Ctor = await loadSqlite();
  const db = new Ctor(path);
  db.exec(
    "CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, model TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id INTEGER)"
  );
  for (const r of rows) {
    db
      .prepare("INSERT INTO session(id, agent, model, directory, title, time_updated, parent_id) VALUES(?,?,?,?,?,?,?)")
      .run(r.id, r.agent ?? null, r.model ?? null, "/tmp", "Work", Date.now(), null);
  }
  db.close();
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function makeBareDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-missbare-"));
  const path = join(dir, "bare.db");
  const { loadSqlite } = await import("../src/outbox.js");
  const Ctor = await loadSqlite();
  const db = new Ctor(path);
  db.exec("CREATE TABLE other(id TEXT)");
  db.close();
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
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

async function withEmptyDb<T>(fn: () => Promise<T>): Promise<T> {
  const db = await makeFixtureDb([]);
  try {
    return await withDbPath(db.path, fn);
  } finally {
    await db.cleanup();
  }
}

function liveClient(row: unknown): unknown {
  return { session: { get: async () => row } };
}

function throwingClient(): unknown {
  return {
    session: {
      get: async () => {
        throw new Error("loopback gone");
      },
    },
  };
}

function stubFetch(fn: (url: string) => Promise<unknown>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

async function readAuditLines(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(root, "audit.log"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("resolver miss reasons: one cause per it", () => {
  it("live-throw: rejecting session.get records the live throw", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(throwingClient(), "ses-x");
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "live", reason: "live-throw" },
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-absent" },
      ]);
    });
  });

  it("live-miss-parse: unknown agent records the live parse miss", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(
        liveClient({ agent: "unknown", model: { providerID: "p", modelID: "m" } }),
        "ses-x"
      );
      expect(det.receiver).toBeNull();
      expect(det.trail[0]).toEqual({ layer: "live", reason: "live-miss-parse" });
    });
  });

  it("live-miss-parse: empty agent records the live parse miss", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(
        liveClient({ agent: "", model: { providerID: "p", modelID: "m" } }),
        "ses-x"
      );
      expect(det.receiver).toBeNull();
      expect(det.trail[0]).toEqual({ layer: "live", reason: "live-miss-parse" });
    });
  });

  it("live-miss-parse: missing model records the live parse miss", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(liveClient({ agent: "beta" }), "ses-x");
      expect(det.receiver).toBeNull();
      expect(det.trail[0]).toEqual({ layer: "live", reason: "live-miss-parse" });
    });
  });

  it("direct-fetch-miss: loopback 404 records the direct fetch miss", async () => {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const mod = (await import("../src/tools/mesh_send.js")) as unknown as SendMod;
    const out = await mod.fetchDirectRow("ses-x", undefined);
    expect(out).toEqual({ ok: false, reason: "direct-fetch-miss", status: 404 });
  });

  it("direct-fetch-miss: loopback abort records the direct fetch miss", async () => {
    stubFetch(async () => {
      throw new Error("aborted");
    });
    const mod = (await import("../src/tools/mesh_send.js")) as unknown as SendMod;
    const out = await mod.fetchDirectRow("ses-x", undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("direct-fetch-miss");
  });

  it("direct-parse-fail: undecodable 200 body records the direct parse fail", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    const mod = (await import("../src/tools/mesh_send.js")) as unknown as SendMod;
    const out = await mod.fetchDirectRow("ses-x", undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("direct-parse-fail");
  });

  it("direct-parse-fail: unknown-agent loopback row records the direct parse fail", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(null, "ses-x", undefined, {
        directRow: { agent: "unknown", model: { providerID: "p", modelID: "m" } },
      });
      expect(det.receiver).toBeNull();
      expect(det.trail[0]).toEqual({ layer: "direct", reason: "direct-parse-fail" });
    });
  });

  it("db-throw: store without the session table records the db throw", async () => {
    const bare = await makeBareDb();
    try {
      const mod = (await import("../src/discovery.js")) as unknown as DiscoveryMod;
      const out = (await mod.readDbTripleDetailed("ses-x", bare.path)) as { ok: boolean; reason?: string };
      expect(out).toEqual(expect.objectContaining({ ok: false, reason: "db-throw" }));
      expect((out as unknown as { dbPath?: string }).dbPath).toBe(bare.path);
    } finally {
      await bare.cleanup();
    }
  });

  it("db-row-absent: empty session table records the absent row", async () => {
    const db = await makeFixtureDb([]);
    try {
      const mod = (await import("../src/discovery.js")) as unknown as DiscoveryMod;
      const out = (await mod.readDbTripleDetailed("ses-x", db.path)) as { ok: boolean; reason?: string };
      expect(out).toEqual(expect.objectContaining({ ok: false, reason: "db-row-absent" }));
      expect((out as unknown as { dbPath?: string }).dbPath).toBe(db.path);
    } finally {
      await db.cleanup();
    }
  });

  it("db-parse-fail: null agent cell records the db parse fail", async () => {
    const mod = await loadIdentity();
    const db = await makeFixtureDb([{ id: "ses-x", agent: null, model: blob("p", "m") }]);
    try {
      await withDbPath(db.path, async () => {
        const det = await mod.resolveReceiverWireDetailed(null, "ses-x");
        expect(det.receiver).toBeNull();
        expect(det.trail).toEqual([
          { layer: "db", reason: "db-parse-fail" },
          { layer: "registry", reason: "registry-absent" },
        ]);
      });
    } finally {
      await db.cleanup();
    }
  });

  it("db-parse-fail: bad-json model cell records the db parse fail", async () => {
    const mod = await loadIdentity();
    const db = await makeFixtureDb([{ id: "ses-x", agent: "beta", model: "{not-json" }]);
    try {
      await withDbPath(db.path, async () => {
        const det = await mod.resolveReceiverWireDetailed(null, "ses-x");
        expect(det.receiver).toBeNull();
        expect(det.trail).toEqual([
          { layer: "db", reason: "db-parse-fail" },
          { layer: "registry", reason: "registry-absent" },
        ]);
      });
    } finally {
      await db.cleanup();
    }
  });

  it("registry-absent: missing entry records the registry absence", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(null, "ses-x", undefined);
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-absent" },
      ]);
    });
  });

  it("registry-unknown-agent: unknown entry agent records the agent miss", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(null, "ses-x", { agent: "unknown", model: "p/m" });
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-unknown-agent" },
      ]);
    });
  });

  it("registry-no-model: model-less entry records the model miss", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(null, "ses-x", { agent: "beta" });
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-no-model" },
      ]);
    });
  });

  it("claim leg pins the exact full trail with no direct step", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(
        liveClient({ agent: "unknown", model: { providerID: "p", modelID: "m" } }),
        "ses-x",
        undefined
      );
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "live", reason: "live-miss-parse" },
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-absent" },
      ]);
    });
  });

  it("direct leg pins the exact full trail with no live step", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      const det = await mod.resolveReceiverWireDetailed(null, "ses-x", undefined, {
        directRow: { agent: "unknown", model: { providerID: "p", modelID: "m" } },
      });
      expect(det.receiver).toBeNull();
      expect(det.trail).toEqual([
        { layer: "direct", reason: "direct-parse-fail" },
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-absent" },
      ]);
    });
  });
});

describe("resolver wrapper parity: legacy equals detailed receiver on all 10 causes", () => {
  async function parityBoth(args: {
    client: unknown;
    entry?: { agent?: string; model?: string } | null;
    extra?: { directRow?: unknown };
    dbPath?: string;
  }): Promise<{ legacy: unknown; receiver: unknown }> {
    const run = async () => {
      const mod = await loadIdentity();
      const legacy = await mod.resolveReceiverWire(args.client, "ses-parity", args.entry, args.extra);
      const det = await mod.resolveReceiverWireDetailed(args.client, "ses-parity", args.entry, args.extra);
      return { legacy, receiver: det.receiver };
    };
    if (args.dbPath) return withDbPath(args.dbPath, run);
    const db = await makeFixtureDb([]);
    try {
      return await withDbPath(db.path, run);
    } finally {
      await db.cleanup();
    }
  }

  it("parity on live-throw", async () => {
    const { legacy, receiver } = await parityBoth({ client: throwingClient() });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on live-miss-parse", async () => {
    const { legacy, receiver } = await parityBoth({
      client: liveClient({ agent: "unknown", model: { providerID: "p", modelID: "m" } }),
    });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on direct-fetch-miss", async () => {
    const { legacy, receiver } = await parityBoth({ client: null, extra: { directRow: null } });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on direct-parse-fail", async () => {
    const { legacy, receiver } = await parityBoth({
      client: null,
      extra: { directRow: { agent: "unknown", model: { providerID: "p", modelID: "m" } } },
    });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on db-throw", async () => {
    const bare = await makeBareDb();
    try {
      const { legacy, receiver } = await parityBoth({ client: null, dbPath: bare.path });
      expect(legacy).toBeNull();
      expect(receiver).toBeNull();
      expect(legacy).toEqual(receiver);
    } finally {
      await bare.cleanup();
    }
  });

  it("parity on db-row-absent", async () => {
    const { legacy, receiver } = await parityBoth({ client: null });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on db-parse-fail", async () => {
    const db = await makeFixtureDb([{ id: "ses-parity", agent: null, model: blob("p", "m") }]);
    try {
      const { legacy, receiver } = await parityBoth({ client: null, dbPath: db.path });
      expect(legacy).toBeNull();
      expect(receiver).toBeNull();
      expect(legacy).toEqual(receiver);
    } finally {
      await db.cleanup();
    }
  });

  it("parity on registry-absent", async () => {
    const { legacy, receiver } = await parityBoth({ client: null, entry: undefined });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on registry-unknown-agent", async () => {
    const { legacy, receiver } = await parityBoth({ client: null, entry: { agent: "unknown", model: "p/m" } });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });

  it("parity on registry-no-model", async () => {
    const { legacy, receiver } = await parityBoth({ client: null, entry: { agent: "beta" } });
    expect(legacy).toBeNull();
    expect(receiver).toBeNull();
    expect(legacy).toEqual(receiver);
  });
});

describe("resolver pins on pre-existing APIs hold green", () => {
  it("legacy unknown-agent row still reads null", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      expect(await mod.resolveReceiverWire(null, "s", undefined)).toBeNull();
    });
  });

  it("legacy model-less entry still reads null", async () => {
    const mod = await loadIdentity();
    await withEmptyDb(async () => {
      expect(await mod.resolveReceiverWire(null, "s", { agent: "beta" })).toBeNull();
    });
  });

  it("db reader null contract holds on stores without the session table", async () => {
    const bare = await makeBareDb();
    try {
      const mod = (await import("../src/discovery.js")) as unknown as DiscoveryMod;
      expect(await mod.readDbTriple("ses-x", bare.path)).toBeNull();
    } finally {
      await bare.cleanup();
    }
  });
});

describe("audit lines carry build plus the miss trail", () => {
  it("deferred lines carry build plus the full trail", async () => {
    const { root, restore } = await freshRoot("mesh-miss-def-");
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const db = await makeFixtureDb([]);
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = db.path;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const pluginMod = await import("../plugin/opencode-mesh.js");
      const ob = await import("../src/outbox.js");
      const ver = (await import("../src/version.js")) as unknown as Record<string, unknown>;
      expect(typeof ver.BUILD_STAMP).toBe("string");
      const fakeClient = {
        session: {
          status: async () => ({}),
          promptAsync: async () => ({}),
          get: async () => ({ agent: "unknown" }),
        },
      };
      const hooks = await (
        pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>
      )({ client: fakeClient });
      await ob.enqueue(
        { target_session: "ses-miss", from_session: "ses-from", from_agent: "alpha", text: "where are you" },
        root
      );
      await (
        hooks.event as (e: unknown) => Promise<void>
      )({
        event: {
          type: "session.created",
          properties: { info: { id: "ses-miss", directory: "/tmp/x", title: "Work" } },
        },
      });
      await drivePolls(2);
      const lines = (await readAuditLines(root)).filter((l) => l.event === "outbox.claim-deferred");
      expect(lines.length).toBe(2);
      for (const l of lines) {
        expect(l.build).toBe(ver.BUILD_STAMP);
        const trail = l.missTrail as Step[];
        expect(Array.isArray(trail)).toBe(true);
        expect(trail[0]).toEqual({ layer: "live", reason: "live-miss-parse" });
        expect(trail[1]).toEqual({ layer: "db", reason: "db-row-absent" });
        expect(trail[trail.length - 1].layer).toBe("registry");
      }
      await (hooks.dispose as () => Promise<void>)();
      await drivePolls(1);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      await db.cleanup();
      await safeRmArmed(root);
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prevRoot;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      restore();
    }
  });

  it("terminal line plus receipt carry build plus the terminal pair", async () => {
    const { root, restore } = await freshRoot("mesh-miss-term-");
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const db = await makeFixtureDb([]);
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = db.path;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const pluginMod = await import("../plugin/opencode-mesh.js");
      const ob = await import("../src/outbox.js");
      const { OUTBOX_MAX_ATTEMPTS } = await import("../src/constants.js");
      const ver = (await import("../src/version.js")) as unknown as Record<string, unknown>;
      expect(typeof ver.BUILD_STAMP).toBe("string");
      const fakeClient = {
        session: {
          status: async () => ({}),
          promptAsync: async () => ({}),
          get: async () => ({ agent: "unknown" }),
        },
      };
      const hooks = await (
        pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>
      )({ client: fakeClient });
      const rowId = await ob.enqueue(
        { target_session: "ses-miss", from_session: "ses-from", from_agent: "alpha", text: "where are you" },
        root
      );
      await (
        hooks.event as (e: unknown) => Promise<void>
      )({
        event: {
          type: "session.created",
          properties: { info: { id: "ses-miss", directory: "/tmp/x", title: "Work" } },
        },
      });
      await drivePolls(OUTBOX_MAX_ATTEMPTS);
      const lines = (await readAuditLines(root)).filter((l) => l.event === "outbox.claim-terminal");
      expect(lines.length).toBe(1);
      expect(lines[0].build).toBe(ver.BUILD_STAMP);
      const trail = lines[0].missTrail as Step[];
      expect(trail[trail.length - 1].layer).toBe("registry");
      const r = (await ob.receiptById(rowId, root)) as unknown as Record<string, unknown>;
      expect(r.state).toBe("failed-permanent");
      expect(r.reason).toBe("receiver-unresolvable");
      expect(r.build).toBe(ver.BUILD_STAMP);
      expect(r.missLayer).toBe("registry");
      expect(typeof r.missReason).toBe("string");
      await (hooks.dispose as () => Promise<void>)();
      await drivePolls(1);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      await db.cleanup();
      await safeRmArmed(root);
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prevRoot;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      restore();
    }
  });

  it("injected line carries build", async () => {
    const { root, restore } = await freshRoot("mesh-miss-inj-");
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.resetModules();
      const pluginMod = await import("../plugin/opencode-mesh.js");
      const ob = await import("../src/outbox.js");
      const ver = (await import("../src/version.js")) as unknown as Record<string, unknown>;
      expect(typeof ver.BUILD_STAMP).toBe("string");
      const injected: unknown[] = [];
      const fakeClient = {
        session: {
          status: async () => ({ "ses-owned": { type: "idle" } }),
          promptAsync: async (o: unknown) => {
            injected.push(o);
            return {};
          },
          get: async () => ({ agent: "beta", model: { providerID: "myprov", modelID: "my-model" } }),
        },
      };
      const hooks = await (
        pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>
      )({ client: fakeClient });
      const { atomicUpdateRegistry } = await import("../src/registry.js");
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)["ses-owned"] = {
          sessionId: "ses-owned",
          agent: "beta",
          model: "myprov/my-model",
          updatedAt: Date.now(),
        };
      }, root);
      await ob.enqueue(
        { target_session: "ses-owned", from_session: "ses-from", from_agent: "alpha", text: "hello claim" },
        root
      );
      await (
        hooks.event as (e: unknown) => Promise<void>
      )({
        event: {
          type: "session.created",
          properties: { info: { id: "ses-owned", directory: "/tmp/x", agent: "beta", title: "Work" } },
        },
      });
      const seam = await import("../plugin/test-seam.js");
      await (seam.pollClaimer as () => Promise<void>)();
      expect(injected.length).toBe(1);
      const lines = (await readAuditLines(root)).filter((l) => l.event === "outbox.injected");
      expect(lines.length).toBe(1);
      expect(lines[0].build).toBe(ver.BUILD_STAMP);
      await (hooks.dispose as () => Promise<void>)();
      await (seam.pollClaimer as () => Promise<void>)();
    } finally {
      warnSpy.mockRestore();
      await safeRmArmed(root);
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prevRoot;
      restore();
    }
  });
});
