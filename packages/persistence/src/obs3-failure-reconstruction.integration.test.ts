/**
 * OBS-3 Layer A+B — PostgreSQL-backed failure injection + blind reconstruction.
 * Investigator receives only serialized diagnostic records (no scenario IDs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  createDiagnosticContext,
  reconstructFromCapture,
  runWithDiagnosticContextAsync,
  serializeCaptureForInvestigator,
  startDiagnosticCapture,
  type ReconstructionVerdict,
} from "@98plus/diagnostics";
import { PostgresIdentityStore, asTelegramUserId } from "@98plus/identity";
import {
  emptySnapshot,
  type Ban,
  type BanId,
  type Effect,
  type NotificationItemId,
  type ProductSnapshot,
  type StatusNotificationItem,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  makeBan,
  statusItem,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { baselineFromLoadedSnapshot } from "./hybrid-persist.ts";
import { openPostgresPersistence, type PostgresPersistence } from "./postgres-client.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import {
  assertConnectedTestDatabase,
  assertMvp17TestSchemaName,
  assertSafeMvp17TestDatabaseUrl,
} from "./test-database-guard.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const rawDatabaseUrl = process.env.MVP17_TEST_DATABASE_URL;
if (rawDatabaseUrl !== undefined && rawDatabaseUrl.trim().length > 0) {
  assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
}

function applied(snapshot: ProductSnapshot, effects: readonly Effect[]): TransitionResult {
  return {
    outcome: "APPLIED",
    result: "TRANSITION",
    controlState: snapshot.controlState,
    snapshot,
    effects,
    declaredEffects: [],
    traces: [],
    composition: "GLOBAL_THEN_LOCAL",
    error: null,
  };
}

function statusOf(
  ban: Ban,
  role: "SENDER" | "RECEIVER",
  id: string,
  lifecycle: "UNPROCESSED" | "PROCESSED" = "UNPROCESSED",
): StatusNotificationItem {
  return statusItem({
    id: branded<NotificationItemId>(id),
    ownerId: role === "SENDER" ? ban.senderId : ban.receiverId!,
    banId: ban.id,
    role,
    status: "OVERBOARD",
    ...(lifecycle === "PROCESSED"
      ? { lifecycle: { status: "PROCESSED" as const } }
      : { lifecycle: { status: "UNPROCESSED" as const, display: "WAITING" as const } }),
  }) as StatusNotificationItem;
}

function withPriorities(
  snapshot: ProductSnapshot,
  statusItemId: NotificationItemId | null,
): ProductSnapshot {
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      priorities: { statusItemId, timerItemId: null },
      ...(statusItemId === null
        ? {}
        : { activeNotificationItemId: statusItemId }),
    },
  };
}

function pairEffects(ban: Ban, recvId: string, sendId: string): Effect[] {
  return [
    { type: "UPSERT_BAN", ban },
    { type: "UPSERT_NOTIFICATION_ITEM", item: statusOf(ban, "RECEIVER", recvId) },
    { type: "UPSERT_NOTIFICATION_ITEM", item: statusOf(ban, "SENDER", sendId) },
  ];
}

/** Layer B — no scenario name, no expected answer, no DB. */
function blindReconstruct(
  allRecords: readonly import("@98plus/diagnostics").DiagnosticRecord[],
  correlationId: string,
): ReconstructionVerdict {
  const drained = serializeCaptureForInvestigator(
    allRecords.filter((r) => r.correlationId === correlationId),
  );
  return reconstructFromCapture(drained, correlationId);
}

describe.skipIf(!rawDatabaseUrl)("OBS-3 PostgreSQL failure reconstruction (D2–D9, D11)", () => {
  const schema = `mvp17_${randomUUID().replaceAll("-", "")}`;
  let db: PostgresPersistence;
  let capture: ReturnType<typeof startDiagnosticCapture> | null = null;

  beforeAll(async () => {
    const safe = assertSafeMvp17TestDatabaseUrl(rawDatabaseUrl);
    assertMvp17TestSchemaName(schema);
    db = openPostgresPersistence({
      connectionString: safe.connectionString,
      max: 8,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema} -c application_name=mvp17_obs3 -c deadlock_timeout=200`,
    });
    await assertConnectedTestDatabase((sql, params) => db.sql.query(sql, params ?? []), safe);
    await db.sql.query(`CREATE SCHEMA ${schema}`, []);
    await db.sql.query(`SET search_path TO ${schema}`, []);
    await db.applyMigrations();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    assertMvp17TestSchemaName(schema);
    await db.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
    await db.close();
  });

  beforeEach(() => {
    capture = null;
  });
  afterEach(() => {
    capture?.stop();
    capture = null;
  });

  async function identity(label: string): Promise<UserId> {
    const store = new PostgresIdentityStore(db.sql);
    const user = await store.resolveByTelegramUserId(asTelegramUserId(`${label}-${randomUUID()}`));
    return user.userId;
  }

  async function seed(userId: UserId, snapshot: ProductSnapshot) {
    return PersistenceTestKit.postgres(db.sql).installFixtureSnapshot(userId, snapshot);
  }

  async function statusRows(banId: BanId) {
    return db.sql.query<{
      item_id: string;
      owner_id: string;
      role: string;
      lifecycle_status: string;
    }>(
      `SELECT item_id, owner_id, role, lifecycle_status
       FROM notification_items WHERE ban_id = $1 AND kind = 'STATUS'
       ORDER BY role, item_id`,
      [banId],
    );
  }

  async function withIncident<T>(fn: (correlationId: string) => Promise<T>): Promise<{
    result: T;
    verdict: ReconstructionVerdict;
    correlationId: string;
  }> {
    const correlationId = randomUUID();
    capture = startDiagnosticCapture(correlationId);
    const result = await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "persistence", correlationId }),
      () => fn(correlationId),
    );
    const all = capture.stop();
    capture = null;
    const verdict = blindReconstruct(all, correlationId);
    return { result, verdict, correlationId };
  }

  it("D2 repeated E-20 — second action reuses; no duplicate logical pair", async () => {
    const senderId = await identity("d2-s");
    const receiverId = await identity("d2-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban0 = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    let seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban0, status: "OVERBOARD" };

    const first = await withIncident(async () => {
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withEntities(seeded.snapshot, { bans: { [banId]: next } }),
          pairEffects(next, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(first.verdict.transactionOutcome).toBe("committed");
    expect(first.verdict.classification).toBe("OK");
    expect(first.verdict.firstObservableBoundary).toBe("status.materializer");

    seeded = await store.loadProductSnapshot(senderId);
    const second = await withIncident(async () => {
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withEntities(seeded.snapshot, { bans: { [banId]: next } }),
          pairEffects(next, `kr2-${randomUUID()}`, `ks2-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(second.verdict.transactionOutcome).toBe("committed");
    expect(second.verdict.classification).toBe("OK");
    // Second must not invent duplicate failure
    expect(second.verdict.evidence).not.toContain("status.materializer.failed");
    expect((await statusRows(banId)).rows).toHaveLength(2);
  }, 60_000);

  it("D3 sender exists, receiver missing → create receiver / reuse sender", async () => {
    const senderId = await identity("d3-s");
    const receiverId = await identity("d3-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const durableSend = statusOf(ban, "SENDER", `ds-${randomUUID()}`);
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [durableSend.id]: durableSend },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    const store = new PostgresProductStore(db.sql);
    const { verdict } = await withIncident(async () => {
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withEntities(seeded.snapshot, {
            bans: { [banId]: ban },
            notificationItems: { [durableSend.id]: durableSend },
          }),
          pairEffects(ban, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(verdict.classification).toBe("OK");
    expect(verdict.firstObservableBoundary).toBe("status.materializer");
    expect(verdict.transactionOutcome).toBe("committed");
    expect(verdict.summary.toLowerCase()).toMatch(/created|reused/);
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.some((r) => r.item_id === durableSend.id)).toBe(true);
  }, 60_000);

  it("D4 receiver exists, sender missing → create sender / reuse receiver", async () => {
    const senderId = await identity("d4-s");
    const receiverId = await identity("d4-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const durableRecv = statusOf(ban, "RECEIVER", `dr-${randomUUID()}`);
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [durableRecv.id]: durableRecv },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [durableRecv.id]: durableRecv },
      }),
    );
    // Install durable receiver into SQL items table via seed on receiver already done;
    // ensure sender snapshot path materializes missing sender.
    const store = new PostgresProductStore(db.sql);
    // Raw insert path: seed already put item on both if in snapshot — for missing sender only:
    const { verdict } = await withIncident(async () => {
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withEntities(seeded.snapshot, {
            bans: { [banId]: ban },
            notificationItems: { [durableRecv.id]: durableRecv },
          }),
          pairEffects(ban, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(verdict.classification).toBe("OK");
    expect(verdict.transactionOutcome).toBe("committed");
    const rows = await statusRows(banId);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.some((r) => r.role === "SENDER")).toBe(true);
    expect(rows.rows.some((r) => r.item_id === durableRecv.id)).toBe(true);
  }, 60_000);

  it("D5 duplicate durable Status → STATUS_LOGICAL_DUPLICATE + rollback", async () => {
    const senderId = await identity("d5-s");
    const receiverId = await identity("d5-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban } }),
    );
    // Insert two durable STATUS rows with same logical key via SQL.
    const a = `dup-a-${randomUUID()}`;
    const b = `dup-b-${randomUUID()}`;
    for (const itemId of [a, b]) {
      await db.sql.query(
        `INSERT INTO notification_items (
           item_id, owner_id, ban_id, kind, fifo_sequence, lifecycle_status, lifecycle_display, role, status
         ) VALUES ($1, $2, $3, 'STATUS', 1, 'UNPROCESSED', 'WAITING', 'RECEIVER', 'OVERBOARD')`,
        [itemId, receiverId, banId],
      );
    }
    const before = await statusRows(banId);
    expect(before.rows.length).toBeGreaterThanOrEqual(2);
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban, status: "OVERBOARD" };
    const { verdict } = await withIncident(async () => {
      await expect(
        store.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: applied(
            withEntities(seeded.snapshot, { bans: { [banId]: next } }),
            pairEffects(next, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
          ),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ).rejects.toMatchObject({ code: "INVARIANT" });
    });
    expect(verdict.classification).toBe("STATUS_LOGICAL_DUPLICATE");
    expect(verdict.firstObservableBoundary).toBe("status.materializer");
    expect(verdict.transactionOutcome).toBe("rolled_back");
    expect(verdict.limitations.some((l) => l.includes("UNKNOWN"))).toBe(true);
    expect(verdict.rootCauseEstablished).toBe(true); // observed failure established; creator unknown in limitations
    const after = await statusRows(banId);
    expect(after.rows.map((r) => r.item_id).sort()).toEqual(before.rows.map((r) => r.item_id).sort());
  }, 60_000);

  it("D6 Kernel X → durable Y remap committed", async () => {
    const senderId = await identity("d6-s");
    const receiverId = await identity("d6-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const durableY = statusOf(ban, "SENDER", `Y-${randomUUID()}`);
    const durableRecv = statusOf(ban, "RECEIVER", `R-${randomUUID()}`);
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [durableY.id]: durableY, [durableRecv.id]: durableRecv },
      }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [durableY.id]: durableY, [durableRecv.id]: durableRecv },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const kernelX = `X-${randomUUID()}`;
    const { verdict } = await withIncident(async () => {
      const snap = withPriorities(
        withEntities(seeded.snapshot, {
          bans: { [banId]: ban },
          notificationItems: { [durableY.id]: durableY, [durableRecv.id]: durableRecv },
        }),
        branded(kernelX),
      );
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(snap, [
          { type: "UPSERT_BAN", ban },
          {
            type: "UPSERT_NOTIFICATION_ITEM",
            item: statusOf(ban, "SENDER", kernelX),
          },
          {
            type: "UPSERT_NOTIFICATION_ITEM",
            item: statusOf(ban, "RECEIVER", `kr-${randomUUID()}`),
          },
        ]),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(verdict.classification).toBe("OK");
    expect(verdict.evidence).toContain("status.materializer.remapped");
    expect(verdict.transactionOutcome).toBe("committed");
    expect(verdict.summary).toMatch(/remap/i);
    const loaded = await store.loadProductSnapshot(senderId);
    expect(loaded.snapshot.extended.activeNotificationItemId).not.toBe(kernelX);
    const rows = await statusRows(banId);
    expect(rows.rows.some((r) => r.item_id === durableY.id)).toBe(true);
    expect(rows.rows.some((r) => r.item_id === kernelX)).toBe(false);
  }, 60_000);

  it("D7 Session CAS conflict", async () => {
    const senderId = await identity("d7-s");
    const seeded = await seed(senderId, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const store = new PostgresProductStore(db.sql);
    const { verdict } = await withIncident(async () => {
      await expect(
        store.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision + 77,
          result: applied(seeded.snapshot, []),
          appliedRule: { eventId: "E-01", branch: "MAIN" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    });
    expect(verdict.classification).toBe("SESSION_CAS_CONFLICT");
    expect(verdict.firstObservableBoundary).toBe("persistence.cas");
    expect(verdict.evidence).toContain("persistence.cas.conflict");
    expect(verdict.evidence).not.toContain("persistence.transaction.committed");
    expect((await store.loadProductSnapshot(senderId)).revision).toBe(seeded.revision);
  }, 60_000);

  it("D8 rollback after write — no COMMITTED", async () => {
    const senderId = await identity("d8-s");
    const receiverId = await identity("d8-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban0 = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    const store = new PostgresProductStore(db.sql);
    store.failNextWriteAfterBans();
    const next: Ban = { ...ban0, status: "OVERBOARD" };
    const { verdict } = await withIncident(async () => {
      await expect(
        store.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: applied(
            withEntities(seeded.snapshot, { bans: { [banId]: next } }),
            pairEffects(next, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
          ),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        }),
      ).rejects.toBeTruthy();
    });
    expect(verdict.transactionOutcome).toBe("rolled_back");
    expect(verdict.evidence).toContain("persistence.transaction.rolled_back");
    expect(verdict.evidence).not.toContain("persistence.transaction.committed");
    expect((await statusRows(banId)).rows).toHaveLength(0);
    const banRow = await db.sql.query<{ status: string | null }>(
      `SELECT status FROM bans WHERE ban_id = $1`,
      [banId],
    );
    expect(banRow.rows[0]?.status ?? null).toBeNull();
  }, 60_000);

  it("D9 COMMIT then response failure — PG commit verified; HTTP boundary in apps/api suite", async () => {
    const { emitDiagnostic } = await import("@98plus/diagnostics");
    const senderId = await identity("d9-s");
    const receiverId = await identity("d9-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban0 = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: null,
      acceptance: "PENDING",
    });
    const seeded = await seed(
      senderId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [banId]: ban0 } }),
    );
    const store = new PostgresProductStore(db.sql);
    const next: Ban = { ...ban0, status: "OVERBOARD" };
    const correlationId = randomUUID();
    capture = startDiagnosticCapture(correlationId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "http", correlationId }),
      async () => {
        await store.persistTransition({
          currentUserId: senderId,
          expectedRevision: seeded.revision,
          result: applied(
            withEntities(seeded.snapshot, { bans: { [banId]: next } }),
            pairEffects(next, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
          ),
          appliedRule: { eventId: "E-20", branch: "overboard" },
          baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
        });
        // Transport failure after durable COMMIT (HTTP lifecycle covered in apps/api OBS-3).
        emitDiagnostic({
          eventName: "request.failed",
          source: "http",
          meta: {
            httpPath: "/api/events",
            responseOutcome: "failed",
            persistenceOutcome: "COMMITTED",
            errorMessage: "ECONNRESET after commit",
          },
        });
      },
    );
    const all = capture.stop();
    capture = null;
    const verdict = blindReconstruct(all, correlationId);
    expect(verdict.transactionOutcome).toBe("committed");
    expect(verdict.firstObservableBoundary).toBe("http.request");
    expect(verdict.evidence).toContain("persistence.transaction.committed");
    expect(verdict.evidence).toContain("request.failed");
    expect(verdict.rootCauseEstablished).toBe(false);
    expect((await statusRows(banId)).rows).toHaveLength(2);
  }, 60_000);

  it("D11 PROCESSED Status cleared from priority", async () => {
    const senderId = await identity("d11-s");
    const receiverId = await identity("d11-r");
    const banId = branded<BanId>(`ban-${randomUUID()}`);
    const ban = makeBan({
      id: banId,
      senderId,
      receiverId,
      status: "OVERBOARD",
      acceptance: "PENDING",
    });
    const processed = statusOf(ban, "RECEIVER", `proc-${randomUUID()}`, "PROCESSED");
    const send = statusOf(ban, "SENDER", `send-${randomUUID()}`);
    const baseSnap = withPriorities(
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [processed.id]: processed, [send.id]: send },
      }),
      processed.id,
    );
    const seeded = await seed(senderId, baseSnap);
    await seed(
      receiverId,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        bans: { [banId]: ban },
        notificationItems: { [processed.id]: processed, [send.id]: send },
      }),
    );
    const store = new PostgresProductStore(db.sql);
    const { verdict } = await withIncident(async () => {
      await store.persistTransition({
        currentUserId: senderId,
        expectedRevision: seeded.revision,
        result: applied(
          withPriorities(
            withEntities(seeded.snapshot, {
              bans: { [banId]: ban },
              notificationItems: { [processed.id]: processed, [send.id]: send },
            }),
            processed.id,
          ),
          pairEffects(ban, `kr-${randomUUID()}`, `ks-${randomUUID()}`),
        ),
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      });
    });
    expect(verdict.evidence).toContain("status.priority.cleared");
    expect(verdict.firstObservableBoundary).toBe("status.priority");
    expect(verdict.classification).toBe("OK");
    const loaded = await store.loadProductSnapshot(senderId);
    expect(loaded.snapshot.extended.priorities.statusItemId).not.toBe(processed.id);
    const row = (await statusRows(banId)).rows.find((r) => r.item_id === processed.id);
    expect(row?.lifecycle_status).toBe("PROCESSED");
  }, 60_000);
});
