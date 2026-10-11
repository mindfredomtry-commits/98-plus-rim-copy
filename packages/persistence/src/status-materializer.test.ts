import { describe, expect, it } from "vitest";
import {
  emptySnapshot,
  type Ban,
  type BanId,
  type Effect,
  type NotificationItemId,
  type OperationId,
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
import { PersistenceError } from "./errors.ts";
import {
  baselineFromLoadedSnapshot,
  deriveEntityWriteSet,
  withMaterializerItemIds,
} from "./hybrid-persist.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import {
  applyIdRemapToSnapshot,
  clearProcessedStatusPriority,
  materializeStatusPairs,
} from "./status-materializer.ts";

const SENDER = branded<UserId>("user-sender");
const RECEIVER = branded<UserId>("user-receiver");
const BAN_ID = branded<BanId>("ban-status-1");

function overboardBan(overrides: Partial<Ban> = {}): Ban {
  return makeBan({
    id: BAN_ID,
    senderId: SENDER,
    receiverId: RECEIVER,
    status: "OVERBOARD",
    acceptance: "PENDING",
    ...overrides,
  });
}

function status(
  role: "SENDER" | "RECEIVER",
  id: string,
  overrides: Partial<StatusNotificationItem> = {},
): StatusNotificationItem {
  return statusItem({
    id: branded<NotificationItemId>(id),
    ownerId: role === "SENDER" ? SENDER : RECEIVER,
    banId: BAN_ID,
    role,
    status: "OVERBOARD",
    ...overrides,
  }) as StatusNotificationItem;
}

function worldWithBan(ban: Ban = overboardBan()) {
  return withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
    bans: { [ban.id]: ban },
  });
}

function e20Effects(receiverId: string, senderId: string): Effect[] {
  const ban = overboardBan();
  return [
    { type: "UPSERT_BAN", ban },
    {
      type: "UPSERT_NOTIFICATION_ITEM",
      item: status("RECEIVER", receiverId),
    },
    {
      type: "UPSERT_NOTIFICATION_ITEM",
      item: status("SENDER", senderId),
    },
  ];
}

const e20Auth = { kind: "APPLIED_RULE" as const, eventId: "E-20" as const, branch: "overboard" };
const e23Auth = { kind: "APPLIED_RULE" as const, eventId: "E-23" as const, branch: "bantastic" };

describe("12D-2 Status materializer (S1–S15)", () => {
  it("S1. No existing Status — creates sender and receiver exactly once", () => {
    const effects = e20Effects("k-recv", "k-send");
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects,
      mutationAuthority: e20Auth,
      durableStatusItems: [],
    });
    expect([...result.createdItemIds].sort()).toEqual(["k-recv", "k-send"]);
    expect(result.updatedItemIds).toEqual([]);
    expect(result.materializerWrittenItemIds).toEqual(["k-recv", "k-send"]);
    expect(result.idRemap).toEqual({});
  });

  it("S2. Sender exists, receiver missing — preserve sender ID; create receiver", () => {
    const durableSender = status("SENDER", "durable-send", {
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    });
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableSender],
    });
    expect(result.idRemap["k-send"]).toBe("durable-send");
    expect(result.createdItemIds).toEqual(["k-recv"]);
    expect(result.updatedItemIds).toEqual(["durable-send"]);
    expect(result.snapshot.extended.entities.notificationItems["durable-send"]?.id).toBe(
      "durable-send",
    );
    expect(result.snapshot.extended.entities.notificationItems["k-send"]).toBeUndefined();
  });

  it("S3. Receiver exists, sender missing — preserve receiver ID; create sender", () => {
    const durableRecv = status("RECEIVER", "durable-recv");
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv],
    });
    expect(result.idRemap["k-recv"]).toBe("durable-recv");
    expect(result.createdItemIds).toEqual(["k-send"]);
    expect(result.updatedItemIds).toEqual(["durable-recv"]);
  });

  it("S4. Both exist — reuse both durable IDs", () => {
    const durableRecv = status("RECEIVER", "d-recv");
    const durableSend = status("SENDER", "d-send");
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    expect(result.idRemap).toEqual({ "k-recv": "d-recv", "k-send": "d-send" });
    expect(result.createdItemIds).toEqual([]);
    expect([...result.updatedItemIds].sort()).toEqual(["d-recv", "d-send"]);
  });

  it("S5. Repeat E-20 — no additional logical Status rows", () => {
    const durableRecv = status("RECEIVER", "d-recv");
    const durableSend = status("SENDER", "d-send");
    const first = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k1-r", "k1-s"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    const second = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k2-r", "k2-s"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    expect(first.createdItemIds).toEqual([]);
    expect(second.createdItemIds).toEqual([]);
    expect([...second.updatedItemIds].sort()).toEqual(["d-recv", "d-send"]);
  });

  it("S6. Repeat E-23 — no additional logical Status rows", () => {
    const ban = makeBan({
      id: BAN_ID,
      senderId: SENDER,
      receiverId: RECEIVER,
      status: "BANTASTIC",
      acceptance: "ACCEPTED",
    });
    const durableRecv = statusItem({
      id: branded("d-r"),
      ownerId: RECEIVER,
      banId: BAN_ID,
      role: "RECEIVER",
      status: "BANTASTIC",
    }) as StatusNotificationItem;
    const durableSend = statusItem({
      id: branded("d-s"),
      ownerId: SENDER,
      banId: BAN_ID,
      role: "SENDER",
      status: "BANTASTIC",
    }) as StatusNotificationItem;
    const effects: Effect[] = [
      { type: "UPSERT_BAN", ban },
      {
        type: "UPSERT_NOTIFICATION_ITEM",
        item: statusItem({
          id: branded("k-r"),
          ownerId: RECEIVER,
          banId: BAN_ID,
          role: "RECEIVER",
          status: "BANTASTIC",
        }),
      },
      {
        type: "UPSERT_NOTIFICATION_ITEM",
        item: statusItem({
          id: branded("k-s"),
          ownerId: SENDER,
          banId: BAN_ID,
          role: "SENDER",
          status: "BANTASTIC",
        }),
      },
    ];
    const result = materializeStatusPairs({
      snapshot: worldWithBan(ban),
      effects,
      mutationAuthority: e23Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    expect(result.createdItemIds).toEqual([]);
    expect(result.idRemap).toEqual({ "k-r": "d-r", "k-s": "d-s" });
  });

  it("S7. Kernel ID differs from durable ID — all references use durable ID", () => {
    const durableRecv = status("RECEIVER", "d-recv");
    const durableSend = status("SENDER", "d-send");
    const snapshot = {
      ...worldWithBan(),
      extended: {
        ...worldWithBan().extended,
        activeNotificationItemId: branded<NotificationItemId>("k-recv"),
        priorities: {
          statusItemId: branded<NotificationItemId>("k-recv"),
          timerItemId: null,
        },
        replySource: {
          kind: "STATUS" as const,
          itemId: branded<NotificationItemId>("k-recv"),
          banId: BAN_ID,
        },
        entities: worldWithBan().extended.entities,
      },
      runtime: {
        ...worldWithBan().runtime,
        pendingOperations: {
          op1: {
            operationId: branded<OperationId>("op1"),
            kind: "CHECK_ANSWER" as const,
            originatingState: "NOTIFICATIONS.CHECK.RECEIVER" as const,
            originatingItemId: branded<NotificationItemId>("k-recv"),
            resultApplied: false,
            supersededByExternalEntry: false,
            sendDraft: null,
          },
        },
      },
    };
    const result = materializeStatusPairs({
      snapshot,
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    expect(result.snapshot.extended.activeNotificationItemId).toBe("d-recv");
    expect(result.snapshot.extended.priorities.statusItemId).toBe("d-recv");
    expect(result.snapshot.extended.replySource?.itemId).toBe("d-recv");
    expect(result.snapshot.runtime.pendingOperations.op1?.originatingItemId).toBe("d-recv");
  });

  it("S8. PROCESSED sender Status — lifecycle remains PROCESSED", () => {
    const durableSend = status("SENDER", "d-send", {
      lifecycle: { status: "PROCESSED" },
    });
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableSend],
    });
    const merged = result.snapshot.extended.entities.notificationItems["d-send"];
    expect(merged?.kind).toBe("STATUS");
    if (merged?.kind === "STATUS") {
      expect(merged.lifecycle.status).toBe("PROCESSED");
    }
  });

  it("S9. PROCESSED receiver Status — lifecycle remains PROCESSED", () => {
    const durableRecv = status("RECEIVER", "d-recv", {
      lifecycle: { status: "PROCESSED" },
    });
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv],
    });
    const merged = result.snapshot.extended.entities.notificationItems["d-recv"];
    expect(merged?.kind).toBe("STATUS");
    if (merged?.kind === "STATUS") {
      expect(merged.lifecycle.status).toBe("PROCESSED");
    }
  });

  it("S10. Duplicate logical Status rows — fail closed", () => {
    const a = status("RECEIVER", "dup-a");
    const b = status("RECEIVER", "dup-b");
    expect(() =>
      materializeStatusPairs({
        snapshot: worldWithBan(),
        effects: e20Effects("k-recv", "k-send"),
        mutationAuthority: e20Auth,
        durableStatusItems: [a, b],
      }),
    ).toThrow(PersistenceError);
  });

  it("S11. Item write-set union includes materializer-created counterpart", () => {
    const durableSend = status("SENDER", "d-send");
    // Kernel only emitted sender (simulate incomplete effects) + Ban
    const effects: Effect[] = [
      { type: "UPSERT_BAN", ban: overboardBan() },
      { type: "UPSERT_NOTIFICATION_ITEM", item: status("SENDER", "k-send") },
    ];
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects,
      mutationAuthority: e20Auth,
      durableStatusItems: [durableSend],
    });
    expect(result.createdItemIds).toHaveLength(1);
    const createdId = result.createdItemIds[0]!;
    const kernelWriteSet = deriveEntityWriteSet(effects);
    const finalWriteSet = withMaterializerItemIds(
      kernelWriteSet,
      result.materializerWrittenItemIds,
    );
    expect(finalWriteSet.itemIds).toContain(createdId);
    expect(finalWriteSet.itemIds).toContain("d-send");
  });

  it("S12. Cross-owner preservation — writing one owner does not delete the other", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER, "tg-sender");
    kit.establishIdentity(RECEIVER, "tg-receiver");
    const ban = overboardBan();
    const senderItem = status("SENDER", "s-item");
    const receiverItem = status("RECEIVER", "r-item");
    await kit.installFixtureSnapshot(
      SENDER,
      withEntities(worldWithBan(ban), {
        bans: { [ban.id]: ban },
        notificationItems: { [senderItem.id]: senderItem },
      }),
    );
    await kit.installFixtureSnapshot(
      RECEIVER,
      withEntities(worldWithBan(ban), {
        bans: { [ban.id]: ban },
        notificationItems: { [receiverItem.id]: receiverItem },
      }),
    );
    const loaded = await kit.store.loadProductSnapshot(SENDER);
    const nextBan: Ban = { ...ban, status: "OVERBOARD" };
    await kit.store.persistTransition({
      currentUserId: SENDER,
      expectedRevision: loaded.revision,
      result: {
        outcome: "APPLIED",
        result: "TRANSITION",
        controlState: loaded.snapshot.controlState,
        snapshot: withEntities(loaded.snapshot, {
          bans: { [ban.id]: nextBan },
          notificationItems: { [senderItem.id]: senderItem },
        }),
        effects: [
          { type: "UPSERT_BAN", ban: nextBan },
          { type: "UPSERT_NOTIFICATION_ITEM", item: senderItem },
          {
            type: "UPSERT_NOTIFICATION_ITEM",
            item: status("RECEIVER", "kernel-new-recv"),
          },
        ],
        declaredEffects: [],
        traces: [],
        composition: "GLOBAL_THEN_LOCAL",
        error: null,
      },
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
    });
    const receiverAfter = await kit.store.loadProductSnapshot(RECEIVER);
    expect(receiverAfter.snapshot.extended.entities.notificationItems["r-item"]).toBeTruthy();
    expect(kit.memoryStore!.inspect().countItems()).toBeGreaterThanOrEqual(2);
  });

  it("S13. PendingOperation remapping uses durable Item ID", () => {
    const durableRecv = status("RECEIVER", "d-recv");
    const durableSend = status("SENDER", "d-send");
    const base = worldWithBan();
    const snapshot = {
      ...base,
      runtime: {
        ...base.runtime,
        pendingOperations: {
          op1: {
            operationId: branded<OperationId>("op1"),
            kind: "CHECK_ANSWER" as const,
            originatingState: "NOTIFICATIONS.CHECK.RECEIVER" as const,
            originatingItemId: branded<NotificationItemId>("k-recv"),
            resultApplied: false,
            supersededByExternalEntry: false,
            sendDraft: null,
          },
        },
      },
    };
    const result = materializeStatusPairs({
      snapshot,
      effects: e20Effects("k-recv", "k-send"),
      mutationAuthority: e20Auth,
      durableStatusItems: [durableRecv, durableSend],
    });
    expect(result.snapshot.runtime.pendingOperations.op1?.originatingItemId).toBe("d-recv");
  });

  it("S14. Session pointer remapping — active, priority, reply-source", () => {
    const remapped = applyIdRemapToSnapshot(
      {
        ...worldWithBan(),
        extended: {
          ...worldWithBan().extended,
          activeNotificationItemId: branded("x"),
          priorities: { statusItemId: branded("x"), timerItemId: null },
          replySource: { kind: "STATUS", itemId: branded("x"), banId: BAN_ID },
        },
      },
      { x: branded("y") },
    );
    expect(remapped.extended.activeNotificationItemId).toBe("y");
    expect(remapped.extended.priorities.statusItemId).toBe("y");
    expect(remapped.extended.replySource?.itemId).toBe("y");
  });

  it("S15. Reconciliation atomicity — failure rolls back (InMemory)", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(SENDER, "tg-s15");
    kit.establishIdentity(RECEIVER, "tg-s15-r");
    const ban = overboardBan({ status: null });
    await kit.installFixtureSnapshot(SENDER, worldWithBan(ban));
    // Pre-seed duplicate durable Status to force fail-closed
    kit.memoryStore!.inspect().installRawItem(status("RECEIVER", "dup-1"));
    kit.memoryStore!.inspect().installRawItem(status("RECEIVER", "dup-2"));
    const loaded = await kit.store.loadProductSnapshot(SENDER);
    const next = overboardBan();
    await expect(
      kit.store.persistTransition({
        currentUserId: SENDER,
        expectedRevision: loaded.revision,
        result: {
          outcome: "APPLIED",
          result: "TRANSITION",
          controlState: loaded.snapshot.controlState,
          snapshot: withEntities(loaded.snapshot, { bans: { [BAN_ID]: next } }),
          effects: e20Effects("k-r", "k-s"),
          declaredEffects: [],
          traces: [],
          composition: "GLOBAL_THEN_LOCAL",
          error: null,
        },
        appliedRule: { eventId: "E-20", branch: "overboard" },
        baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const after = await kit.store.loadProductSnapshot(SENDER);
    expect(after.revision).toBe(loaded.revision);
    expect(after.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
  });

  it("rejects invalid cross-entity remap", () => {
    const durable = status("RECEIVER", "d-recv"); // owner = RECEIVER
    const wrongOwnerProposed = status("RECEIVER", "k-recv", { ownerId: SENDER });
    expect(() =>
      materializeStatusPairs({
        snapshot: worldWithBan(),
        effects: [
          { type: "UPSERT_BAN", ban: overboardBan() },
          { type: "UPSERT_NOTIFICATION_ITEM", item: wrongOwnerProposed },
          { type: "UPSERT_NOTIFICATION_ITEM", item: status("SENDER", "k-send") },
        ],
        mutationAuthority: e20Auth,
        durableStatusItems: [durable],
      }),
    ).toThrow(/logical entities/);
  });

  it("PROCESSED Status is not selected as actionable priority", () => {
    const snap = {
      ...worldWithBan(),
      extended: {
        ...worldWithBan().extended,
        priorities: {
          statusItemId: branded<NotificationItemId>("proc"),
          timerItemId: null,
        },
        entities: {
          ...worldWithBan().extended.entities,
          notificationItems: {
            proc: status("RECEIVER", "proc", { lifecycle: { status: "PROCESSED" } }),
          },
        },
      },
    };
    const cleared = clearProcessedStatusPriority(snap);
    expect(cleared.extended.priorities.statusItemId).toBeNull();
  });

  it("creates missing counterpart when Kernel emitted only Ban (no Status effects)", () => {
    let n = 0;
    const result = materializeStatusPairs({
      snapshot: worldWithBan(),
      effects: [{ type: "UPSERT_BAN", ban: overboardBan() }],
      mutationAuthority: e20Auth,
      durableStatusItems: [],
      allocateId: () => branded<NotificationItemId>(`alloc-${++n}`),
    });
    expect(result.createdItemIds).toHaveLength(2);
    expect(result.materializerWrittenItemIds).toHaveLength(2);
  });
});
