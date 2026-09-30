import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./events.ts";
import type { DurationMinutes } from "./ids.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import { MATRIX_CONTRACT_ROWS, PRODUCT_CONTROL_STATE_COUNT, reduce } from "./index.ts";
import { CANONICAL_EVENT_COUNT } from "./events.ts";
import {
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  PROPOSAL_ID,
  STATUS_ITEM_ID,
  defaultEvent,
  kernelContext,
  makeBan,
  makeChat,
  makeTimer,
  statusItem,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
} from "./kernel.fixtures.ts";
import { emptySnapshot } from "./kernel/snapshot.ts";

function applied(snapshot: ProductSnapshot, event: CanonicalEvent) {
  return reduce(snapshot, event, kernelContext());
}

function loadedSession(): ProductSnapshot {
  const rimChat = makeChat({
    selectedContactId: CONTACT_A,
    inputDraft: "previous session draft",
    messages: [{ kind: "USER", text: "old question" }],
  });
  const savedFrozenRimChat = makeChat({
    id: CHAT_ID,
    selectedContactId: CONTACT_A,
    inputDraft: "frozen",
  });
  let snapshot = withChat(withControlState(emptySnapshot(), "RIM.CHAT"), rimChat);
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        sourceProposalId: PROPOSAL_ID,
        status: "BANTASTIC",
        receiverId: CONTACT_A,
      }),
    },
    notificationItems: {
      [STATUS_ITEM_ID]: statusItem(),
    },
    domainTimers: {
      "timer-1": makeTimer(),
    },
  });
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      savedFrozenRimChat,
      createBanDraft: validCreateDraft("RIM"),
      replyBanDraft: { banText: "reply leftover", durationMinutes: 15 as DurationMinutes },
      telegramPersistentReentryEligible: true,
      telegramPersistentReentryEstablished: true,
      telegramPersistentReentryActiveRequestId: "reentry-request-1",
      telegramPersistentReentryCtaSurfaceGeneration: 4,
      telegramPersistentReentryCtaConsumedSurfaceGeneration: 3,
    },
  };
}

describe("E-33 Guard A session reset", () => {
  it("clears an old active RIM Chat and opens RIM.LOBBY", () => {
    const chat = makeChat({ selectedContactId: CONTACT_A, inputDraft: "still open" });
    const snapshot = withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat);
    const result = applied(snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.rimChat).toBeNull();
    expect(result.snapshot.runtime.session).toBe("ACTIVE");
  });

  it("clears a saved frozen RIM Chat", () => {
    const frozen = makeChat({ inputDraft: "frozen previous" });
    const snapshot = {
      ...withControlState(emptySnapshot(), "CREATE_BAN.WHAT.RIM"),
      extended: { ...emptySnapshot().extended, savedFrozenRimChat: frozen },
    };
    const result = applied(snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.savedFrozenRimChat).toBeNull();
  });

  it("clears a Create Ban draft", () => {
    const snapshot = {
      ...withControlState(emptySnapshot(), "CREATE_BAN.WHAT.CONTACT"),
      extended: { ...emptySnapshot().extended, createBanDraft: validCreateDraft("CONTACT") },
    };
    const result = applied(snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.createBanDraft).toBeNull();
  });

  it("clears a Reply Ban draft", () => {
    const snapshot = {
      ...withControlState(emptySnapshot(), "REPLY_BAN.WHAT.FROM_INCOMING_BAN"),
      extended: {
        ...emptySnapshot().extended,
        replyBanDraft: { banText: "unfinished reply", durationMinutes: 3 as DurationMinutes },
      },
    };
    const result = applied(snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("clears session slots from a loaded snapshot and keeps durable Product Facts", () => {
    const before = loadedSession();
    const result = applied(before, defaultEvent("APP.NORMAL_OPEN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces[0]?.identity).toBe("BOOTSTRAP:BOOTSTRAP:E-33:normal-application-open");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.rimChat).toBeNull();
    expect(result.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(result.snapshot.extended.createBanDraft).toBeNull();
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
    expect(result.snapshot.extended.entities.bans).toEqual(before.extended.entities.bans);
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.sourceProposalId).toBe(PROPOSAL_ID);
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("BANTASTIC");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.receiverId).toBe(CONTACT_A);
    expect(result.snapshot.extended.entities.notificationItems).toEqual(
      before.extended.entities.notificationItems,
    );
    expect(result.snapshot.extended.entities.domainTimers).toEqual(
      before.extended.entities.domainTimers,
    );
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryActiveRequestId).toBe(
      "reentry-request-1",
    );
    expect(result.snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration).toBe(5);
    expect(result.snapshot.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration).toBe(3);
  });

  it("does not let late E-56–E-59 restore the previous Chat", () => {
    const opened = applied(loadedSession(), defaultEvent("APP.NORMAL_OPEN"));
    expect(opened.snapshot.extended.rimChat).toBeNull();
    for (const name of [
      "RIM.CONTEXT_READY",
      "RIM.CONTEXT_FAILED",
      "RIM.AI_RESULT_RECEIVED",
      "RIM.AI_REQUEST_FAILED",
    ] as const) {
      const late = applied(opened.snapshot, defaultEvent(name));
      expect(late.snapshot.extended.rimChat).toBeNull();
      expect(late.snapshot.extended.savedFrozenRimChat).toBeNull();
      expect(late.controlState).toBe("RIM.LOBBY");
    }
  });

  it("keeps Guard B from opening Lobby or clearing session state", () => {
    const pending = applied(emptySnapshot(), defaultEvent("TELEGRAM_SHARE_LINK.OPENED"));
    expect(pending.snapshot.runtime.bootstrap.status).toBe("FIRST_LAUNCH_EXTERNAL_ENTRY");
    const chat = makeChat({ inputDraft: "first launch" });
    const withSlots: ProductSnapshot = {
      ...withChat(pending.snapshot, chat),
      extended: {
        ...withChat(pending.snapshot, chat).extended,
        savedFrozenRimChat: makeChat({ inputDraft: "frozen first" }),
        createBanDraft: validCreateDraft("CONTACT"),
        replyBanDraft: { banText: "keep", durationMinutes: null },
      },
    };
    const guarded = applied(withSlots, defaultEvent("APP.NORMAL_OPEN"));
    expect(guarded.outcome).toBe("APPLIED");
    expect(guarded.result).toBe("STAY");
    expect(guarded.controlState).toBeNull();
    expect(guarded.effects).toEqual([]);
    expect(guarded.traces[0]?.branch).toBe("suppressed-while-pending-first-launch");
    expect(guarded.snapshot.runtime.bootstrap.status).toBe("FIRST_LAUNCH_EXTERNAL_ENTRY");
    expect(guarded.snapshot.extended.rimChat).toEqual(chat);
    expect(guarded.snapshot.extended.savedFrozenRimChat?.inputDraft).toBe("frozen first");
    expect(guarded.snapshot.extended.createBanDraft).toEqual(validCreateDraft("CONTACT"));
    expect(guarded.snapshot.extended.replyBanDraft).toEqual({
      banText: "keep",
      durationMinutes: null,
    });

    const established = withControlState(withSlots, "RIM.CHAT");
    const stillGuarded = applied(established, defaultEvent("APP.NORMAL_OPEN"));
    expect(stillGuarded.outcome).toBe("UNDEFINED");
    expect(stillGuarded.controlState).toBe("RIM.CHAT");
    expect(stillGuarded.snapshot.extended.rimChat).toEqual(chat);
    expect(stillGuarded.snapshot.extended.createBanDraft).toEqual(validCreateDraft("CONTACT"));
  });

  it("does not add a Matrix row", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(58);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(351);
    const e33 = MATRIX_CONTRACT_ROWS.filter((row) => row.eventId === "E-33");
    expect(e33.map((row) => row.branch)).toEqual([
      "normal-application-open",
      "suppressed-while-pending-first-launch",
    ]);
    expect(e33[0]?.effects.map((effect) => effect.type)).toEqual([
      "SET_RIM_CHAT",
      "SET_FROZEN_RIM_CHAT",
      "SET_CREATE_BAN_DRAFT",
      "SET_REPLY_BAN_DRAFT",
      "SET_CONTROL_STATE",
    ]);
    expect(e33[1]?.effects).toEqual([]);
  });
});
