import { describe, expect, it } from "vitest";
import {
  asInstant,
  emptySnapshot,
  type Ban,
  type CheckPair,
  type DomainTimer,
  type Effect,
  type NotificationItem,
  type PendingOperation,
  type TransitionResult,
  type UserId,
} from "@98plus/product-model";
import {
  BAN_ID,
  OTHER_USER,
  USER_ID,
  branded,
  makeBan,
} from "../../product-model/src/kernel.fixtures.ts";
import { mergeBan } from "./ban-merge.ts";
import { mergeCheckPair } from "./check-pair-write.ts";
import { PersistenceError } from "./errors.ts";
import {
  allowedBanFields,
  assertWriteSetCoveredByLockPlan,
  baselineFromLoadedSnapshot,
  buildLockPlan,
  deriveEntityWriteSet,
  fieldDiffBan,
} from "./hybrid-persist.ts";
import { mergeNotificationItem } from "./item-write.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import { mergeDomainTimer } from "./timer-merge.ts";

function appliedResult(
  snapshot: TransitionResult["snapshot"],
  effects: readonly Effect[],
): TransitionResult {
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

describe("12D-1 hybrid write-set derivation", () => {
  it("CLEAR_OPERATION deletes one id and does not wipe others", () => {
    const effects: Effect[] = [
      { type: "CLEAR_OPERATION", operationId: branded("op-clear") },
      {
        type: "MARK_OPERATION_RESULT_APPLIED",
        operationId: branded("op-keep"),
      },
    ];
    const writeSet = deriveEntityWriteSet(effects);
    expect(writeSet.operationIdsToDelete).toEqual(["op-clear"]);
    expect(writeSet.operationIds).toEqual(["op-keep"]);
  });

  it("materializerWrittenItemIds remains an empty extension point", () => {
    const writeSet = deriveEntityWriteSet([], { materializerWrittenItemIds: [] });
    expect(writeSet.itemIds).toEqual([]);
  });

  it("rejects Ban writes outside the frozen lock plan", () => {
    const writeSet = deriveEntityWriteSet([
      { type: "UPSERT_BAN", ban: makeBan({ id: branded("ban-a") }) },
    ]);
    const plan = buildLockPlan({
      sessionUserIds: [USER_ID],
      writeSet,
    });
    const frozen = { ...plan, banIds: [branded("ban-other")] as typeof plan.banIds };
    expect(() => assertWriteSetCoveredByLockPlan(writeSet, frozen)).toThrow(PersistenceError);
  });
});

describe("12D-1 Ban authorized merge", () => {
  const base = makeBan({
    id: BAN_ID,
    senderId: USER_ID,
    receiverId: OTHER_USER,
    status: "OVERBOARD",
    banText: "original",
    durationMinutes: 30 as Ban["durationMinutes"],
  });

  it("ignores stale status=null clearing OVERBOARD", () => {
    const next = { ...base, status: null };
    const merged = mergeBan(base, base, next, {
      kind: "APPLIED_RULE",
      eventId: "E-20",
      branch: "overboard",
    });
    expect(merged.status).toBe("OVERBOARD");
  });

  it("duplicate OVERBOARD is idempotent", () => {
    const merged = mergeBan(base, base, base, {
      kind: "APPLIED_RULE",
      eventId: "E-20",
      branch: "overboard",
    });
    expect(merged.status).toBe("OVERBOARD");
  });

  it("conflicts OVERBOARD vs BANTASTIC", () => {
    const next = { ...base, status: "BANTASTIC" as const };
    expect(() =>
      mergeBan(base, base, next, {
        kind: "APPLIED_RULE",
        eventId: "E-20",
        branch: "status",
      }),
    ).toThrow(/terminal conflict/);
  });

  it("ignores unauthorized banText and duration changes", () => {
    const next = {
      ...base,
      banText: "hacked",
      durationMinutes: 99 as Ban["durationMinutes"],
      status: "OVERBOARD" as const,
    };
    const merged = mergeBan(base, { ...base, status: null }, next, {
      kind: "APPLIED_RULE",
      eventId: "E-20",
      branch: "overboard",
    });
    expect(merged.banText).toBe("original");
    expect(merged.durationMinutes).toBe(30);
    expect(merged.status).toBe("OVERBOARD");
  });

  it("E-30 updates only acceptance on existing Ban", () => {
    const pending = makeBan({
      id: BAN_ID,
      senderId: OTHER_USER,
      receiverId: USER_ID,
      acceptance: "PENDING",
      banText: "original",
    });
    const next = { ...pending, acceptance: "ACCEPTED" as const, banText: "should-not-apply" };
    const merged = mergeBan(pending, pending, next, {
      kind: "APPLIED_RULE",
      eventId: "E-30",
      branch: "reply-accept",
    });
    expect(merged.acceptance).toBe("ACCEPTED");
    expect(merged.banText).toBe("original");
  });

  it("E-45 allows receiver binding and share-link flag", () => {
    const unbound = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: null });
    const next = {
      ...unbound,
      receiverId: OTHER_USER,
      boundViaTelegramShareLink: true,
      banText: "ignored",
    };
    const merged = mergeBan(unbound, unbound, next, {
      kind: "APPLIED_RULE",
      eventId: "E-45",
      branch: "share-bound",
    });
    expect(merged.receiverId).toBe(OTHER_USER);
    expect(merged.boundViaTelegramShareLink).toBe(true);
    expect(merged.banText).toBe(unbound.banText);
  });

  it("receiver binding conflict throws", () => {
    const bound = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: OTHER_USER });
    const next = { ...bound, receiverId: branded<UserId>("third-user") };
    expect(() =>
      mergeBan(bound, bound, next, {
        kind: "APPLIED_RULE",
        eventId: "E-45",
        branch: "share-bound",
      }),
    ).toThrow(/already bound/);
  });

  it("fieldDiff ∩ allowlist for E-20 is status-only", () => {
    const next = { ...base, banText: "x", status: "OVERBOARD" as const };
    const diff = fieldDiffBan({ ...base, status: null }, next);
    const allowed = allowedBanFields({
      kind: "APPLIED_RULE",
      eventId: "E-20",
      branch: "x",
    });
    const apply = [...diff].filter((key) => allowed.has(key));
    expect(apply).toEqual(["status"]);
  });
});

describe("12D-1 CheckPair / Timer / Item merges", () => {
  it("rejects answer nullification and conflicting answers", () => {
    const existing: CheckPair = {
      id: branded("pair-1"),
      banId: BAN_ID,
      receiverItemId: branded("ri"),
      senderItemId: branded("si"),
      receiverAnswer: "FULFILLED",
      senderAnswer: null,
      resultingStatus: null,
    };
    expect(() => mergeCheckPair(existing, { ...existing, receiverAnswer: null })).toThrow(
      /cannot be cleared/,
    );
    expect(() =>
      mergeCheckPair(existing, { ...existing, receiverAnswer: "NOT_FULFILLED" }),
    ).toThrow(/cannot be replaced/);
  });

  it("EXPIRED timer cannot revert to RUNNING; checkPairCreated sticks", () => {
    const expired: DomainTimer = {
      id: branded("timer-1"),
      banId: BAN_ID,
      startedAt: asInstant(1),
      durationMinutes: 30 as Ban["durationMinutes"],
      state: "EXPIRED",
      checkPairCreated: true,
    };
    const merged = mergeDomainTimer(expired, {
      ...expired,
      state: "RUNNING",
      checkPairCreated: false,
    });
    expect(merged.state).toBe("EXPIRED");
    expect(merged.checkPairCreated).toBe(true);
  });

  it("PROCESSED item cannot become UNPROCESSED", () => {
    const processed = {
      id: branded("item-1"),
      ownerId: USER_ID,
      banId: BAN_ID,
      kind: "INCOMING",
      fifoSequence: 1,
      lifecycle: { status: "PROCESSED", display: null },
    } as unknown as NotificationItem;
    const next = {
      ...processed,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    } as unknown as NotificationItem;
    const merged = mergeNotificationItem(processed, next);
    expect(merged.lifecycle.status).toBe("PROCESSED");
  });
});

describe("12D-1 InMemory hybrid persistence", () => {
  it("persists PCS without SET_CONTROL_STATE and clears one operation only", async () => {
    const kit = PersistenceTestKit.inMemory();
    const userId = USER_ID;
    kit.establishIdentity(userId, "tg-hybrid-1");
    const opKeep: PendingOperation = {
      operationId: branded("op-keep"),
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
      originatingItemId: null,
      resultApplied: false,
      supersededByExternalEntry: false,
      sendDraft: null,
    };
    const opClear: PendingOperation = {
      ...opKeep,
      operationId: branded("op-clear"),
    };
    let snap = emptySnapshot();
    snap = {
      ...snap,
      controlState: "RIM.LOBBY",
      runtime: {
        ...snap.runtime,
        pendingOperations: {
          [opKeep.operationId]: opKeep,
          [opClear.operationId]: opClear,
        },
      },
    };
    await kit.installFixtureSnapshot(userId, snap);
    const loaded = await kit.store.loadProductSnapshot(userId);
    const next = {
      ...loaded.snapshot,
      controlState: "CREATE_BAN.WHO" as const,
      runtime: {
        ...loaded.snapshot.runtime,
        pendingOperations: {
          [opKeep.operationId]: opKeep,
        },
      },
    };
    await kit.store.persistTransition({
      currentUserId: userId,
      expectedRevision: loaded.revision,
      result: appliedResult(next, [
        { type: "CLEAR_OPERATION", operationId: opClear.operationId },
      ]),
      baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
    });
    const after = await kit.store.loadProductSnapshot(userId);
    expect(after.snapshot.controlState).toBe("CREATE_BAN.WHO");
    expect(Object.keys(after.snapshot.runtime.pendingOperations)).toEqual(["op-keep"]);
  });

  it("does not delete counterpart NotificationItems absent from actor write-set", async () => {
    const kit = PersistenceTestKit.inMemory();
    const sender = USER_ID;
    const receiver = OTHER_USER;
    kit.establishIdentity(sender, "tg-s");
    kit.establishIdentity(receiver, "tg-r");
    const ban = makeBan({
      id: BAN_ID,
      senderId: sender,
      receiverId: receiver,
      acceptance: "ACCEPTED",
    });
    const senderItem = {
      id: branded("item-sender"),
      ownerId: sender,
      banId: BAN_ID,
      kind: "STATUS",
      fifoSequence: 1,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
      status: "OVERBOARD",
      role: "SENDER",
    } as unknown as NotificationItem;
    const receiverItem = {
      id: branded("item-receiver"),
      ownerId: receiver,
      banId: BAN_ID,
      kind: "STATUS",
      fifoSequence: 1,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
      status: "OVERBOARD",
      role: "RECEIVER",
    } as unknown as NotificationItem;
    let senderSnap = emptySnapshot();
    senderSnap = {
      ...senderSnap,
      extended: {
        ...senderSnap.extended,
        entities: {
          ...senderSnap.extended.entities,
          bans: { [ban.id]: ban },
          notificationItems: { [senderItem.id]: senderItem },
        },
      },
    };
    let receiverSnap = emptySnapshot();
    receiverSnap = {
      ...receiverSnap,
      extended: {
        ...receiverSnap.extended,
        entities: {
          ...receiverSnap.extended.entities,
          bans: { [ban.id]: ban },
          notificationItems: { [receiverItem.id]: receiverItem },
        },
      },
    };
    await kit.installFixtureSnapshot(sender, senderSnap);
    await kit.installFixtureSnapshot(receiver, receiverSnap);
    const loaded = await kit.store.loadProductSnapshot(sender);
    const nextBan: Ban = { ...ban, status: "OVERBOARD" };
    const next = {
      ...loaded.snapshot,
      extended: {
        ...loaded.snapshot.extended,
        entities: {
          ...loaded.snapshot.extended.entities,
          bans: { [nextBan.id]: nextBan },
          notificationItems: { [senderItem.id]: senderItem },
        },
      },
    };
    await kit.store.persistTransition({
      currentUserId: sender,
      expectedRevision: loaded.revision,
      result: appliedResult(next, [{ type: "UPSERT_BAN", ban: nextBan }]),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(loaded.snapshot, loaded.revision),
    });
    const receiverAfter = await kit.store.loadProductSnapshot(receiver);
    expect(receiverAfter.snapshot.extended.entities.notificationItems[receiverItem.id]).toEqual(
      receiverItem,
    );
  });
});
