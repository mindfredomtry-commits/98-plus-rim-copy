import { describe, expect, it } from "vitest";
import type { RimAiResult, RimMessage } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type {
  AiRequestId,
  BanId,
  DurationMinutes,
  ExecutionProbability,
  ProposalId,
  RimChatId,
} from "./ids.ts";
import {
  AI_REQUEST_ID,
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  CONTEXT_DATA,
  OP_ID,
  PROPOSAL_ID,
  PROPOSAL_ID_2,
  PROPOSAL_ID_3,
  REQUEST_ID,
  SHARE_ATTEMPT_ID,
  USER_ID,
  applicationProposal,
  branded,
  defaultEvent,
  eventOf,
  kernelContext,
  makeBan,
  makeChat,
  pendingAi,
  pendingOp,
  proposalsMessage,
  readyContext,
  shareOp,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
  withOperation,
} from "./kernel.fixtures.ts";
import { reduce } from "./kernel/reduce.ts";
import { asInstant, counterAllocator, emptySnapshot } from "./kernel/snapshot.ts";
import type { ExecutionContext, TransitionResult } from "./kernel/types.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { Failure } from "./primitives.ts";
import type { ThreeSuggestions } from "./entities.ts";

const FAILURE = {} as Failure;
const OTHER_CHAT = branded<RimChatId>("chat-other");
const PROVIDER_PROPOSALS: ThreeSuggestions = [
  { banText: "canonical-ban-text", executionProbability: 0.2 as ExecutionProbability },
  { banText: "second", executionProbability: 0.5 as ExecutionProbability },
  { banText: "third", executionProbability: 0.9 as ExecutionProbability },
];

function countingContext(): {
  context: ExecutionContext;
  proposalAllocations: () => number;
} {
  const allocate = counterAllocator();
  let proposals = 0;
  return {
    context: {
      now: asInstant(1_000_000),
      currentUserId: USER_ID,
      allocateId: (kind: string) => {
        if (kind === "proposal") {
          proposals += 1;
        }
        return allocate(kind);
      },
    },
    proposalAllocations: () => proposals,
  };
}

function run(
  snapshot: ProductSnapshot,
  event: CanonicalEvent,
  context: ExecutionContext = kernelContext(),
): TransitionResult {
  return reduce(snapshot, event, context);
}

function pendingChat(messages: RimMessage[] = []): ProductSnapshot {
  return withChat(
    withControlState(emptySnapshot(), "RIM.CHAT"),
    makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      aiOperation: pendingAi(),
      messages,
    }),
  );
}

function proposalIdsOf(snapshot: ProductSnapshot): string[] {
  const ids: string[] = [];
  for (const message of snapshot.extended.rimChat?.messages ?? []) {
    if (message.kind === "BAN_PROPOSALS") {
      ids.push(...message.proposals.map((proposal) => proposal.proposalId));
    }
  }
  return ids;
}

function aiResult(
  requestId: AiRequestId,
  result: RimAiResult,
  rimChatId: RimChatId = CHAT_ID,
): CanonicalEvent {
  return eventOf("RIM.AI_RESULT_RECEIVED", { rimChatId, requestId, result });
}

describe("MVP14 Pass 3 canonical proposal attribution", () => {
  it("mints exactly three proposal ids for a valid BAN_PROPOSALS result", () => {
    const { context, proposalAllocations } = countingContext();
    for (const providerProposal of PROVIDER_PROPOSALS) {
      expect(providerProposal).not.toHaveProperty("proposalId");
    }
    const received = run(
      pendingChat(),
      aiResult(AI_REQUEST_ID, {
        kind: "BAN_PROPOSALS",
        message: "three bans",
        proposals: PROVIDER_PROPOSALS,
      }),
      context,
    );
    expect(received.outcome).toBe("APPLIED");
    expect(proposalAllocations()).toBe(3);
    const stored = received.snapshot.extended.rimChat?.messages.at(-1);
    expect(stored?.kind).toBe("BAN_PROPOSALS");
    if (stored?.kind !== "BAN_PROPOSALS") return;
    expect(stored.proposals.map((proposal) => proposal.proposalId)).toEqual([
      "proposal-1",
      "proposal-2",
      "proposal-3",
    ]);
    expect(new Set(stored.proposals.map((proposal) => proposal.proposalId)).size).toBe(3);
    expect(stored.proposals.map((proposal) => proposal.banText)).toEqual([
      "canonical-ban-text",
      "second",
      "third",
    ]);
  });

  it("mints no proposal ids for MESSAGE, stale E-58, or E-59", () => {
    const message = countingContext();
    const messaged = run(
      pendingChat([{ kind: "USER", text: "kept" }]),
      aiResult(AI_REQUEST_ID, { kind: "MESSAGE", text: "answer" }),
      message.context,
    );
    expect(messaged.outcome).toBe("APPLIED");
    expect(message.proposalAllocations()).toBe(0);
    expect(proposalIdsOf(messaged.snapshot)).toEqual([]);
    expect(messaged.snapshot.extended.rimChat?.messages.at(-1)).toEqual({
      kind: "RIM",
      text: "answer",
    });

    const stale = countingContext();
    const before = pendingChat();
    const ignored = run(
      before,
      aiResult(
        AI_REQUEST_ID,
        { kind: "BAN_PROPOSALS", message: "three bans", proposals: PROVIDER_PROPOSALS },
        OTHER_CHAT,
      ),
      stale.context,
    );
    expect(ignored.result).toBe("IGNORE_NOT_ALLOWED");
    expect(ignored.effects).toEqual([]);
    expect(stale.proposalAllocations()).toBe(0);
    expect(ignored.snapshot.extended.rimChat).toEqual(before.extended.rimChat);

    const failed = countingContext();
    const failure = run(
      pendingChat(),
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        failure: FAILURE,
      }),
      failed.context,
    );
    expect(failure.outcome).toBe("APPLIED");
    expect(failure.snapshot.extended.rimChat?.aiOperation.status).toBe("FAILED");
    expect(failed.proposalAllocations()).toBe(0);
    expect(proposalIdsOf(failure.snapshot)).toEqual([]);

    const staleFailure = countingContext();
    const staleFailed = run(
      pendingChat(),
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: OTHER_CHAT,
        requestId: AI_REQUEST_ID,
        failure: FAILURE,
      }),
      staleFailure.context,
    );
    expect(staleFailed.result).toBe("IGNORE_NOT_ALLOWED");
    expect(staleFailure.proposalAllocations()).toBe(0);
    expect(proposalIdsOf(staleFailed.snapshot)).toEqual([]);
  });

  it("keeps earlier proposal ids across later turns and drops them only with the old Chat", () => {
    const { context } = countingContext();
    const first = run(
      pendingChat(),
      aiResult(AI_REQUEST_ID, {
        kind: "BAN_PROPOSALS",
        message: "first",
        proposals: PROVIDER_PROPOSALS,
      }),
      context,
    );
    const firstIds = proposalIdsOf(first.snapshot);
    expect(firstIds).toEqual(["proposal-1", "proposal-2", "proposal-3"]);

    const drafted = run(
      first.snapshot,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "again" }),
      context,
    );
    const sent = run(drafted.snapshot, defaultEvent("RIM.PRESS_SEND"), context);
    const requestId =
      sent.snapshot.extended.rimChat?.aiOperation.status === "PENDING"
        ? sent.snapshot.extended.rimChat.aiOperation.requestId
        : AI_REQUEST_ID;
    const afterMessage = run(
      sent.snapshot,
      aiResult(requestId, { kind: "MESSAGE", text: "later" }),
      context,
    );
    expect(proposalIdsOf(afterMessage.snapshot)).toEqual(firstIds);

    const draftedAgain = run(
      afterMessage.snapshot,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "third turn" }),
      context,
    );
    const sentAgain = run(draftedAgain.snapshot, defaultEvent("RIM.PRESS_SEND"), context);
    const nextRequest =
      sentAgain.snapshot.extended.rimChat?.aiOperation.status === "PENDING"
        ? sentAgain.snapshot.extended.rimChat.aiOperation.requestId
        : requestId;
    const afterSecond = run(
      sentAgain.snapshot,
      aiResult(nextRequest, {
        kind: "BAN_PROPOSALS",
        message: "second",
        proposals: PROVIDER_PROPOSALS,
      }),
      context,
    );
    const afterSecondIds = proposalIdsOf(afterSecond.snapshot);
    expect(afterSecondIds.slice(0, 3)).toEqual(firstIds);
    expect(new Set(afterSecondIds).size).toBe(6);
    expect(afterSecondIds.slice(3).filter((id) => firstIds.includes(id))).toEqual([]);

    const sameContact = run(
      withControlState(afterSecond.snapshot, "RIM.SELECT_CONTACT"),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }),
      context,
    );
    expect(sameContact.snapshot.extended.rimChat?.id).toBe(CHAT_ID);
    expect(proposalIdsOf(sameContact.snapshot)).toEqual(proposalIdsOf(afterSecond.snapshot));

    const differentContact = run(
      withControlState(afterSecond.snapshot, "RIM.SELECT_CONTACT"),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }),
      context,
    );
    expect(differentContact.snapshot.extended.rimChat?.id).not.toBe(CHAT_ID);
    expect(proposalIdsOf(differentContact.snapshot)).toEqual([]);
  });

  it("selects a proposal only from the current Chat and ignores every other E-55", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [
        proposalsMessage([
          applicationProposal(PROPOSAL_ID, "canonical-ban-text", 0.2 as ExecutionProbability),
          applicationProposal(PROPOSAL_ID_2, "second"),
          applicationProposal(branded<ProposalId>("proposal-3"), "third"),
        ]),
      ],
    });
    const snapshot = withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat);
    const event = eventOf("RIM.PRESS_SUGGESTION_FORBID", {
      rimChatId: CHAT_ID,
      proposalId: PROPOSAL_ID,
    });
    expect(Object.keys(event.payload).sort()).toEqual(["proposalId", "rimChatId"]);

    const selected = run(snapshot, event);
    expect(selected.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(selected.snapshot.extended.createBanDraft).toEqual({
      origin: "RIM",
      selectedContactId: CONTACT_A,
      banText: "canonical-ban-text",
      durationMinutes: null,
      proposalId: PROPOSAL_ID,
    });
    expect(selected.snapshot.extended.savedFrozenRimChat).toEqual(chat);
    expect(Object.values(selected.snapshot.extended.entities.bans)).toEqual([]);

    const unknown = run(
      snapshot,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: branded<ProposalId>("proposal-missing"),
      }),
    );
    expect(unknown.result).toBe("IGNORE_NOT_ALLOWED");
    expect(unknown.traces[0]?.branch).toBe("invalid-proposal");
    expect(unknown.effects).toEqual([]);
    expect(unknown.controlState).toBe("RIM.CHAT");
    expect(unknown.snapshot.extended.createBanDraft).toBeNull();

    const otherChatProposal = run(
      snapshot,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: branded<ProposalId>("proposal-from-other-chat"),
      }),
    );
    expect(otherChatProposal.result).toBe("IGNORE_NOT_ALLOWED");
    expect(otherChatProposal.traces[0]?.branch).toBe("invalid-proposal");
    expect(otherChatProposal.snapshot.extended.rimChat).toEqual(chat);

    const wrongChat = run(
      snapshot,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: OTHER_CHAT,
        proposalId: PROPOSAL_ID,
      }),
    );
    expect(wrongChat.result).toBe("IGNORE_NOT_ALLOWED");
    expect(wrongChat.traces[0]?.branch).toBe("invalid-proposal");
    expect(wrongChat.snapshot.extended.rimChat).toEqual(chat);

    const linked = run(
      withEntities(snapshot, {
        bans: { [BAN_ID]: makeBan({ sourceProposalId: PROPOSAL_ID }) },
      }),
      event,
    );
    expect(linked.result).toBe("IGNORE_NOT_ALLOWED");
    expect(linked.traces[0]?.branch).toBe("invalid-proposal");
    expect(linked.snapshot.extended.createBanDraft).toBeNull();
    expect(linked.snapshot.extended.rimChat).toEqual(chat);
  });

  it("freezes the Chat, keeps proposalId through editing, and reselects the same id after Back", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      inputDraft: "frozen-draft",
      messages: [proposalsMessage()],
      aiOperation: pendingAi(),
    });
    const entered = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      }),
    );
    expect(entered.snapshot.extended.savedFrozenRimChat).toEqual(chat);
    const frozenIds =
      entered.snapshot.extended.savedFrozenRimChat?.messages.flatMap((message) =>
        message.kind === "BAN_PROPOSALS"
          ? message.proposals.map((proposal) => proposal.proposalId)
          : [],
      ) ?? [];
    expect(frozenIds).toEqual([PROPOSAL_ID, PROPOSAL_ID_2, PROPOSAL_ID_3]);

    const edited = run(
      entered.snapshot,
      eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "user edited text" }),
    );
    expect(edited.snapshot.extended.createBanDraft).toMatchObject({
      banText: "user edited text",
      proposalId: PROPOSAL_ID,
      durationMinutes: null,
    });
    const frozenProposal = edited.snapshot.extended.savedFrozenRimChat?.messages.find(
      (message) => message.kind === "BAN_PROPOSALS",
    );
    expect(
      frozenProposal?.kind === "BAN_PROPOSALS" ? frozenProposal.proposals[0]?.banText : null,
    ).toBe("no phones");

    const timed = run(
      edited.snapshot,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 }),
    );
    expect(timed.snapshot.extended.createBanDraft?.proposalId).toBe(PROPOSAL_ID);
    expect(timed.snapshot.extended.createBanDraft?.durationMinutes).toBe(5);

    const confirmed = run(timed.snapshot, defaultEvent("CREATE_BAN.PRESS_NEXT"));
    expect(confirmed.controlState).toBe("CREATE_BAN.CONFIRM.RIM");
    expect(confirmed.snapshot.extended.createBanDraft).toEqual(
      timed.snapshot.extended.createBanDraft,
    );

    const backToWhat = run(confirmed.snapshot, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(backToWhat.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(backToWhat.snapshot.extended.createBanDraft?.proposalId).toBe(PROPOSAL_ID);
    expect(backToWhat.snapshot.extended.savedFrozenRimChat).toEqual(chat);

    const restored = run(backToWhat.snapshot, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(restored.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.rimChat).toEqual(chat);
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(Object.values(restored.snapshot.extended.entities.bans)).toEqual([]);

    const reselected = run(
      restored.snapshot,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      }),
    );
    expect(reselected.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(reselected.snapshot.extended.createBanDraft?.proposalId).toBe(PROPOSAL_ID);
    expect(reselected.snapshot.extended.createBanDraft?.banText).toBe("no phones");
  });

  it("attributes a successful RIM Ban from the captured send draft and terminates the source Chat", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [proposalsMessage()],
    });
    let snapshot = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).snapshot;
    snapshot = run(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "final text" }),
    ).snapshot;
    snapshot = run(
      snapshot,
      eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 }),
    ).snapshot;
    snapshot = run(snapshot, defaultEvent("CREATE_BAN.PRESS_NEXT")).snapshot;

    const started = run(snapshot, defaultEvent("CREATE_BAN.PRESS_FORBID"));
    expect(started.controlState).toBe("CREATE_BAN.CONFIRM.RIM");
    const operation = Object.values(started.snapshot.runtime.pendingOperations)[0];
    expect(operation?.sendDraft?.proposalId).toBe(PROPOSAL_ID);
    expect(Object.values(started.snapshot.extended.entities.bans)).toEqual([]);

    const failed = run(
      started.snapshot,
      eventOf("CREATE_BAN.SEND_FAILED", {
        operationId: operation!.operationId,
        failure: FAILURE,
      }),
    );
    expect(failed.outcome).toBe("APPLIED");
    expect(Object.values(failed.snapshot.extended.entities.bans)).toEqual([]);
    expect(failed.snapshot.extended.createBanDraft?.proposalId).toBe(PROPOSAL_ID);
    expect(failed.snapshot.extended.savedFrozenRimChat).toEqual(chat);

    const restarted = run(failed.snapshot, defaultEvent("CREATE_BAN.PRESS_FORBID"));
    const retry = Object.values(restarted.snapshot.runtime.pendingOperations)[0];
    const created = run(
      restarted.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", {
        operationId: retry!.operationId,
        createdBanId: BAN_ID,
      }),
    );
    expect(created.outcome).toBe("APPLIED");
    expect(created.controlState).toBe("CREATE_BAN.SUCCESS");
    const ban = created.snapshot.extended.entities.bans[BAN_ID];
    expect(ban?.id).toBe(BAN_ID);
    expect(ban?.sourceProposalId).toBe(PROPOSAL_ID);
    expect(ban?.banText).toBe("final text");
    expect(created.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(created.snapshot.extended.rimChat).toBeNull();
    expect(created.snapshot.extended.createBanDraft).toBeNull();
    expect(created.snapshot.extended.successfulBanId).toBe(BAN_ID);
    const incoming = Object.values(created.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "INCOMING_BAN",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.ownerId).toBe(CONTACT_A);
    expect(incoming[0]?.banId).toBe(BAN_ID);
    expect(incoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(created.snapshot.extended.activeNotificationItemId).not.toBe(incoming[0]?.id);
    expect(created.controlState).toBe("CREATE_BAN.SUCCESS");

    const replay = run(
      created.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", {
        operationId: retry!.operationId,
        createdBanId: BAN_ID,
      }),
    );
    const replayIncoming = Object.values(
      replay.snapshot.extended.entities.notificationItems,
    ).filter((item) => item.kind === "INCOMING_BAN" && item.banId === BAN_ID);
    expect(replayIncoming).toHaveLength(1);
    expect(replayIncoming[0]?.id).toBe(incoming[0]?.id);

    const restored = run(created.snapshot, defaultEvent("CREATE_BAN.PRESS_BACK"));
    expect(restored.snapshot.extended.rimChat).toBeNull();
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();
    for (const event of [
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      }),
      eventOf("RIM.CONTEXT_FAILED", {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        requestId: REQUEST_ID,
        failure: FAILURE,
      }),
      aiResult(AI_REQUEST_ID, {
        kind: "BAN_PROPOSALS",
        message: "late",
        proposals: PROVIDER_PROPOSALS,
      }),
      eventOf("RIM.AI_REQUEST_FAILED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        failure: FAILURE,
      }),
    ]) {
      const late = run(created.snapshot, event);
      expect(late.snapshot.extended.rimChat).toBeNull();
      expect(late.snapshot.extended.savedFrozenRimChat).toBeNull();
      expect(late.controlState).not.toBe("RIM.CHAT");
    }

    const duplicate = run(
      withEntities(
        withOperation(
          {
            ...withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.RIM"),
            extended: {
              ...emptySnapshot().extended,
              createBanDraft: {
                origin: "RIM",
                selectedContactId: CONTACT_A,
                banText: "another",
                durationMinutes: 5 as DurationMinutes,
                proposalId: PROPOSAL_ID,
              },
            },
          },
          pendingOp({
            originatingState: "CREATE_BAN.CONFIRM.RIM",
            sendDraft: {
              origin: "RIM",
              selectedContactId: CONTACT_A,
              banText: "another",
              durationMinutes: 5 as DurationMinutes,
              proposalId: PROPOSAL_ID,
            },
          }),
        ),
        { bans: { [BAN_ID]: ban! } },
      ),
      eventOf("CREATE_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        createdBanId: branded<BanId>("ban-second"),
      }),
    );
    expect(duplicate.outcome).toBe("KERNEL_INVARIANT");
    expect(duplicate.snapshot.extended.entities.bans[BAN_ID]?.sourceProposalId).toBe(PROPOSAL_ID);
    expect(duplicate.snapshot.extended.entities.bans[branded<BanId>("ban-second")]).toBeUndefined();
  });

  it("stores null sourceProposalId for CONTACT and TEMPLATE Bans", () => {
    const contactChat = makeChat({ selectedContactId: CONTACT_A });
    const contact = run(
      withOperation(
        {
          ...withChat(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT"), contactChat),
          extended: {
            ...withChat(
              withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT"),
              contactChat,
            ).extended,
            createBanDraft: validCreateDraft("CONTACT"),
          },
        },
        pendingOp({
          originatingState: "CREATE_BAN.CONFIRM.CONTACT",
          sendDraft: {
            origin: "CONTACT",
            selectedContactId: CONTACT_A,
            banText: "no phones",
            durationMinutes: 3 as DurationMinutes,
            proposalId: null,
          },
        }),
      ),
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(contact.outcome).toBe("APPLIED");
    expect(contact.snapshot.extended.entities.bans[BAN_ID]?.sourceProposalId).toBeNull();
    expect(contact.snapshot.extended.rimChat).toEqual(contactChat);

    const template = run(
      withEntities(withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING"), {
        shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() },
      }),
      defaultEvent("CREATE_BAN.SHARE_CONFIRMED"),
    );
    expect(template.outcome).toBe("APPLIED");
    expect(
      Object.values(template.snapshot.extended.entities.bans).map((ban) => ban.sourceProposalId),
    ).toEqual([null]);
  });

  it("clears the live RIM Chat when frozen authority already terminates it", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [proposalsMessage()],
    });
    const what = run(
      withChat(withControlState(emptySnapshot(), "RIM.CHAT"), chat),
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).snapshot;
    const closed = run(what, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.result).toBe("SESSION_END");
    expect(closed.snapshot.extended.rimChat).toBeNull();
    expect(closed.snapshot.extended.savedFrozenRimChat).toBeNull();
    expect(closed.snapshot.extended.createBanDraft).toBeNull();

    const displaced = run(what, defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"));
    expect(displaced.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(displaced.snapshot.extended.rimChat).toBeNull();
    expect(displaced.snapshot.extended.savedFrozenRimChat).toBeNull();

    let confirm = run(what, eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 5 })).snapshot;
    confirm = run(confirm, defaultEvent("CREATE_BAN.PRESS_NEXT")).snapshot;
    expect(confirm.controlState).toBe("CREATE_BAN.CONFIRM.RIM");
    const confirmClosed = run(confirm, defaultEvent("APP.FULL_CLOSE"));
    expect(confirmClosed.snapshot.extended.rimChat).toBeNull();
    expect(confirmClosed.snapshot.extended.savedFrozenRimChat).toBeNull();
    const confirmDisplaced = run(confirm, defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"));
    expect(confirmDisplaced.snapshot.extended.rimChat).toBeNull();
    expect(confirmDisplaced.snapshot.extended.savedFrozenRimChat).toBeNull();
  });
});
