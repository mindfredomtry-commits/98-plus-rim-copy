import { describe, expect, it } from "vitest";
import type { AskRimOrigin } from "./entities.ts";
import type { AiRequestId, ContextRequestId, RimChatId } from "./ids.ts";
import {
  AI_REQUEST_ID,
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  CONTEXT_DATA,
  REQUEST_ID,
  STATUS_ITEM_ID,
  USER_ID,
  branded,
  defaultEvent,
  eventOf,
  failedAi,
  kernelContext,
  loadingContext,
  logicalAiSnapshot,
  makeChat,
  pendingAi,
  PROPOSAL_ID,
  proposalsMessage,
  readyContext,
  withChat,
  withControlState,
} from "./kernel.fixtures.ts";
import { reduce } from "./kernel/reduce.ts";
import { asInstant, cloneSnapshot, counterAllocator, emptySnapshot } from "./kernel/snapshot.ts";
import type { ExecutionContext, TransitionResult } from "./kernel/types.ts";
import type { Failure } from "./primitives.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { CanonicalEvent } from "./events.ts";

const ORIGIN: AskRimOrigin = {
  sourceStatusItemId: STATUS_ITEM_ID,
  banId: BAN_ID,
  status: "BANTASTIC",
  sourceRole: "SENDER",
};

const FAILURE = {} as Failure;
const OTHER_CHAT = branded<RimChatId>("chat-other");

function countingContext(): { context: ExecutionContext; aiAllocations: () => number } {
  const allocate = counterAllocator();
  let ai = 0;
  return {
    context: {
      now: asInstant(1_000_000),
      currentUserId: USER_ID,
      allocateId: (kind: string) => {
        if (kind === "ai") {
          ai += 1;
        }
        return allocate(kind);
      },
    },
    aiAllocations: () => ai,
  };
}

function run(
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
  context: ExecutionContext = kernelContext(),
): TransitionResult {
  return reduce(snapshot, event, context);
}

describe("MVP14 Pass 2 RIM chat lifecycle and logical request identity", () => {
  it("keeps RimChatId and Origin when the first CONTACT is selected", () => {
    const chat = makeChat({
      inputDraft: "keep me",
      messages: [{ kind: "RIM", text: "lobby" }],
      askRimOrigin: ORIGIN,
    });
    const result = run(
      withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), chat),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }),
    );
    const next = result.snapshot.extended.rimChat;
    expect(result.traces[0]?.branch).toBe("initial-selected-contact");
    expect(next?.id).toBe(CHAT_ID);
    expect(next?.askRimOrigin).toEqual(ORIGIN);
    expect(next?.messages).toEqual(chat.messages);
    expect(next?.inputDraft).toBe("keep me");
    expect(next?.selectedContactId).toBe(CONTACT_A);
    expect(next?.relationshipContext?.status).toBe("loading");
    expect(next?.aiOperation).toEqual({ status: "IDLE" });
  });

  it("preserves the entire Chat, including a non-null Origin, for the same CONTACT", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "kept" }],
      inputDraft: "kept-draft",
      aiOperation: failedAi(FAILURE, { userMessage: "kept" }),
      askRimOrigin: ORIGIN,
    });
    const result = run(
      withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), chat),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }),
    );
    expect(result.traces[0]?.branch).toBe("same-current-selected-contact");
    expect(result.snapshot.extended.rimChat).toEqual(chat);
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      false,
    );
  });

  it("terminates the old Chat when a different CONTACT is selected", () => {
    const previousContextId = branded<ContextRequestId>("context-old");
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(CONTACT_A, previousContextId),
      messages: [{ kind: "USER", text: "old" }],
      inputDraft: "old-draft",
      aiOperation: pendingAi({ userMessage: "old" }),
      askRimOrigin: ORIGIN,
    });
    const result = run(
      withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), chat),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }),
    );
    const next = result.snapshot.extended.rimChat;
    expect(result.traces[0]?.branch).toBe("change-selected-contact");
    expect(next?.id).not.toBe(chat.id);
    expect(next?.id.startsWith("rim-chat-")).toBe(true);
    expect(next?.askRimOrigin).toBeNull();
    expect(next?.selectedContactId).toBe(CONTACT_B);
    expect(next?.messages).toEqual([]);
    expect(next?.inputDraft).toBe("");
    expect(next?.aiOperation).toEqual({ status: "IDLE" });
    expect(next?.relationshipContext).toMatchObject({
      selectedContactId: CONTACT_B,
      status: "loading",
      data: null,
      failure: null,
    });
    expect(next?.relationshipContext?.requestId).not.toBe(previousContextId);
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      true,
    );
  });

  it("applies the current E-56 and ignores a late result for another RimChatId", () => {
    const current = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: loadingContext(),
    });
    const applied = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), current),
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
    );
    expect(applied.traces[0]?.branch).toBe("current-contact");
    expect(applied.snapshot.extended.rimChat?.id).toBe(CHAT_ID);
    expect(applied.snapshot.extended.rimChat?.relationshipContext?.status).toBe("ready");
    expect(applied.snapshot.extended.rimChat?.relationshipContext?.data).toEqual(CONTEXT_DATA);

    const staleBefore = cloneSnapshot(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), current),
    );
    const stale = run(
      staleBefore,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: OTHER_CHAT,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
    );
    expect(stale.outcome).toBe("APPLIED");
    expect(stale.result).toBe("IGNORE_NOT_ALLOWED");
    expect(stale.traces[0]?.branch).toBe("stale-contact");
    expect(stale.error).toBeNull();
    expect(stale.effects).toEqual([]);
    expect(stale.snapshot.extended.rimChat).toEqual(staleBefore.extended.rimChat);
  });

  it("stores the current E-57 failure and ignores a stale failure without a kernel invariant", () => {
    const current = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: loadingContext(),
    });
    const applied = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), current),
      eventOf("RIM.CONTEXT_FAILED", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        requestId: REQUEST_ID,
        failure: FAILURE,
      }),
    );
    expect(applied.traces[0]?.branch).toBe("current-contact");
    expect(applied.snapshot.extended.rimChat?.relationshipContext).toMatchObject({
      status: "error",
      requestId: REQUEST_ID,
      failure: FAILURE,
    });

    const staleBefore = cloneSnapshot(
      withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), current),
    );
    const stale = run(
      staleBefore,
      eventOf("RIM.CONTEXT_FAILED", {
        rimChatId: OTHER_CHAT,
        selectedContactId: CONTACT_A,
        requestId: REQUEST_ID,
        failure: FAILURE,
      }),
    );
    expect(stale.outcome).toBe("APPLIED");
    expect(stale.result).toBe("IGNORE_NOT_ALLOWED");
    expect(stale.traces[0]?.branch).toBe("stale-replaced-contact");
    expect(stale.error).toBeNull();
    expect(stale.effects).toEqual([]);
    expect(stale.snapshot.extended.rimChat).toEqual(staleBefore.extended.rimChat);
  });

  it("creates exactly one logical AI request and one USER message on E-52", () => {
    const { context, aiAllocations } = countingContext();
    const result = run(
      withChat(
        withControlState(emptySnapshot(), "RIM.CHAT"),
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          inputDraft: "ask this",
          messages: [{ kind: "RIM", text: "intro" }],
          askRimOrigin: ORIGIN,
        }),
      ),
      defaultEvent("RIM.PRESS_SEND"),
      context,
    );
    const chat = result.snapshot.extended.rimChat;
    const effect = result.effects.find((item) => item.type === "REQUEST_RIM_AI");
    expect(aiAllocations()).toBe(1);
    expect(chat?.messages.filter((message) => message.kind === "USER")).toEqual([
      { kind: "USER", text: "ask this" },
    ]);
    expect(chat?.inputDraft).toBe("");
    expect(chat?.askRimOrigin).toEqual(ORIGIN);
    expect(chat?.aiOperation.status).toBe("PENDING");
    if (chat?.aiOperation.status !== "PENDING" || effect?.type !== "REQUEST_RIM_AI") {
      throw new Error("E-52 did not retain a pending logical request");
    }
    expect(chat.aiOperation.requestId).toBe(chat.aiOperation.snapshot.requestId);
    expect(chat.aiOperation.snapshot).toEqual({
      requestId: chat.aiOperation.requestId,
      rimChatId: CHAT_ID,
      userMessage: "ask this",
      contextRequestId: REQUEST_ID,
    });
    expect(effect.requestId).toBe(chat.aiOperation.requestId);
    expect(effect.snapshot).toEqual(chat.aiOperation.snapshot);
  });

  it("retries the same logical request on E-54 and rejects a mismatched failedRequestId", () => {
    const snapshot = logicalAiSnapshot({ userMessage: "ask this" });
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      inputDraft: "mutated draft",
      messages: [{ kind: "USER", text: "ask this" }],
      aiOperation: failedAi(FAILURE, { userMessage: "ask this" }),
      askRimOrigin: ORIGIN,
    });
    const { context, aiAllocations } = countingContext();
    const retried = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      context,
    );
    const next = retried.snapshot.extended.rimChat;
    const effect = retried.effects.find((item) => item.type === "REQUEST_RIM_AI");
    expect(aiAllocations()).toBe(0);
    expect(next?.messages).toEqual(chat.messages);
    expect(next?.inputDraft).toBe("mutated draft");
    expect(next?.askRimOrigin).toEqual(ORIGIN);
    expect(next?.aiOperation).toEqual({ status: "PENDING", requestId: AI_REQUEST_ID, snapshot });
    expect(effect).toMatchObject({ type: "REQUEST_RIM_AI", requestId: AI_REQUEST_ID, snapshot });

    const before = cloneSnapshot(withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat));
    const mismatched = run(
      before,
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: branded<AiRequestId>("ai-other") }),
    );
    expect(mismatched.outcome).toBe("KERNEL_INVARIANT");
    expect(mismatched.error?.code).toBe("NO_BRANCH_MATCHED");
    expect(mismatched.effects).toEqual([]);
    expect(mismatched.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
  });

  it("completes only the current PENDING E-58 and does not resurrect FAILED or another Chat", () => {
    const pending = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "ask this" }],
      aiOperation: pendingAi({ userMessage: "ask this" }),
    });
    const applied = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), pending),
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        result: { kind: "MESSAGE", text: "done" },
      }),
    );
    expect(applied.traces[0]?.branch).toBe("current-request");
    expect(applied.snapshot.extended.rimChat?.aiOperation).toEqual({ status: "IDLE" });
    expect(applied.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "done",
    });

    const failed = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "ask this" }],
      aiOperation: failedAi(FAILURE, { userMessage: "ask this" }),
    });
    const failedBefore = cloneSnapshot(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), failed),
    );
    const resurrect = run(
      failedBefore,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        result: { kind: "MESSAGE", text: "too late" },
      }),
    );
    expect(resurrect.outcome).toBe("APPLIED");
    expect(resurrect.result).toBe("IGNORE_NOT_ALLOWED");
    expect(resurrect.traces[0]?.branch).toBe("stale-request");
    expect(resurrect.error).toBeNull();
    expect(resurrect.snapshot.extended.rimChat).toEqual(failedBefore.extended.rimChat);

    const wrongChatBefore = cloneSnapshot(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), pending),
    );
    const wrongChat = run(
      wrongChatBefore,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: OTHER_CHAT,
        requestId: AI_REQUEST_ID,
        result: { kind: "MESSAGE", text: "other chat" },
      }),
    );
    expect(wrongChat.result).toBe("IGNORE_NOT_ALLOWED");
    expect(wrongChat.error).toBeNull();
    expect(wrongChat.effects).toEqual([]);
    expect(wrongChat.snapshot.extended.rimChat).toEqual(wrongChatBefore.extended.rimChat);
  });

  it("moves the current PENDING request to FAILED with the same snapshot and ignores a stale E-59", () => {
    const snapshot = logicalAiSnapshot({ userMessage: "ask this" });
    const pending = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "ask this" }],
      aiOperation: pendingAi({ userMessage: "ask this" }),
    });
    const applied = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), pending),
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        failure: FAILURE,
      }),
    );
    expect(applied.traces[0]?.branch).toBe("current-request");
    expect(applied.snapshot.extended.rimChat?.messages).toEqual(pending.messages);
    expect(applied.snapshot.extended.rimChat?.aiOperation).toEqual({
      status: "FAILED",
      requestId: AI_REQUEST_ID,
      snapshot,
      failure: FAILURE,
    });

    const staleBefore = cloneSnapshot(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), pending),
    );
    const stale = run(
      staleBefore,
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: OTHER_CHAT,
        requestId: AI_REQUEST_ID,
        failure: FAILURE,
      }),
    );
    expect(stale.outcome).toBe("APPLIED");
    expect(stale.result).toBe("IGNORE_NOT_ALLOWED");
    expect(stale.traces[0]?.branch).toBe("stale-request");
    expect(stale.error).toBeNull();
    expect(stale.effects).toEqual([]);
    expect(stale.snapshot.extended.rimChat).toEqual(staleBefore.extended.rimChat);
  });

  it("does not let E-56—E-59 mutate a frozen Chat, and E-07 restores that Chat", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "USER", text: "frozen" }, proposalsMessage()],
      inputDraft: "frozen-draft",
      aiOperation: pendingAi({ userMessage: "frozen" }),
      askRimOrigin: ORIGIN,
    });
    const entered = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      }),
    );
    expect(entered.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(entered.snapshot.extended.savedFrozenRimChat).toEqual(chat);

    for (const event of [
      defaultEvent("RIM.CONTEXT_READY"),
      defaultEvent("RIM.CONTEXT_FAILED"),
      defaultEvent("RIM.AI_RESULT_RECEIVED"),
      defaultEvent("RIM.AI_REQUEST_FAILED"),
    ]) {
      const late = run(entered.snapshot, event);
      expect(late.outcome).toBe("APPLIED");
      expect(late.result).toBe("IGNORE_NOT_ALLOWED");
      expect(late.traces[0]?.branch).toBe("frozen-source-operation");
      expect(late.error).toBeNull();
      expect(late.effects).toEqual([]);
      expect(late.snapshot.extended.savedFrozenRimChat).toEqual(chat);
      expect(late.snapshot.extended.rimChat).toEqual(chat);
      expect(late.snapshot.extended.createBanDraft).toEqual(
        entered.snapshot.extended.createBanDraft,
      );
      expect(late.controlState).toBe("CREATE_BAN.WHAT.RIM");
    }

    const restored = run(entered.snapshot, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(restored.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.rimChat).toEqual(chat);
    expect(restored.snapshot.extended.rimChat?.id).toBe(CHAT_ID);
    expect(restored.snapshot.extended.rimChat?.askRimOrigin).toEqual(ORIGIN);
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
  });
});
