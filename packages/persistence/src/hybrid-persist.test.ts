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
  assertNoHeldLockExpansion,
  assertWriteSetCoveredByLockPlan,
  baselineFromLoadedSnapshot,
  buildLockPlan,
  deriveEntityWriteSet,
  emptyBaseline,
  fieldDiffBan,
  sharedWriteContextForTransition,
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

  it("P2-LOCK-EXPAND rejects nested Ban lock expansion beyond held set", () => {
    const plan = buildLockPlan({
      sessionUserIds: [USER_ID],
      writeSet: deriveEntityWriteSet([
        { type: "UPSERT_BAN", ban: makeBan({ id: branded("ban-a") }) },
        { type: "UPSERT_BAN", ban: makeBan({ id: branded("ban-z") }) },
      ]),
    });
    expect(() =>
      assertNoHeldLockExpansion(
        {
          sessionUserIds: new Set([USER_ID]),
          banIds: new Set(["ban-z"]),
          timerIds: new Set(),
          checkPairIds: new Set(),
        },
        plan,
      ),
    ).toThrow(/expands held Ban locks/);
  });

  it("P2-LOCK-EXPAND allows first Ban acquisition when held ban set is empty", () => {
    const plan = buildLockPlan({
      sessionUserIds: [USER_ID],
      writeSet: deriveEntityWriteSet([
        { type: "UPSERT_BAN", ban: makeBan({ id: branded("ban-a") }) },
        { type: "UPSERT_BAN", ban: makeBan({ id: branded("ban-z") }) },
      ]),
    });
    expect(() =>
      assertNoHeldLockExpansion(
        {
          sessionUserIds: new Set([USER_ID]),
          banIds: new Set(),
          timerIds: new Set(),
          checkPairIds: new Set(),
        },
        plan,
      ),
    ).not.toThrow();
  });

  it("materializerWrittenItemIds accepts future Item IDs under frozen write-set contract (PG-17)", () => {
    const futureId = branded<NotificationItem["id"]>("item-materializer-future");
    const writeSet = deriveEntityWriteSet([], {
      materializerWrittenItemIds: [futureId],
    });
    expect(writeSet.itemIds).toEqual([futureId]);
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

describe("12D-1B P1-AUTH-CREATE-UPDATE E-08/E-10 create-only", () => {
  const e10 = { kind: "APPLIED_RULE" as const, eventId: "E-10" as const, branch: "create" };
  const e08 = {
    kind: "APPLIED_RULE" as const,
    eventId: "E-08" as const,
    branch: "valid-template-draft",
  };

  it("A1. E-10 + absent durable Ban → valid creation", () => {
    const created = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: OTHER_USER });
    expect(mergeBan(undefined, undefined, created, e10)).toEqual(created);
  });

  it("A2. E-08 + absent durable Ban → valid template creation", () => {
    const created = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: null });
    expect(mergeBan(undefined, undefined, created, e08)).toEqual(created);
  });

  it("A3. E-10 + existing Ban + altered status → durable status unchanged", () => {
    const durable = makeBan({ id: BAN_ID, status: null, acceptance: "PENDING" });
    const next = { ...durable, status: "OVERBOARD" as const };
    expect(mergeBan(durable, durable, next, e10).status).toBeNull();
  });

  it("A4. E-10 + existing Ban + altered acceptance → durable acceptance unchanged", () => {
    const durable = makeBan({ id: BAN_ID, acceptance: "PENDING" });
    const next = { ...durable, acceptance: "ACCEPTED" as const };
    expect(mergeBan(durable, durable, next, e10).acceptance).toBe("PENDING");
  });

  it("A5. E-08 + existing Ban + altered receiverId → durable receiver unchanged", () => {
    const durable = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: null });
    const next = { ...durable, receiverId: OTHER_USER };
    expect(mergeBan(durable, durable, next, e08).receiverId).toBeNull();
  });

  it("A6. E-08/E-10 + existing Ban + altered sourceProposalId → unchanged", () => {
    const durable = makeBan({ id: BAN_ID, sourceProposalId: null });
    const next = {
      ...durable,
      sourceProposalId: branded("proposal-x") as Ban["sourceProposalId"],
    };
    expect(mergeBan(durable, durable, next, e10).sourceProposalId).toBeNull();
    expect(mergeBan(durable, durable, next, e08).sourceProposalId).toBeNull();
  });

  it("A7. E-08/E-10 + existing Ban + conflicting senderId → reject", () => {
    const durable = makeBan({ id: BAN_ID, senderId: USER_ID });
    const next = { ...durable, senderId: OTHER_USER };
    expect(() => mergeBan(durable, durable, next, e10)).toThrow(/senderId is immutable/);
    expect(() => mergeBan(durable, durable, next, e08)).toThrow(/senderId is immutable/);
  });
});

describe("12D-1B P1-BASELINE-01 missing baseline fail-closed", () => {
  it("B1. existing Ban + E-10 + missing baselineBan + actor acceptance differs → preserve", () => {
    const durable = makeBan({ id: BAN_ID, acceptance: "PENDING" });
    const next = { ...durable, acceptance: "ACCEPTED" as const };
    expect(
      mergeBan(durable, undefined, next, {
        kind: "APPLIED_RULE",
        eventId: "E-10",
        branch: "create",
      }).acceptance,
    ).toBe("PENDING");
  });

  it("B2. existing Ban + E-08 + missing baselineBan + actor status differs → preserve", () => {
    const durable = makeBan({ id: BAN_ID, status: null });
    const next = { ...durable, status: "OVERBOARD" as const };
    expect(
      mergeBan(durable, undefined, next, {
        kind: "APPLIED_RULE",
        eventId: "E-08",
        branch: "valid-template-draft",
      }).status,
    ).toBeNull();
  });

  it("B3. existing Ban + E-20 + missing PersistenceBaseline → reject before write", () => {
    const ban = makeBan({ id: BAN_ID, status: null });
    const snap = {
      ...emptySnapshot(),
      extended: {
        ...emptySnapshot().extended,
        entities: { ...emptySnapshot().extended.entities, bans: { [ban.id]: ban } },
      },
    };
    expect(() =>
      sharedWriteContextForTransition({
        currentUserId: USER_ID,
        expectedRevision: 1,
        result: appliedResult(snap, [{ type: "UPSERT_BAN", ban: { ...ban, status: "OVERBOARD" } }]),
        appliedRule: { eventId: "E-20", branch: "overboard" },
      }),
    ).toThrow(/PersistenceBaseline/);
  });

  it("B4. existing Ban + E-30 + missing PersistenceBaseline → reject before write", () => {
    const ban = makeBan({ id: BAN_ID, acceptance: "PENDING" });
    const snap = {
      ...emptySnapshot(),
      extended: {
        ...emptySnapshot().extended,
        entities: { ...emptySnapshot().extended.entities, bans: { [ban.id]: ban } },
      },
    };
    expect(() =>
      sharedWriteContextForTransition({
        currentUserId: USER_ID,
        expectedRevision: 1,
        result: appliedResult(snap, [
          { type: "UPSERT_BAN", ban: { ...ban, acceptance: "ACCEPTED" } },
        ]),
        appliedRule: { eventId: "E-30", branch: "from-incoming" },
      }),
    ).toThrow(/PersistenceBaseline/);
  });

  it("B5. valid caller with genuine baseline still succeeds for E-20", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-b5");
    kit.establishIdentity(OTHER_USER, "tg-b5-other");
    const ban = makeBan({
      id: BAN_ID,
      senderId: USER_ID,
      receiverId: OTHER_USER,
      status: null,
    });
    const world = {
      ...emptySnapshot(),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
      extended: {
        ...emptySnapshot().extended,
        entities: { ...emptySnapshot().extended.entities, bans: { [ban.id]: ban } },
      },
    };
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const nextBan = { ...ban, status: "OVERBOARD" as const };
    const next = {
      ...seeded.snapshot,
      extended: {
        ...seeded.snapshot.extended,
        entities: { ...seeded.snapshot.extended.entities, bans: { [nextBan.id]: nextBan } },
      },
    };
    const saved = await kit.store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: appliedResult(next, [{ type: "UPSERT_BAN", ban: nextBan }]),
      appliedRule: { eventId: "E-20", branch: "overboard" },
      baseline: baselineFromLoadedSnapshot(seeded.snapshot, seeded.revision),
    });
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
  });

  it("B6. missing baseline leaves shared Ban unchanged (InMemory rollback)", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-b6");
    kit.establishIdentity(OTHER_USER, "tg-b6-other");
    const ban = makeBan({
      id: BAN_ID,
      senderId: USER_ID,
      receiverId: OTHER_USER,
      status: null,
      acceptance: "PENDING",
    });
    const world = {
      ...emptySnapshot(),
      extended: {
        ...emptySnapshot().extended,
        entities: { ...emptySnapshot().extended.entities, bans: { [ban.id]: ban } },
      },
    };
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const nextBan = { ...ban, status: "OVERBOARD" as const, acceptance: "ACCEPTED" as const };
    const next = {
      ...seeded.snapshot,
      controlState: "CREATE_BAN.WHO" as const,
      extended: {
        ...seeded.snapshot.extended,
        entities: { ...seeded.snapshot.extended.entities, bans: { [nextBan.id]: nextBan } },
      },
    };
    await expect(
      kit.store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result: appliedResult(next, [{ type: "UPSERT_BAN", ban: nextBan }]),
        appliedRule: { eventId: "E-10", branch: "create" },
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const after = await kit.store.loadProductSnapshot(USER_ID);
    expect(after.revision).toBe(seeded.revision);
    expect(after.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(after.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(after.snapshot.controlState).toBe(seeded.snapshot.controlState);
  });

  it("fieldDiffBan(undefined, next) authorizes no fields", () => {
    expect(fieldDiffBan(undefined, makeBan()).size).toBe(0);
  });
});

describe("12D-1B preserve legitimate Ban flows", () => {
  it("C1. E-20 status update succeeds", () => {
    const durable = makeBan({ id: BAN_ID, status: null });
    const next = { ...durable, status: "OVERBOARD" as const };
    expect(
      mergeBan(durable, durable, next, {
        kind: "APPLIED_RULE",
        eventId: "E-20",
        branch: "overboard",
      }).status,
    ).toBe("OVERBOARD");
  });

  it("C2. E-23 status update succeeds", () => {
    const durable = makeBan({ id: BAN_ID, status: null });
    const next = { ...durable, status: "BANTASTIC" as const };
    expect(
      mergeBan(durable, durable, next, {
        kind: "APPLIED_RULE",
        eventId: "E-23",
        branch: "second",
      }).status,
    ).toBe("BANTASTIC");
  });

  it("C3. E-30 creates Reply Ban and updates only original acceptance", () => {
    const original = makeBan({
      id: BAN_ID,
      senderId: OTHER_USER,
      receiverId: USER_ID,
      acceptance: "PENDING",
      banText: "original",
    });
    const reply = makeBan({
      id: branded("reply-ban"),
      senderId: USER_ID,
      receiverId: OTHER_USER,
      banText: "reply",
    });
    const e30 = { kind: "APPLIED_RULE" as const, eventId: "E-30" as const, branch: "from-incoming" };
    expect(mergeBan(undefined, undefined, reply, e30)).toEqual(reply);
    const accepted = mergeBan(
      original,
      original,
      { ...original, acceptance: "ACCEPTED", banText: "hack" },
      e30,
    );
    expect(accepted.acceptance).toBe("ACCEPTED");
    expect(accepted.banText).toBe("original");
  });

  it("C4. E-45 receiver binding succeeds", () => {
    const unbound = makeBan({ id: BAN_ID, receiverId: null });
    const next = { ...unbound, receiverId: OTHER_USER, boundViaTelegramShareLink: true };
    const merged = mergeBan(unbound, unbound, next, {
      kind: "APPLIED_RULE",
      eventId: "E-45",
      branch: "share",
    });
    expect(merged.receiverId).toBe(OTHER_USER);
    expect(merged.boundViaTelegramShareLink).toBe(true);
  });

  it("C5. Application BIND_RECEIVER succeeds", () => {
    const unbound = makeBan({ id: BAN_ID, receiverId: null });
    const next = { ...unbound, receiverId: OTHER_USER, banText: "ignored" };
    const merged = mergeBan(unbound, unbound, next, { kind: "BIND_RECEIVER" });
    expect(merged.receiverId).toBe(OTHER_USER);
    expect(merged.banText).toBe(unbound.banText);
  });

  it("C6. duplicate create event does not mutate existing durable Ban", () => {
    const durable = makeBan({
      id: BAN_ID,
      acceptance: "PENDING",
      status: null,
      banText: "original",
    });
    const next = {
      ...durable,
      acceptance: "ACCEPTED" as const,
      status: "OVERBOARD" as const,
      banText: "changed",
    };
    const merged = mergeBan(durable, durable, next, {
      kind: "APPLIED_RULE",
      eventId: "E-10",
      branch: "create",
    });
    expect(merged).toEqual(durable);
  });

  it("C7. stale actor snapshot cannot regress terminal Ban status", () => {
    const durable = makeBan({ id: BAN_ID, status: "OVERBOARD" });
    const next = { ...durable, status: null };
    expect(
      mergeBan(durable, { ...durable, status: null }, next, {
        kind: "APPLIED_RULE",
        eventId: "E-20",
        branch: "overboard",
      }).status,
    ).toBe("OVERBOARD");
  });

  it("C8. session-only write without Ban write-set allows missing baseline", () => {
    const ctx = sharedWriteContextForTransition({
      currentUserId: USER_ID,
      expectedRevision: 1,
      result: appliedResult(emptySnapshot(), [{ type: "CLEAR_OPERATION", operationId: branded("op") }]),
    });
    expect(ctx.writeSet.banIds).toEqual([]);
    expect(ctx.baseline).toEqual(emptyBaseline(1));
  });
});

describe("12D-1B transaction atomicity (InMemory)", () => {
  it("D1. missing baseline rejects and does not advance revision", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-d1");
    kit.establishIdentity(OTHER_USER, "tg-d1o");
    const ban = makeBan({ id: BAN_ID, senderId: USER_ID, receiverId: OTHER_USER });
    const seeded = await kit.installFixtureSnapshot(USER_ID, {
      ...emptySnapshot(),
      extended: {
        ...emptySnapshot().extended,
        entities: { ...emptySnapshot().extended.entities, bans: { [ban.id]: ban } },
      },
    });
    await expect(
      kit.store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result: appliedResult(
          {
            ...seeded.snapshot,
            controlState: "CREATE_BAN.WHO",
            extended: {
              ...seeded.snapshot.extended,
              entities: {
                ...seeded.snapshot.extended.entities,
                bans: { [ban.id]: { ...ban, status: "OVERBOARD" } },
              },
            },
          },
          [{ type: "UPSERT_BAN", ban: { ...ban, status: "OVERBOARD" } }],
        ),
        appliedRule: { eventId: "E-20", branch: "x" },
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    expect((await kit.store.loadProductSnapshot(USER_ID)).revision).toBe(seeded.revision);
  });

  it("D2. E-10 preserve-only cannot apply status via create allowlist", () => {
    const durable = makeBan({ id: BAN_ID, status: null });
    const next = { ...durable, status: "BANFLICT" as const };
    expect(
      mergeBan(durable, durable, next, {
        kind: "APPLIED_RULE",
        eventId: "E-10",
        branch: "create",
      }).status,
    ).toBeNull();
  });

  it("D3. nested persist without baseline cannot partially commit Ban mutation", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-d3");
    kit.establishIdentity(OTHER_USER, "tg-d3o");
    const ban = makeBan({
      id: BAN_ID,
      senderId: USER_ID,
      receiverId: OTHER_USER,
      acceptance: "ACCEPTED",
    });
    const pair: CheckPair = {
      id: branded("pair-d3"),
      banId: BAN_ID,
      receiverItemId: branded("ri"),
      senderItemId: branded("si"),
      receiverAnswer: null,
      senderAnswer: null,
      resultingStatus: null,
    };
    const world = {
      ...emptySnapshot(),
      controlState: "NOTIFICATIONS.CHECK.RECEIVER" as const,
      extended: {
        ...emptySnapshot().extended,
        entities: {
          ...emptySnapshot().extended.entities,
          bans: { [ban.id]: ban },
          checkPairs: { [pair.id]: pair },
        },
      },
    };
    await kit.installFixtureSnapshot(USER_ID, world);
    await expect(
      kit.store.withCheckPairLock(pair.id, BAN_ID, USER_ID, async (ctx) => {
        const loaded = await ctx.loadProductSnapshot(USER_ID);
        return ctx.persistTransition({
          currentUserId: USER_ID,
          expectedRevision: loaded.revision,
          result: appliedResult(
            {
              ...loaded.snapshot,
              extended: {
                ...loaded.snapshot.extended,
                entities: {
                  ...loaded.snapshot.extended.entities,
                  bans: { [ban.id]: { ...ban, status: "BANTASTIC" } },
                },
              },
            },
            [{ type: "UPSERT_BAN", ban: { ...ban, status: "BANTASTIC" } }],
          ),
          appliedRule: { eventId: "E-23", branch: "second" },
        });
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    const after = await kit.store.loadProductSnapshot(USER_ID);
    expect(after.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
  });
});
