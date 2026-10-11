import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  beginDiagnosticCapture,
  createCorrelationId,
  createDiagnosticContext,
  endDiagnosticCapture,
  runWithDiagnosticContext,
  setDiagnosticSink,
  classifyPersistenceError,
} from "@98plus/diagnostics";
import {
  emptySnapshot,
  type Ban,
  type BanId,
  type NotificationItemId,
  type StatusNotificationItem,
  type UserId,
} from "@98plus/product-model";
import {
  branded,
  makeBan,
  statusItem,
  withControlState,
  withEntities,
} from "../../product-model/src/kernel.fixtures.ts";
import { InMemoryProductStore } from "./in-memory-store.ts";
import { materializeStatusPairs } from "./status-materializer.ts";
import { PersistenceError } from "./errors.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import { baselineFromLoadedSnapshot } from "./hybrid-persist.ts";

const SENDER = branded<UserId>("obs2-sender");
const RECEIVER = branded<UserId>("obs2-receiver");
const BAN_ID = branded<BanId>("obs2-ban");

function ban(status: Ban["status"] = "OVERBOARD"): Ban {
  return makeBan({
    id: BAN_ID,
    senderId: SENDER,
    receiverId: RECEIVER,
    status,
    acceptance: "PENDING",
  });
}

describe("OBS-2 persistence / materializer diagnostics", () => {
  beforeEach(() => {
    beginDiagnosticCapture();
    setDiagnosticSink(() => undefined);
  });
  afterEach(() => {
    endDiagnosticCapture();
    setDiagnosticSink(null);
  });

  it("O7/O8/O9 materializer create/reuse/remap flush as committed after memory transaction", () => {
    const durableSender = statusItem({
      id: branded<NotificationItemId>("durable-send"),
      ownerId: SENDER,
      banId: BAN_ID,
      role: "SENDER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    const proposedRecv = statusItem({
      id: branded<NotificationItemId>("kernel-recv"),
      ownerId: RECEIVER,
      banId: BAN_ID,
      role: "RECEIVER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    const proposedSend = statusItem({
      id: branded<NotificationItemId>("kernel-send"),
      ownerId: SENDER,
      banId: BAN_ID,
      role: "SENDER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    const snapshot = withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      bans: { [BAN_ID]: ban() },
      notificationItems: {
        [proposedRecv.id]: proposedRecv,
        [proposedSend.id]: proposedSend,
      },
    });
    const effects = [
      { type: "UPSERT_NOTIFICATION_ITEM" as const, item: proposedRecv },
      { type: "UPSERT_NOTIFICATION_ITEM" as const, item: proposedSend },
    ];
    const correlationId = createCorrelationId();
    runWithDiagnosticContext(
      createDiagnosticContext({ source: "persistence", correlationId }),
      () => {
        const store = new InMemoryProductStore();
        store.inspect().transaction(() => {
          materializeStatusPairs({
            snapshot,
            effects,
            mutationAuthority: { kind: "APPLIED_RULE", eventId: "E-20", branch: "MAIN" },
            durableStatusItems: [durableSender],
          });
        });
      },
    );
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    expect(records.some((r) => r.eventName === "persistence.transaction.committed")).toBe(true);
    expect(
      records.some(
        (r) =>
          r.eventName === "status.materializer.remapped" &&
          r.meta.phase === "committed" &&
          r.meta.kernelItemId === "kernel-send" &&
          r.meta.durableItemId === "durable-send",
      ),
    ).toBe(true);
    expect(
      records.some(
        (r) =>
          r.eventName === "status.materializer.created" &&
          r.meta.phase === "committed" &&
          r.meta.durableItemId === "kernel-recv",
      ),
    ).toBe(true);
    expect(records.every((r) => r.correlationId === correlationId || r.source === "materializer" || r.source === "persistence")).toBe(
      true,
    );
  });

  it("O10 logical Status duplicate emits classified failure", () => {
    const a = statusItem({
      id: branded<NotificationItemId>("dup-a"),
      ownerId: SENDER,
      banId: BAN_ID,
      role: "SENDER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    const b = statusItem({
      id: branded<NotificationItemId>("dup-b"),
      ownerId: SENDER,
      banId: BAN_ID,
      role: "SENDER",
      status: "OVERBOARD",
    }) as StatusNotificationItem;
    expect(() =>
      materializeStatusPairs({
        snapshot: withEntities(emptySnapshot(), { bans: { [BAN_ID]: ban() } }),
        effects: [{ type: "UPSERT_BAN", ban: ban() }],
        mutationAuthority: { kind: "APPLIED_RULE", eventId: "E-20", branch: "MAIN" },
        durableStatusItems: [a, b],
      }),
    ).toThrow(PersistenceError);
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    const failed = records.find((r) => r.eventName === "status.materializer.failed");
    expect(failed?.meta.classification).toBe("STATUS_LOGICAL_DUPLICATE");
    expect(classifyPersistenceError("INVARIANT", "Duplicate durable Status rows")).toBe(
      "STATUS_LOGICAL_DUPLICATE",
    );
  });

  it("O6 CAS conflict reports expected and actual revision", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER, "tg-obs2-cas");
    const seeded = await kit.installFixtureSnapshot(
      SENDER,
      withControlState(emptySnapshot(), "RIM.LOBBY"),
    );
    await expect(
      kit.store.persistTransition({
        currentUserId: SENDER,
        expectedRevision: seeded.revision + 50,
        result: {
          outcome: "APPLIED",
          result: "TRANSITION",
          controlState: seeded.snapshot.controlState,
          snapshot: seeded.snapshot,
          effects: [],
          declaredEffects: [],
          traces: [],
          composition: "GLOBAL_THEN_LOCAL",
          error: null,
        },
        appliedRule: { eventId: "E-01", branch: "MAIN" },
        baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    const cas = records.find((r) => r.eventName === "persistence.cas.conflict");
    expect(cas?.meta.expectedRevision).toBe(seeded.revision + 50);
    expect(cas?.meta.actualRevision).toBe(seeded.revision);
    expect(cas?.meta.classification).toBe("SESSION_CAS_CONFLICT");
  });

  it("O11 rollback path does not emit COMMITTED for failed materializer", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER, "tg-obs2-rb");
    kit.establishIdentity(RECEIVER, "tg-obs2-rb-r");
    await kit.installFixtureSnapshot(
      SENDER,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans: { [BAN_ID]: ban(null) } }),
    );
    kit.memoryStore!.inspect().installRawItem(
      statusItem({
        id: branded<NotificationItemId>("dup-1"),
        ownerId: RECEIVER,
        banId: BAN_ID,
        role: "RECEIVER",
        status: "OVERBOARD",
      }),
    );
    kit.memoryStore!.inspect().installRawItem(
      statusItem({
        id: branded<NotificationItemId>("dup-2"),
        ownerId: RECEIVER,
        banId: BAN_ID,
        role: "RECEIVER",
        status: "OVERBOARD",
      }),
    );
    const loaded = await kit.store.loadProductSnapshot(SENDER);
    endDiagnosticCapture();
    beginDiagnosticCapture();
    await expect(
      kit.store.persistTransition({
        currentUserId: SENDER,
        expectedRevision: loaded.revision,
        result: {
          outcome: "APPLIED",
          result: "TRANSITION",
          controlState: loaded.snapshot.controlState,
          snapshot: withEntities(loaded.snapshot, { bans: { [BAN_ID]: ban("OVERBOARD") } }),
          effects: [
            { type: "UPSERT_BAN", ban: ban("OVERBOARD") },
            {
              type: "UPSERT_NOTIFICATION_ITEM",
              item: statusItem({
                id: branded<NotificationItemId>("k-r"),
                ownerId: RECEIVER,
                banId: BAN_ID,
                role: "RECEIVER",
                status: "OVERBOARD",
              }),
            },
            {
              type: "UPSERT_NOTIFICATION_ITEM",
              item: statusItem({
                id: branded<NotificationItemId>("k-s"),
                ownerId: SENDER,
                banId: BAN_ID,
                role: "SENDER",
                status: "OVERBOARD",
              }),
            },
          ],
          declaredEffects: [],
          traces: [],
          composition: "GLOBAL_THEN_LOCAL",
          error: null,
        },
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    expect(records.some((r) => r.eventName === "persistence.transaction.rolled_back")).toBe(true);
    expect(records.some((r) => r.eventName === "persistence.transaction.committed")).toBe(false);
    expect(records.some((r) => r.eventName === "status.materializer.failed")).toBe(true);
  });

  it("O20 memory storeKind on transaction events", () => {
    const store = new InMemoryProductStore();
    store.inspect().transaction(() => 1);
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    expect(records.find((r) => r.eventName === "persistence.transaction.started")?.meta.storeKind).toBe(
      "memory",
    );
    expect(
      records.find((r) => r.eventName === "persistence.transaction.committed")?.meta.storeKind,
    ).toBe("memory");
  });
});
