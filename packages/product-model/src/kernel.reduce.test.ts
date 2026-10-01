import { describe, expect, it } from "vitest";
import {
  ABSENT_EVENT_IDS,
  APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  isProductControlState,
  reduce,
} from "./index.ts";
import {
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  CONTEXT_DATA,
  INCOMING_ITEM_ID,
  OP_ID,
  PROPOSAL_ID,
  REQUEST_ID,
  TIMER_ITEM_ID,
  defaultEvent,
  eventOf,
  failedAi,
  fixtureForRow,
  incomingItem,
  kernelContext,
  loadingContext,
  makeBan,
  makeChat,
  makeTimer,
  pendingAi,
  pendingOp,
  proposalsMessage,
  readyContext,
  statusItem,
  timerItem,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "./kernel.fixtures.ts";
import { cloneSnapshot, emptySnapshot } from "./kernel/snapshot.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { DurationMinutes } from "./ids.ts";

function applied(snapshot: ProductSnapshot, event: CanonicalEvent) {
  return reduce(snapshot, event, kernelContext());
}

describe("Stage 2 Product Kernel", () => {
  it("exposes a pure deterministic reduce API at Stage 2", () => {
    expect(IMPLEMENTATION_STAGE).toBe(2);
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    const event = defaultEvent("CREATE_BAN.PRESS_START");
    const first = reduce(snapshot, event, kernelContext());
    const second = reduce(snapshot, event, kernelContext());
    expect(first.outcome).toBe("APPLIED");
    expect(second).toEqual(first);
    expect(first.controlState).toBe("CREATE_BAN.WHO");
  });

  it("does not mutate input snapshot or event objects", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    const before = cloneSnapshot(snapshot);
    const event = defaultEvent("CREATE_BAN.PRESS_START");
    const payload = { ...event.payload };
    reduce(snapshot, event, kernelContext());
    expect(snapshot).toEqual(before);
    expect(event.payload).toEqual(payload);
  });

  it("returns UNDEFINED for undefined state × event combinations without inventing IGNORE", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    const result = applied(snapshot, defaultEvent("REPLY_BAN.CHANGE_BAN_TEXT"));
    expect(result.outcome).toBe("UNDEFINED");
    expect(result.result).toBe("UNDEFINED");
    expect(result.effects).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.composition).toBe("UNDEFINED");
    expect(result.controlState).toBe("RIM.LOBBY");
  });

  it("APP.NORMAL_OPEN in an established Product Control State starts a new RIM.LOBBY session", () => {
    const chat = makeChat({ selectedContactId: CONTACT_A, inputDraft: "previous session" });
    const snapshot = withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat);
    const result = applied(snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("TRANSITION");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.traces[0]?.branch).toBe("normal-application-open");
    expect(result.snapshot.extended.rimChat).toBeNull();
    expect(result.snapshot.runtime.session).toBe("ACTIVE");
  });

  it("fails explicitly when multiple mutually exclusive branches match", () => {
    let snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    snapshot = withItems(snapshot, [statusItem(), timerItem({ fifoSequence: 2 })]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        priorities: { statusItemId: statusItem().id, timerItemId: TIMER_ITEM_ID },
      },
    };
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.SELECT_NEXT"));
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("MULTIPLE_BRANCHES_MATCHED");
    expect(result.error?.identities.length).toBeGreaterThan(1);
  });

  it("fails explicitly when a defined event has no matching required branch", () => {
    const snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    const result = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_FORBID"));
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
  });

  it("executes GLOBAL E-41 without a local row", () => {
    const { snapshot, event } = fixtureForRow(
      MATRIX_CONTRACT_ROWS.find((row) => row.id === "GLOBAL:GLOBAL:E-41:established-state")!,
    );
    const result = applied(snapshot, event);
    expect(result.outcome).toBe("APPLIED");
    expect(result.composition).toBe("GLOBAL_ONLY");
    expect(result.traces.map((trace) => trace.identity)).toEqual([
      "GLOBAL:GLOBAL:E-41:established-state",
    ]);
    expect(result.snapshot.extended.pendingExternalEntry).toBeNull();
    expect(result.controlState).toBe(snapshot.controlState);
  });

  it("executes LOCAL rules with LOCAL_ONLY composition", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    const result = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_START"));
    expect(result.composition).toBe("LOCAL_ONLY");
    expect(result.traces).toEqual([
      expect.objectContaining({
        identity: "LOCAL:RIM.LOBBY:E-01:default",
        kind: "LOCAL",
        branch: "default",
      }),
    ]);
  });

  it("composes E-32 as GLOBAL_THEN_LOCAL", () => {
    const snapshot = withEntities(
      withItems(withControlState(emptySnapshot(), "RIM.LOBBY"), [timerItem()]),
      { domainTimers: { "timer-1": makeTimer() } },
    );
    const withPriority = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
      },
    };
    const result = applied(withPriority, defaultEvent("APP.FULL_CLOSE"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("SESSION_END");
    expect(result.composition).toBe("GLOBAL_THEN_LOCAL");
    expect(result.traces.map((trace) => trace.identity)).toEqual([
      "GLOBAL:GLOBAL:E-32:timer-notification-item-overlay",
      "LOCAL:RIM.LOBBY:E-32:local",
    ]);
    expect(result.traces[0]?.order).toBe(0);
    expect(result.traces[1]?.order).toBe(1);
    expect(result.snapshot.runtime.session).toBe("CLOSED");
  });

  it("executes all five BOOTSTRAP rules", () => {
    const ids = MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "BOOTSTRAP").map((row) => row.id);
    expect(ids).toHaveLength(5);
    for (const id of ids) {
      const row = MATRIX_CONTRACT_ROWS.find((item) => item.id === id)!;
      const { snapshot, event } = fixtureForRow(row);
      const result = applied(snapshot, event);
      expect(result.outcome, id).toBe("APPLIED");
      expect(result.composition, id).toBe("BOOTSTRAP_ONLY");
      expect(result.traces[0]?.identity, id).toBe(id);
    }
  });

  it("resolves all eight E-43 branches exclusively", () => {
    const rows = MATRIX_CONTRACT_ROWS.filter((row) => row.kind === "E43");
    expect(rows).toHaveLength(8);
    const expectedStates = {
      "status-priority": "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
      "timer-priority": "NOTIFICATIONS.TIMER",
      "fifo-incoming-ban": "NOTIFICATIONS.INCOMING_BAN",
      "fifo-timer": "NOTIFICATIONS.TIMER",
      "fifo-check-receiver": "NOTIFICATIONS.CHECK.RECEIVER",
      "fifo-check-sender": "NOTIFICATIONS.CHECK.SENDER",
      "fifo-status": "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER",
      "queue-empty": "RIM.LOBBY",
    } as const;
    for (const row of rows) {
      const { snapshot, event } = fixtureForRow(row);
      const result = applied(snapshot, event);
      expect(result.outcome, row.branch).toBe("APPLIED");
      expect(result.composition, row.branch).toBe("E43_ONLY");
      expect(result.traces[0]?.identity).toBe(row.id);
      expect(result.controlState).toBe(expectedStates[row.branch as keyof typeof expectedStates]);
    }
  });

  it("processes Timer Notification Items on E-32 without mutating the domain Timer", () => {
    const timer = makeTimer();
    let snapshot = withControlState(emptySnapshot(), "RIM.CHAT");
    snapshot = withChat(snapshot, makeChat({ selectedContactId: CONTACT_A }));
    snapshot = withEntities(snapshot, {
      domainTimers: { "timer-1": timer },
      bans: { [BAN_ID]: makeBan() },
    });
    snapshot = withItems(snapshot, [timerItem()]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
      },
    };
    const beforeTimer = cloneSnapshot(snapshot).extended.entities.domainTimers["timer-1"];
    const result = applied(snapshot, defaultEvent("APP.FULL_CLOSE"));
    expect(result.effects.some((effect) => effect.type === "PROCESS_TIMER_NOTIFICATION_ITEM")).toBe(
      true,
    );
    expect(result.effects.map((effect) => effect.type)).not.toEqual(
      expect.arrayContaining([...APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES]),
    );
    expect(result.snapshot.extended.entities.domainTimers["timer-1"]).toEqual(beforeTimer);
    expect(
      result.snapshot.extended.entities.notificationItems[TIMER_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(result.snapshot.extended.priorities.timerItemId).toBeNull();
  });

  it("still allows E-42 after E-32 processed the Timer Notification Item", () => {
    const timer = makeTimer();
    let snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    snapshot = withEntities(snapshot, {
      domainTimers: { "timer-1": timer },
      bans: { [BAN_ID]: makeBan() },
    });
    snapshot = withItems(snapshot, [timerItem()]);
    const closed = applied(snapshot, defaultEvent("APP.FULL_CLOSE"));
    const reopened = withControlState(closed.snapshot, "RIM.LOBBY");
    const expired = applied(reopened, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(expired.outcome).toBe("APPLIED");
    expect(expired.traces.some((trace) => trace.eventId === "E-42")).toBe(true);
    expect(expired.effects.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER")).toBe(true);
    expect(expired.effects.some((effect) => effect.type === "UPSERT_CHECK_PAIR")).toBe(true);
    expect(expired.snapshot.extended.entities.domainTimers["timer-1"]?.state).toBe("EXPIRED");
  });

  it("implements RIM E-49 initial contact", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.SELECT_CONTACT");
    const result = applied(snapshot, eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }));
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.traces[0]?.branch).toBe("initial-selected-contact");
    expect(result.snapshot.extended.rimChat?.id.startsWith("rim-chat-")).toBe(true);
    expect(result.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_A);
    expect(result.snapshot.extended.rimChat?.messages).toEqual([]);
    expect(result.snapshot.extended.rimChat?.inputDraft).toBe("");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      true,
    );
  });

  it("implements RIM E-49 change contact", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"),
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: readyContext(),
        messages: [{ kind: "USER", text: "old" }],
        inputDraft: "old-draft",
        aiOperation: pendingAi(),
      }),
    );
    const result = applied(snapshot, eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }));
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.traces[0]?.branch).toBe("change-selected-contact");
    expect(result.snapshot.extended.rimChat?.id).not.toBe(CHAT_ID);
    expect(result.snapshot.extended.rimChat?.askRimOrigin).toBeNull();
    expect(result.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_B);
    expect(result.snapshot.extended.rimChat?.messages).toEqual([]);
    expect(result.snapshot.extended.rimChat?.inputDraft).toBe("");
    expect(result.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.selectedContactId).toBe(
      CONTACT_B,
    );
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      true,
    );
  });

  it("implements RIM E-49 same current contact without a new context request", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "RIM", text: "kept" }],
      inputDraft: "kept-draft",
      aiOperation: failedAi(),
    });
    const snapshot = withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), chat);
    const result = applied(snapshot, eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }));
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.traces[0]?.branch).toBe("same-current-selected-contact");
    expect(result.snapshot.extended.rimChat).toEqual(chat);
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      false,
    );
  });

  it("implements RIM E-56 current valid context as stay in RIM.CHAT", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.CHAT"),
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: loadingContext(),
      }),
    );
    const result = applied(
      snapshot,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("STAY");
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.traces[0]?.branch).toBe("current-contact");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.status).toBe("ready");
    expect(
      result.snapshot.extended.rimChat?.messages.some((message) => message.kind === "RIM"),
    ).toBe(true);
  });

  it("ignores stale RIM E-56 context for a replaced contact", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.CHAT"),
      makeChat({
        selectedContactId: CONTACT_B,
        relationshipContext: loadingContext(CONTACT_B, "context-new" as typeof REQUEST_ID),
      }),
    );
    const before = cloneSnapshot(snapshot);
    const result = applied(
      snapshot,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
    );
    expect(result.traces[0]?.branch).toBe("stale-contact");
    expect(result.result).toBe("IGNORE_NOT_ALLOWED");
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
  });

  it("applies background E-56 while still in RIM.SELECT_CONTACT without navigating", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"),
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: loadingContext(),
      }),
    );
    const result = applied(
      snapshot,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
    );
    expect(result.controlState).toBe("RIM.SELECT_CONTACT");
    expect(result.result).toBe("STAY");
    expect(result.traces[0]?.branch).toBe("no-new-selection-prior-contact");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.status).toBe("ready");
  });

  it("applies late server results without restoring the displaced scenario", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withOperation(snapshot, pendingOp({ supersededByExternalEntry: true }));
    snapshot = withItems(snapshot, [incomingItem()]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: INCOMING_ITEM_ID,
        createBanDraft: validCreateDraft("CONTACT"),
      },
    };
    const result = applied(
      snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.composition).toBe("GLOBAL_THEN_LOCAL");
    expect(result.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(result.traces.some((trace) => trace.eventId === "E-10")).toBe(true);
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.result).toBe("STAY");
    expect(result.snapshot.extended.entities.bans[BAN_ID]).toBeDefined();
    expect(result.snapshot.extended.priorities.statusItemId).toBeNull();
  });

  it("does not apply duplicate successful send results a second time", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, createBanDraft: validCreateDraft() },
    };
    snapshot = withOperation(snapshot, pendingOp());
    const first = applied(
      snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(first.outcome).toBe("APPLIED");
    expect(first.controlState).toBe("CREATE_BAN.SUCCESS");
    const second = applied(
      first.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(second.outcome).toBe("UNDEFINED");
    expect(second.effects).toEqual([]);
    expect(Object.keys(second.snapshot.extended.entities.bans)).toEqual(
      Object.keys(first.snapshot.extended.entities.bans),
    );
  });

  it("walks a representative Create Ban CONTACT flow", () => {
    let snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    snapshot = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_START")).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.WHO");
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.SELECT_CONTACT", { contactId: CONTACT_A }),
    ).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "no phones" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_NEXT")).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    const forbid = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_FORBID"));
    expect(forbid.controlState).toBe("CREATE_BAN.CONFIRM.CONTACT");
    expect(forbid.effects.some((effect) => effect.type === "START_OPERATION")).toBe(true);
    const op = Object.values(forbid.snapshot.runtime.pendingOperations)[0];
    const confirmed = applied(
      forbid.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", {
        operationId: op!.operationId,
        createdBanId: BAN_ID,
      }),
    );
    expect(confirmed.controlState).toBe("CREATE_BAN.SUCCESS");
  });

  it("walks a representative Create Ban TEMPLATE flow into SHARE_PENDING", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.WHO");
    snapshot = applied(snapshot, defaultEvent("CREATE_BAN.SELECT_TEMPLATE")).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "no phones" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_NEXT")).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
    const share = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_FORBID"));
    expect(share.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(share.effects.some((effect) => effect.type === "OPEN_TELEGRAM_SHARE")).toBe(true);
  });

  it("walks a representative Create Ban RIM flow and restores frozen chat on Back", () => {
    const frozen = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      inputDraft: "frozen-draft",
      messages: [{ kind: "USER", text: "frozen" }, proposalsMessage()],
    });
    let snapshot = withChat(withControlState(emptySnapshot(), "RIM.CHAT"), frozen);
    snapshot = applied(
      snapshot,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: frozen.id,
        proposalId: PROPOSAL_ID,
      }),
    ).snapshot;
    expect(snapshot.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(snapshot.extended.savedFrozenRimChat).toEqual(frozen);
    expect(snapshot.extended.createBanDraft).toEqual({
      origin: "RIM",
      selectedContactId: CONTACT_A,
      banText: "no phones",
      durationMinutes: null,
      proposalId: PROPOSAL_ID,
    });
    snapshot = applied(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 }),
    ).snapshot;
    const back = applied(snapshot, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(back.controlState).toBe("RIM.CHAT");
    expect(back.snapshot.extended.rimChat).toEqual(frozen);
    expect(back.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(back.snapshot.extended.createBanDraft).toBeNull();
  });

  it("walks a representative Reply Ban FROM_INCOMING_BAN flow", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, activeNotificationItemId: INCOMING_ITEM_ID },
    };
    snapshot = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN")).snapshot;
    expect(snapshot.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 3 }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_NEXT")).snapshot;
    expect(snapshot.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
  });

  it("walks a representative Reply Ban FROM_STATUS flow", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER");
    snapshot = withItems(snapshot, [
      statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: statusItem().id,
      },
    };
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(result.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(result.snapshot.extended.replySource?.kind).toBe("STATUS");
    expect(result.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
  });

  it("covers Notifications Status / Timer / Check transitions", () => {
    const timer = applied(
      fixtureForRow(
        MATRIX_CONTRACT_ROWS.find((row) => row.branch === "fifo-timer" && row.kind === "E43")!,
      ).snapshot,
      defaultEvent("NOTIFICATIONS.SELECT_NEXT"),
    );
    expect(timer.controlState).toBe("NOTIFICATIONS.TIMER");
    const check = applied(
      fixtureForRow(
        MATRIX_CONTRACT_ROWS.find(
          (row) => row.branch === "fifo-check-receiver" && row.kind === "E43",
        )!,
      ).snapshot,
      defaultEvent("NOTIFICATIONS.SELECT_NEXT"),
    );
    expect(check.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    const status = applied(
      fixtureForRow(
        MATRIX_CONTRACT_ROWS.find((row) => row.branch === "status-priority" && row.kind === "E43")!,
      ).snapshot,
      defaultEvent("NOTIFICATIONS.SELECT_NEXT"),
    );
    expect(status.controlState).toBe("NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER");
  });

  it("distinguishes Back draft preservation, clearing, and frozen RIM Chat restoration", () => {
    let confirm = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    confirm = {
      ...confirm,
      extended: { ...confirm.extended, createBanDraft: validCreateDraft() },
    };
    const preserved = applied(confirm, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(preserved.controlState).toBe("CREATE_BAN.WHAT.CONTACT");
    expect(preserved.snapshot.extended.createBanDraft).toEqual(validCreateDraft());

    let who = withControlState(emptySnapshot(), "CREATE_BAN.WHO");
    who = { ...who, extended: { ...who.extended, createBanDraft: validCreateDraft() } };
    const cleared = applied(who, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(cleared.controlState).toBe("RIM.LOBBY");
    expect(cleared.snapshot.extended.createBanDraft).toBeNull();

    const chat = makeChat({ selectedContactId: CONTACT_A, inputDraft: "draft" });
    const fromChat = applied(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      defaultEvent("RIM.PRESS_BACK"),
    );
    expect(fromChat.controlState).toBe("RIM.LOBBY");
    expect(fromChat.snapshot.extended.rimChat).toBeNull();
  });

  it("covers APP.NORMAL_OPEN bootstrap and APP.FULL_CLOSE lifecycle", () => {
    const open = applied(emptySnapshot(), defaultEvent("APP.NORMAL_OPEN"));
    expect(open.controlState).toBe("RIM.LOBBY");
    expect(open.traces[0]?.branch).toBe("normal-application-open");
    const closed = applied(open.snapshot, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.result).toBe("SESSION_END");
    expect(closed.snapshot.runtime.session).toBe("CLOSED");
    expect(closed.snapshot.controlState).toBeNull();
    expect(closed.composition).toBe("GLOBAL_THEN_LOCAL");
    const reopened = applied(closed.snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(reopened.outcome).toBe("APPLIED");
    expect(reopened.controlState).toBe("RIM.LOBBY");
    expect(reopened.snapshot.runtime.session).toBe("ACTIVE");
  });

  it("never emits a non-canonical Product Control State on applied paths", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    const result = applied(snapshot, defaultEvent("RIM.PRESS_START_CHAT"));
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.snapshot.extended.rimChat).toBeNull();
    expect(isProductControlState(result.controlState!)).toBe(true);
  });

  it("cannot execute intentionally absent E-36–E-40", () => {
    const snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    for (const id of ABSENT_EVENT_IDS) {
      const result = reduce(
        snapshot,
        { name: id, payload: {} } as unknown as CanonicalEvent,
        kernelContext(),
      );
      expect(result.outcome).toBe("KERNEL_INVARIANT");
      expect(result.error?.code).toBe("ABSENT_EVENT");
    }
  });

  it("records Matrix identities and composition order on every applied transition", () => {
    const result = applied(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      defaultEvent("APP.FULL_CLOSE"),
    );
    expect(result.traces.length).toBeGreaterThan(0);
    for (const trace of result.traces) {
      expect(MATRIX_CONTRACT_ROWS.some((row) => row.id === trace.identity)).toBe(true);
    }
  });
});

describe("Stage 2 representative extras", () => {
  it("does not cancel domain Timer fields merely because a Notification Item was processed", () => {
    const timer = makeTimer({ durationMinutes: 15 as DurationMinutes });
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.TIMER");
    snapshot = withEntities(snapshot, { domainTimers: { "timer-1": timer } });
    snapshot = withItems(snapshot, [
      timerItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: TIMER_ITEM_ID,
        priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
      },
    };
    const result = applied(snapshot, defaultEvent("APP.FULL_CLOSE"));
    const nextTimer = result.snapshot.extended.entities.domainTimers["timer-1"];
    expect(nextTimer?.durationMinutes).toBe(timer.durationMinutes);
    expect(nextTimer?.state).toBe("RUNNING");
    expect(nextTimer?.checkPairCreated).toBe(false);
    expect(nextTimer?.banId).toBe(timer.banId);
  });

  it("keeps pendingExternalEntry distinct from Product Control State during first-launch TTL", () => {
    const row = MATRIX_CONTRACT_ROWS.find(
      (item) => item.id === "BOOTSTRAP:BOOTSTRAP:E-44:first-launch-offline-unresolved",
    )!;
    const { snapshot, event } = fixtureForRow(row);
    const result = applied(snapshot, event);
    expect(result.controlState).toBeNull();
    expect(result.snapshot.extended.pendingExternalEntry).not.toBeNull();
    expect(result.snapshot.runtime.bootstrap.status).toBe("FIRST_LAUNCH_EXTERNAL_ENTRY");
  });

  it("does not let E-33 create RIM.LOBBY while first-launch External Entry is pending", () => {
    const row = MATRIX_CONTRACT_ROWS.find(
      (item) => item.id === "BOOTSTRAP:BOOTSTRAP:E-33:suppressed-while-pending-first-launch",
    )!;
    const { snapshot, event } = fixtureForRow(row);
    const result = applied(snapshot, event);
    expect(result.controlState).toBeNull();
    expect(result.result).toBe("STAY");
  });
});
