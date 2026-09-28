import type {
  Ban,
  CheckPair,
  CheckNotificationItem,
  IncomingBanNotificationItem,
  ReplySource,
  ShareOperation,
  StatusNotificationItem,
} from "../entities.ts";
import type { Effect } from "../effects.ts";
import type { CanonicalEvent } from "../events.ts";
import type { PendingOperation, PendingSendDraft, ProductSnapshot } from "../extended-state.ts";
import type { MatrixContractRow } from "../matrix.ts";
import type {
  BanId,
  CheckPairId,
  ContextRequestId,
  DomainTimerId,
  DurationMinutes,
  NotificationItemId,
  OperationId,
  ProposalId,
  ShareAttemptId,
  ShareLinkId,
  UserId,
} from "../ids.ts";
import type {
  BanStatus,
  CheckAnswer,
  CheckDerivedStatus,
  ConnectionState,
  Role,
  ShareToken,
} from "../primitives.ts";
import { isValidBanText, isValidDurationMinutes } from "../primitives.ts";
import type { ProductControlState } from "../states.ts";
import { nextCreateDraft, nextReplyDraft, nextRimChat } from "./effects.ts";
import { correlatedPendingOperation } from "./evaluate-guard.ts";
import {
  activeItem,
  nextFifoSequence,
  timerNotificationItemForBan,
  unprocessedItems,
  unprocessedTimerItems,
} from "./snapshot.ts";
import type { KernelError, ResolveInput } from "./types.ts";

/**
 * Instantiates Matrix-declared effect kinds into snapshot mutations.
 * Product decisions remain on the authoritative Matrix row; this module only
 * interprets declared effect kinds (and the row's effectsText) into entities.
 * It is not a second product transition table.
 */

export type InstantiateOptions = Readonly<{
  suppressImmediateUi?: boolean;
}>;

export type InstantiatedEffects =
  { ok: true; effects: Effect[] } | { ok: false; error: KernelError };

function eventField<T>(event: CanonicalEvent, key: string): T | undefined {
  return (event.payload as Record<string, T | undefined>)[key];
}

function missing(row: MatrixContractRow, message: string): InstantiatedEffects {
  return {
    ok: false,
    error: {
      code: "MISSING_REQUIRED_DATA",
      message,
      identities: [row.id],
    },
  };
}

function otherParticipant(ban: Ban, currentUserId: UserId): UserId | null {
  if (ban.senderId === currentUserId) {
    return ban.receiverId;
  }
  if (ban.receiverId === currentUserId) {
    return ban.senderId;
  }
  return null;
}

function replySourceOf(input: ResolveInput): ReplySource | null {
  return eventField<ReplySource>(input.event, "source") ?? input.snapshot.extended.replySource;
}

function captureSendDraft(
  kind: PendingOperation["kind"],
  snapshot: ProductSnapshot,
): PendingSendDraft | null {
  if (kind === "REPLY_BAN_SEND") {
    const draft = snapshot.extended.replyBanDraft;
    if (
      draft &&
      isValidBanText(draft.banText) &&
      draft.durationMinutes !== null &&
      isValidDurationMinutes(draft.durationMinutes)
    ) {
      return {
        banText: draft.banText,
        durationMinutes: draft.durationMinutes,
        selectedContactId: null,
        origin: null,
        proposalId: null,
      };
    }
  }
  if (kind === "CREATE_BAN_SEND") {
    const draft = snapshot.extended.createBanDraft;
    if (
      draft &&
      isValidBanText(draft.banText) &&
      draft.durationMinutes !== null &&
      isValidDurationMinutes(draft.durationMinutes)
    ) {
      return {
        banText: draft.banText,
        durationMinutes: draft.durationMinutes,
        selectedContactId: draft.selectedContactId,
        origin: draft.origin,
        proposalId: draft.proposalId,
      };
    }
  }
  return null;
}

function replySendFacts(input: ResolveInput): {
  banText: string;
  durationMinutes: DurationMinutes;
} | null {
  const sessionDraft = input.snapshot.extended.replyBanDraft;
  const captured = correlatedPendingOperation(input)?.sendDraft ?? null;
  const banText = sessionDraft?.banText ?? captured?.banText;
  const durationMinutes = sessionDraft?.durationMinutes ?? captured?.durationMinutes ?? null;
  if (
    !banText ||
    !isValidBanText(banText) ||
    durationMinutes === null ||
    !isValidDurationMinutes(durationMinutes)
  ) {
    return null;
  }
  return { banText, durationMinutes };
}

function createBanSendFacts(input: ResolveInput): {
  banText: string;
  durationMinutes: DurationMinutes;
  selectedContactId: UserId | null;
  origin: NonNullable<PendingSendDraft["origin"]> | null;
  proposalId: ProposalId | null;
} | null {
  const sessionDraft = input.snapshot.extended.createBanDraft;
  const captured = correlatedPendingOperation(input)?.sendDraft ?? null;
  const banText = sessionDraft?.banText ?? captured?.banText;
  const durationMinutes = sessionDraft?.durationMinutes ?? captured?.durationMinutes ?? null;
  const origin = sessionDraft?.origin ?? captured?.origin ?? null;
  const selectedContactId = sessionDraft?.selectedContactId ?? captured?.selectedContactId ?? null;
  const proposalId = captured?.proposalId ?? sessionDraft?.proposalId ?? null;
  if (
    !banText ||
    !isValidBanText(banText) ||
    durationMinutes === null ||
    !isValidDurationMinutes(durationMinutes)
  ) {
    return null;
  }
  return { banText, durationMinutes, selectedContactId, origin, proposalId };
}

function matchingShare(input: ResolveInput): ShareOperation | null {
  const attemptId = eventField<ShareAttemptId>(input.event, "shareAttemptId");
  if (!attemptId) {
    return null;
  }
  return input.snapshot.extended.entities.shareOperations[attemptId] ?? null;
}

function receiverIncomingExists(
  snapshot: ProductSnapshot,
  effects: readonly Effect[],
  banId: BanId,
  receiverId: UserId,
): boolean {
  if (
    Object.values(snapshot.extended.entities.notificationItems).some(
      (item) => item.kind === "INCOMING_BAN" && item.banId === banId && item.ownerId === receiverId,
    )
  ) {
    return true;
  }
  return effects.some(
    (effect) =>
      effect.type === "UPSERT_NOTIFICATION_ITEM" &&
      effect.item.kind === "INCOMING_BAN" &&
      effect.item.banId === banId &&
      effect.item.ownerId === receiverId,
  );
}

function ensureReceiverIncoming(
  input: ResolveInput,
  effects: Effect[],
  row: MatrixContractRow,
  banId: BanId | undefined,
  receiverId: UserId | null | undefined,
  fifoSequence: number,
  waiting: "WAITING" | "ACTIVE",
): InstantiatedEffects | null {
  if (!banId || !receiverId) {
    return missing(row, "INCOMING_BAN Item requires the created Ban and its receiver");
  }
  if (receiverIncomingExists(input.snapshot, effects, banId, receiverId)) {
    return null;
  }
  const item: IncomingBanNotificationItem = {
    id: input.context.allocateId("notification") as NotificationItemId,
    ownerId: receiverId,
    banId,
    fifoSequence,
    lifecycle: { status: "UNPROCESSED", display: waiting },
    kind: "INCOMING_BAN",
  };
  effects.push({ type: "UPSERT_NOTIFICATION_ITEM", item });
  return null;
}

function display(suppressImmediateUi: boolean, active: boolean): "WAITING" | "ACTIVE" {
  if (suppressImmediateUi) {
    return "WAITING";
  }
  return active ? "ACTIVE" : "WAITING";
}

function existingStatusItems(snapshot: ResolveInput["snapshot"], banId: BanId, status: BanStatus) {
  return Object.values(snapshot.extended.entities.notificationItems).filter(
    (item): item is StatusNotificationItem =>
      item.kind === "STATUS" && item.banId === banId && item.status === status,
  );
}

function instantiateE22Pair(row: MatrixContractRow, input: ResolveInput): InstantiatedEffects {
  const pairId = eventField<CheckPairId>(input.event, "checkPairId");
  const itemId = eventField<NotificationItemId>(input.event, "checkItemId");
  const answer = eventField<CheckAnswer>(input.event, "answer");
  const pair = pairId ? input.snapshot.extended.entities.checkPairs[pairId] : undefined;
  const item = itemId ? input.snapshot.extended.entities.notificationItems[itemId] : undefined;
  if (!pairId || !itemId || !answer || !pair || !item || item.kind !== "CHECK") {
    return missing(
      row,
      "E-22 requires an existing Check pair, Check Item, and confirmed first answer",
    );
  }
  if (pair.resultingStatus !== null) {
    return { ok: true, effects: [{ type: "UPSERT_CHECK_PAIR", pair }] };
  }
  const current = item.role === "RECEIVER" ? pair.receiverAnswer : pair.senderAnswer;
  if (current !== null && current !== answer) {
    return missing(row, "E-22 first answer contradicts the already persisted participant answer");
  }
  const next: CheckPair =
    item.role === "RECEIVER"
      ? { ...pair, receiverAnswer: answer, resultingStatus: null }
      : { ...pair, senderAnswer: answer, resultingStatus: null };
  return { ok: true, effects: [{ type: "UPSERT_CHECK_PAIR", pair: next }] };
}

function instantiateE23Completion(
  row: MatrixContractRow,
  input: ResolveInput,
  suppressImmediateUi: boolean,
  seq: number,
): InstantiatedEffects {
  const pairId = eventField<CheckPairId>(input.event, "checkPairId");
  const itemId = eventField<NotificationItemId>(input.event, "checkItemId");
  const answer = eventField<CheckAnswer>(input.event, "answer");
  const status = eventField<CheckDerivedStatus>(input.event, "resultingStatus");
  const pair = pairId ? input.snapshot.extended.entities.checkPairs[pairId] : undefined;
  const item = itemId ? input.snapshot.extended.entities.notificationItems[itemId] : undefined;
  if (!pair || !item || item.kind !== "CHECK" || !answer || !status) {
    return missing(
      row,
      "E-23 requires the existing Check pair, second Check Item, confirmed answer, and resulting Status",
    );
  }
  const ban = input.snapshot.extended.entities.bans[pair.banId];
  if (!ban?.receiverId) {
    return missing(row, "E-23 requires the source Ban with both sender and receiver");
  }
  if (pair.resultingStatus !== null) {
    if (pair.resultingStatus !== status) {
      return missing(row, "E-23 resulting Status contradicts an already completed Check pair");
    }
    return { ok: true, effects: [] };
  }
  const firstAnswer = item.role === "RECEIVER" ? pair.senderAnswer : pair.receiverAnswer;
  if (firstAnswer === null) {
    return missing(row, "E-23 cannot complete a Check pair whose first answer is still absent");
  }
  const completed: CheckPair =
    item.role === "RECEIVER"
      ? { ...pair, receiverAnswer: answer, resultingStatus: status }
      : { ...pair, senderAnswer: answer, resultingStatus: status };
  const existing = existingStatusItems(input.snapshot, pair.banId, status);
  if (existing.length >= 2) {
    return {
      ok: true,
      effects: [
        { type: "UPSERT_CHECK_PAIR", pair: completed },
        { type: "UPSERT_BAN", ban: { ...ban, status } },
      ],
    };
  }
  const currentRole: Role = item.role;
  const receiverItem: StatusNotificationItem = {
    id: input.context.allocateId("notification") as NotificationItemId,
    ownerId: ban.receiverId,
    banId: pair.banId,
    fifoSequence: seq,
    lifecycle: {
      status: "UNPROCESSED",
      display: display(suppressImmediateUi, currentRole === "RECEIVER"),
    },
    kind: "STATUS",
    role: "RECEIVER",
    status,
  };
  const senderItem: StatusNotificationItem = {
    id: input.context.allocateId("notification") as NotificationItemId,
    ownerId: ban.senderId,
    banId: pair.banId,
    fifoSequence: seq + 1,
    lifecycle: {
      status: "UNPROCESSED",
      display: display(suppressImmediateUi, currentRole === "SENDER"),
    },
    kind: "STATUS",
    role: "SENDER",
    status,
  };
  if (receiverItem.id === senderItem.id) {
    return missing(row, "E-23 Status Items must have distinct Notification Item IDs");
  }
  const effects: Effect[] = [
    { type: "UPSERT_CHECK_PAIR", pair: completed },
    { type: "UPSERT_BAN", ban: { ...ban, status } },
    { type: "UPSERT_NOTIFICATION_ITEM", item: receiverItem },
    { type: "UPSERT_NOTIFICATION_ITEM", item: senderItem },
  ];
  return { ok: true, effects };
}

function instantiateCreatedBan(row: MatrixContractRow, input: ResolveInput): InstantiatedEffects {
  const { snapshot, event, context } = input;
  if (row.eventId === "E-20") {
    const sourceBanId = eventField<BanId>(event, "banId");
    const existing = sourceBanId ? snapshot.extended.entities.bans[sourceBanId] : undefined;
    if (!existing) {
      return missing(row, "E-20 requires the original Ban");
    }
    return {
      ok: true,
      effects: [
        {
          type: "UPSERT_BAN",
          ban: { ...existing, acceptance: "PENDING", status: "OVERBOARD" },
        },
      ],
    };
  }
  if (row.eventId === "E-12") {
    const share = matchingShare(input);
    if (!share || share.status !== "ACTIVE") {
      return missing(row, "E-12 requires a matching active Share operation");
    }
    if (share.createdBanId) {
      const existing = snapshot.extended.entities.bans[share.createdBanId];
      if (!existing) {
        return missing(row, "E-12 Share operation already created a Ban that is not present");
      }
      return {
        ok: true,
        effects: [
          { type: "UPSERT_BAN", ban: existing },
          {
            type: "UPSERT_SHARE_OPERATION",
            operation: { ...share, status: "CONFIRMED", createdBanId: existing.id },
          },
        ],
      };
    }
    const draft = share.draft;
    if (!isValidBanText(draft.banText) || draft.durationMinutes === null) {
      return missing(row, "E-12 Share operation is missing required Ban text or duration");
    }
    const banId = context.allocateId("ban") as BanId;
    const ban: Ban = {
      id: banId,
      senderId: context.currentUserId,
      receiverId: draft.selectedContactId,
      banText: draft.banText,
      durationMinutes: draft.durationMinutes,
      acceptance: "PENDING",
      status: null,
      boundViaTelegramShareLink: false,
      sourceProposalId: null,
    };
    return {
      ok: true,
      effects: [
        { type: "UPSERT_BAN", ban },
        {
          type: "UPSERT_SHARE_OPERATION",
          operation: { ...share, status: "CONFIRMED", createdBanId: banId },
        },
      ],
    };
  }
  if (row.eventId === "E-30") {
    const draft = replySendFacts(input);
    if (!draft) {
      return missing(
        row,
        "E-30 requires replyBanDraft or captured send draft banText and duration; refusing to invent Ban data",
      );
    }
    const source = replySourceOf(input);
    if (!source) {
      return missing(row, "E-30 requires Reply Ban source context");
    }
    if (row.state.includes("FROM_INCOMING_BAN") && source.kind !== "INCOMING_BAN") {
      return missing(row, "E-30 FROM_INCOMING_BAN requires Incoming Ban source context");
    }
    if (row.state.includes("FROM_STATUS") && source.kind !== "STATUS") {
      return missing(row, "E-30 FROM_STATUS requires Status source context");
    }
    const original = snapshot.extended.entities.bans[source.banId];
    if (!original) {
      return missing(row, "E-30 requires the original source Ban");
    }
    const receiverId = otherParticipant(original, context.currentUserId);
    if (!receiverId || receiverId === context.currentUserId) {
      return missing(
        row,
        "E-30 cannot determine the other participant; refusing self-receiver fallback",
      );
    }
    const replyBanId = eventField<BanId>(event, "replyBanId");
    if (!replyBanId) {
      return missing(row, "E-30 requires replyBanId from the confirmed operation");
    }
    const existingReply = snapshot.extended.entities.bans[replyBanId];
    const created: Ban = existingReply ?? {
      id: replyBanId,
      senderId: context.currentUserId,
      receiverId,
      banText: draft.banText,
      durationMinutes: draft.durationMinutes,
      acceptance: "PENDING",
      status: null,
      boundViaTelegramShareLink: false,
      sourceProposalId: null,
    };
    const effects: Effect[] = [{ type: "UPSERT_BAN", ban: created }];
    if (row.state.includes("FROM_INCOMING_BAN")) {
      effects.unshift({ type: "UPSERT_BAN", ban: { ...original, acceptance: "ACCEPTED" } });
    }
    return { ok: true, effects };
  }
  if (row.eventId === "E-10") {
    const createdBanId = eventField<BanId>(event, "createdBanId");
    const draft = createBanSendFacts(input);
    if (!createdBanId) {
      return missing(row, "E-10 requires createdBanId from the confirmed operation");
    }
    if (!draft) {
      return missing(
        row,
        "E-10 requires createBanDraft or captured send draft banText and duration; refusing to invent Ban data",
      );
    }
    const receiverId = draft.selectedContactId;
    if (draft.origin === "CONTACT" && !receiverId) {
      return missing(row, "CONTACT Create Ban requires selectedContact as receiver");
    }
    if (draft.origin === "RIM" && !draft.proposalId) {
      return missing(row, "RIM Create Ban requires the canonical sourceProposalId");
    }
    const linked = draft.proposalId
      ? Object.values(snapshot.extended.entities.bans).find(
          (ban) => ban.sourceProposalId === draft.proposalId && ban.id !== createdBanId,
        )
      : undefined;
    if (linked) {
      return missing(row, "sourceProposalId is already linked to a canonical Ban");
    }
    const existing = snapshot.extended.entities.bans[createdBanId];
    return {
      ok: true,
      effects: [
        {
          type: "UPSERT_BAN",
          ban: existing ?? {
            id: createdBanId,
            senderId: context.currentUserId,
            receiverId,
            banText: draft.banText,
            durationMinutes: draft.durationMinutes,
            acceptance: "PENDING",
            status: null,
            boundViaTelegramShareLink: false,
            sourceProposalId: draft.proposalId,
          },
        },
      ],
    };
  }
  const preservedId = snapshot.extended.successfulBanId;
  const preserved = preservedId ? snapshot.extended.entities.bans[preservedId] : undefined;
  if (preserved) {
    return { ok: true, effects: [{ type: "UPSERT_BAN", ban: preserved }] };
  }
  const known = Object.values(snapshot.extended.entities.bans);
  if (known.length === 1 && known[0]) {
    return { ok: true, effects: [{ type: "UPSERT_BAN", ban: known[0] }] };
  }
  if (known.length === 0) {
    return { ok: true, effects: [] };
  }
  return missing(
    row,
    `UPSERT_BAN for ${row.eventId} preserves an existing Ban and must not invent one`,
  );
}

export function instantiateEffects(
  row: MatrixContractRow,
  input: ResolveInput,
  nextState: ProductControlState | null,
  options: InstantiateOptions = {},
): InstantiatedEffects {
  const effects: Effect[] = [];
  const { snapshot, event, context } = input;
  const suppressImmediateUi = options.suppressImmediateUi === true;
  const waiting = display(suppressImmediateUi, false);
  const active = display(suppressImmediateUi, true);

  for (const declared of row.effects) {
    switch (declared.type) {
      case "SET_CONTROL_STATE":
        if (!suppressImmediateUi && nextState) {
          effects.push({ type: "SET_CONTROL_STATE", state: nextState });
        }
        break;
      case "END_SESSION":
        effects.push({ type: "END_SESSION" });
        break;
      case "SET_CONNECTION":
        effects.push({
          type: "SET_CONNECTION",
          connection: (row.eventId === "E-34" ? "OFFLINE" : "ONLINE") as ConnectionState,
        });
        break;
      case "SET_RIM_CHAT":
        if (row.eventId === "E-49" && !eventField<UserId>(event, "contactId")) {
          return missing(row, "E-49 requires the selected contact; refusing to invent a contact");
        }
        effects.push({
          type: "SET_RIM_CHAT",
          chat: nextRimChat(row, snapshot, event, context),
        });
        break;
      case "SET_FROZEN_RIM_CHAT":
        effects.push({
          type: "SET_FROZEN_RIM_CHAT",
          chat: row.eventId === "E-55" ? snapshot.extended.rimChat : null,
        });
        break;
      case "SET_CREATE_BAN_DRAFT":
        if (row.eventId === "E-02" && !eventField<UserId>(event, "contactId")) {
          return missing(row, "E-02 requires a real contact; refusing to invent a contact");
        }
        effects.push({
          type: "SET_CREATE_BAN_DRAFT",
          draft: nextCreateDraft(row, snapshot, event),
        });
        break;
      case "SET_REPLY_BAN_DRAFT":
        effects.push({ type: "SET_REPLY_BAN_DRAFT", draft: nextReplyDraft(row, snapshot, event) });
        break;
      case "SET_REPLY_SOURCE": {
        const item = activeItem(snapshot);
        if (!item || (item.kind !== "INCOMING_BAN" && item.kind !== "STATUS")) {
          return missing(row, "SET_REPLY_SOURCE requires an active Incoming Ban or Status Item");
        }
        effects.push({
          type: "SET_REPLY_SOURCE",
          source: {
            kind: item.kind === "INCOMING_BAN" ? "INCOMING_BAN" : "STATUS",
            itemId: item.id,
            banId: item.banId,
          },
        });
        break;
      }
      case "REQUEST_RELATIONSHIP_CONTEXT": {
        const fromChat = effects.find((effect) => effect.type === "SET_RIM_CHAT");
        const chat =
          fromChat && fromChat.type === "SET_RIM_CHAT" ? fromChat.chat : snapshot.extended.rimChat;
        const contactId =
          chat?.selectedContactId ??
          eventField<UserId>(event, "contactId") ??
          snapshot.extended.rimChat?.selectedContactId;
        const requestId =
          (fromChat && fromChat.type === "SET_RIM_CHAT"
            ? fromChat.chat?.relationshipContext?.requestId
            : undefined) ?? (context.allocateId("context") as ContextRequestId);
        if (!contactId || !requestId) {
          return missing(
            row,
            "REQUEST_RELATIONSHIP_CONTEXT requires selectedContact and requestId",
          );
        }
        effects.push({
          type: "REQUEST_RELATIONSHIP_CONTEXT",
          requestId,
          contactId,
        });
        break;
      }
      case "REQUEST_RIM_AI": {
        const fromChat = effects.find((effect) => effect.type === "SET_RIM_CHAT");
        const pendingFromChat =
          fromChat &&
          fromChat.type === "SET_RIM_CHAT" &&
          fromChat.chat?.aiOperation.status === "PENDING"
            ? fromChat.chat.aiOperation
            : null;
        const failed =
          snapshot.extended.rimChat?.aiOperation.status === "FAILED"
            ? snapshot.extended.rimChat.aiOperation
            : null;
        const logical = pendingFromChat ?? failed;
        if (!logical) {
          return missing(row, "REQUEST_RIM_AI requires the logical RimRequestSnapshot");
        }
        effects.push({
          type: "REQUEST_RIM_AI",
          requestId: logical.requestId,
          snapshot: logical.snapshot,
        });
        break;
      }
      case "START_OPERATION": {
        if (!snapshot.controlState) {
          return missing(row, "START_OPERATION requires an established Product Control State");
        }
        const kind = row.state.startsWith("REPLY_BAN")
          ? "REPLY_BAN_SEND"
          : row.eventId === "E-15"
            ? "OVERBOARD"
            : row.eventId === "E-16" || row.eventId === "E-17"
              ? "CHECK_ANSWER"
              : "CREATE_BAN_SEND";
        effects.push({
          type: "START_OPERATION",
          operation: {
            operationId: context.allocateId("operation") as OperationId,
            kind,
            originatingState: snapshot.controlState,
            originatingItemId: snapshot.extended.activeNotificationItemId,
            resultApplied: false,
            supersededByExternalEntry: false,
            sendDraft: captureSendDraft(kind, snapshot),
          } satisfies PendingOperation,
        });
        break;
      }
      case "CLEAR_OPERATION": {
        const operationId = eventField<OperationId>(event, "operationId");
        if (operationId) {
          effects.push({ type: "CLEAR_OPERATION", operationId });
        }
        break;
      }
      case "MARK_OPERATION_RESULT_APPLIED": {
        const operationId = eventField<OperationId>(event, "operationId");
        if (operationId) {
          effects.push({ type: "MARK_OPERATION_RESULT_APPLIED", operationId });
        }
        break;
      }
      case "PROCESS_TIMER_NOTIFICATION_ITEM": {
        for (const item of unprocessedTimerItems(snapshot, context.currentUserId)) {
          effects.push({
            type: "PROCESS_TIMER_NOTIFICATION_ITEM",
            itemId: item.id,
            cause:
              row.eventId === "E-32"
                ? "APP_FULL_CLOSE"
                : row.eventId === "E-19"
                  ? "PRESS_TO_BANS"
                  : "TELEGRAM_SHARE_LINK_RESOLVED",
          });
        }
        break;
      }
      case "CLEAR_TIMER_PRIORITY": {
        const timerId = snapshot.extended.priorities.timerItemId;
        if (timerId) {
          effects.push({ type: "CLEAR_TIMER_PRIORITY", itemId: timerId });
        }
        break;
      }
      case "SET_TIMER_PRIORITY": {
        if (suppressImmediateUi) {
          break;
        }
        const created = [...effects]
          .reverse()
          .find(
            (effect) => effect.type === "UPSERT_NOTIFICATION_ITEM" && effect.item.kind === "TIMER",
          );
        if (created && created.type === "UPSERT_NOTIFICATION_ITEM") {
          effects.push({ type: "SET_TIMER_PRIORITY", itemId: created.item.id });
          break;
        }
        const source = replySourceOf(input);
        const existingTimerItem = source
          ? timerNotificationItemForBan(snapshot, source.banId, context.currentUserId)
          : undefined;
        if (existingTimerItem) {
          effects.push({ type: "SET_TIMER_PRIORITY", itemId: existingTimerItem.id });
          break;
        }
        return missing(
          row,
          "SET_TIMER_PRIORITY requires the Timer Notification Item created by this row",
        );
      }
      case "SET_STATUS_PRIORITY": {
        if (suppressImmediateUi) {
          break;
        }
        const currentRole: Role = row.state.includes("SENDER") ? "SENDER" : "RECEIVER";
        const created = [...effects]
          .reverse()
          .find(
            (effect) =>
              effect.type === "UPSERT_NOTIFICATION_ITEM" &&
              effect.item.kind === "STATUS" &&
              effect.item.role === currentRole,
          );
        if (created && created.type === "UPSERT_NOTIFICATION_ITEM") {
          effects.push({ type: "SET_STATUS_PRIORITY", itemId: created.item.id });
          if (row.eventId === "E-23") {
            effects.push({ type: "SET_ACTIVE_NOTIFICATION", itemId: created.item.id });
          }
          break;
        }
        if (row.eventId === "E-23") {
          const pairId = eventField<CheckPairId>(event, "checkPairId");
          const pair = pairId ? snapshot.extended.entities.checkPairs[pairId] : undefined;
          if (pair?.resultingStatus) {
            break;
          }
        }
        return missing(
          row,
          "SET_STATUS_PRIORITY requires the current participant's Status Notification Item",
        );
      }
      case "CLEAR_STATUS_PRIORITY": {
        const id = snapshot.extended.priorities.statusItemId;
        if (id) {
          effects.push({ type: "CLEAR_STATUS_PRIORITY", itemId: id });
        }
        break;
      }
      case "SET_ACTIVE_NOTIFICATION": {
        if (suppressImmediateUi) {
          break;
        }
        if (row.kind === "E43") {
          const id = snapshot.extended.priorities.statusItemId;
          const timerId = snapshot.extended.priorities.timerItemId;
          const head = unprocessedItems(snapshot, context.currentUserId)[0];
          const itemId =
            row.branch === "status-priority"
              ? id
              : row.branch === "timer-priority"
                ? timerId
                : row.branch === "queue-empty"
                  ? null
                  : (head?.id ?? null);
          effects.push({ type: "SET_ACTIVE_NOTIFICATION", itemId });
          break;
        }
        const currentRole: Role = row.state.includes("SENDER") ? "SENDER" : "RECEIVER";
        const createdMatchingStatus = [...effects]
          .reverse()
          .find(
            (effect) =>
              effect.type === "UPSERT_NOTIFICATION_ITEM" &&
              effect.item.kind === "STATUS" &&
              effect.item.role === currentRole &&
              effect.item.lifecycle.status === "UNPROCESSED",
          );
        const createdNonStatus = [...effects]
          .reverse()
          .find(
            (effect) =>
              effect.type === "UPSERT_NOTIFICATION_ITEM" &&
              (effect.item.kind === "INCOMING_BAN" || effect.item.kind === "TIMER"),
          );
        const fromEvent = eventField<NotificationItemId>(event, "incomingBanItemId");
        const priority = snapshot.extended.priorities.statusItemId;
        const timerPriorityFromRow = effects.find((effect) => effect.type === "SET_TIMER_PRIORITY");
        const itemId =
          (createdMatchingStatus && createdMatchingStatus.type === "UPSERT_NOTIFICATION_ITEM"
            ? createdMatchingStatus.item.id
            : null) ??
          (createdNonStatus && createdNonStatus.type === "UPSERT_NOTIFICATION_ITEM"
            ? createdNonStatus.item.id
            : null) ??
          fromEvent ??
          (timerPriorityFromRow && timerPriorityFromRow.type === "SET_TIMER_PRIORITY"
            ? timerPriorityFromRow.itemId
            : null) ??
          priority ??
          snapshot.extended.activeNotificationItemId;
        effects.push({
          type: "SET_ACTIVE_NOTIFICATION",
          itemId,
        });
        break;
      }
      case "SET_PENDING_EXTERNAL_ENTRY": {
        if (row.eventId === "E-41") {
          effects.push({ type: "SET_PENDING_EXTERNAL_ENTRY", entry: null });
        } else if (row.eventId === "E-44") {
          const shareLinkId = eventField<ShareLinkId>(event, "shareLinkId");
          const shareTargetBanId = eventField<BanId>(event, "shareTargetBanId");
          const currentTelegramUserId = eventField<UserId>(event, "currentTelegramUserId");
          if (!shareLinkId || !shareTargetBanId || !currentTelegramUserId) {
            return missing(
              row,
              "E-44 requires Share Link identity, target Ban, and current Telegram user",
            );
          }
          effects.push({
            type: "SET_PENDING_EXTERNAL_ENTRY",
            entry: {
              shareLinkId,
              shareTargetBanId,
              currentTelegramUserId,
              entryTimestamp: context.now,
              firstLaunch: snapshot.controlState === null,
            },
          });
        }
        break;
      }
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE": {
        if (row.eventId === "E-61") {
          effects.push({ type: "SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE", eligible: false });
          break;
        }
        if (row.eventId === "E-20") {
          const sourceBanId = eventField<BanId>(event, "banId");
          const ban = sourceBanId ? snapshot.extended.entities.bans[sourceBanId] : undefined;
          if (
            ban?.boundViaTelegramShareLink === true &&
            snapshot.extended.telegramPersistentReentryEstablished === false
          ) {
            effects.push({ type: "SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE", eligible: true });
          }
          break;
        }
        if (row.eventId === "E-30" && row.state.includes("FROM_INCOMING_BAN")) {
          const source = replySourceOf(input);
          const original = source ? snapshot.extended.entities.bans[source.banId] : undefined;
          if (
            original?.boundViaTelegramShareLink === true &&
            snapshot.extended.telegramPersistentReentryEstablished === false
          ) {
            effects.push({ type: "SET_TELEGRAM_PERSISTENT_REENTRY_ELIGIBLE", eligible: true });
          }
          break;
        }
        break;
      }
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ESTABLISHED": {
        if (row.eventId === "E-61") {
          effects.push({
            type: "SET_TELEGRAM_PERSISTENT_REENTRY_ESTABLISHED",
            established: true,
          });
        }
        break;
      }
      case "SET_TELEGRAM_PERSISTENT_REENTRY_ACTIVE_REQUEST": {
        if (row.eventId === "E-61" || row.eventId === "E-62") {
          effects.push({
            type: "SET_TELEGRAM_PERSISTENT_REENTRY_ACTIVE_REQUEST",
            requestId: null,
          });
        }
        break;
      }
      case "CONSUME_TELEGRAM_PERSISTENT_REENTRY_CTA_OPPORTUNITY": {
        if (row.eventId === "E-62" && row.branch === "guard-a") {
          effects.push({ type: "CONSUME_TELEGRAM_PERSISTENT_REENTRY_CTA_OPPORTUNITY" });
        }
        break;
      }
      case "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE": {
        if (row.eventId === "E-61" && row.branch === "guard-a") {
          effects.push({ type: "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE" });
        }
        break;
      }
      case "OPEN_TELEGRAM_SHARE": {
        const draft = snapshot.extended.createBanDraft;
        if (
          !draft ||
          !isValidBanText(draft.banText) ||
          draft.durationMinutes === null ||
          !isValidDurationMinutes(draft.durationMinutes)
        ) {
          return missing(row, "OPEN_TELEGRAM_SHARE requires a valid Create Ban draft");
        }
        const attemptId = context.allocateId("share") as ShareAttemptId;
        effects.push({ type: "OPEN_TELEGRAM_SHARE", attemptId });
        effects.push({
          type: "UPSERT_SHARE_OPERATION",
          operation: {
            attemptId,
            draft,
            token: context.allocateId("share-token") as unknown as ShareToken,
            status: "ACTIVE",
            createdBanId: null,
          },
        });
        break;
      }
      case "UPSERT_SHARE_OPERATION":
        break;
      case "UPSERT_BAN": {
        const created = instantiateCreatedBan(row, input);
        if (!created.ok) {
          return created;
        }
        effects.push(...created.effects);
        break;
      }
      case "UPSERT_DOMAIN_TIMER": {
        if (row.eventId === "E-32") {
          break;
        }
        if (row.eventId === "E-42") {
          const banId = eventField<BanId>(event, "banId");
          const ban = banId ? snapshot.extended.entities.bans[banId] : undefined;
          if (!banId || !ban?.receiverId) {
            return missing(row, "E-42 requires the expired Ban with both participants");
          }
          if (!isValidDurationMinutes(ban.durationMinutes)) {
            return missing(
              row,
              "E-42 requires the Ban's authoritative duration; refusing to invent one",
            );
          }
          const existing = Object.values(snapshot.extended.entities.domainTimers).find(
            (timer) => timer.banId === banId,
          );
          if (!existing) {
            return missing(
              row,
              "E-42 requires the authoritative DomainTimer; refusing to invent duration start",
            );
          }
          effects.push({
            type: "UPSERT_DOMAIN_TIMER",
            timer: { ...existing, state: "EXPIRED", checkPairCreated: true },
          });
          break;
        }
        if (row.eventId === "E-30") {
          const source = replySourceOf(input);
          if (
            !row.state.includes("FROM_INCOMING_BAN") ||
            !source ||
            source.kind !== "INCOMING_BAN"
          ) {
            return missing(
              row,
              "E-30 domain Timer is created only for FROM_INCOMING_BAN original Ban",
            );
          }
          const original = snapshot.extended.entities.bans[source.banId];
          if (!original) {
            return missing(row, "E-30 domain Timer requires the original source Ban duration");
          }
          if (!isValidDurationMinutes(original.durationMinutes)) {
            return missing(
              row,
              "E-30 domain Timer requires the original Ban's authoritative duration",
            );
          }
          const existingTimer = Object.values(snapshot.extended.entities.domainTimers).find(
            (timer) => timer.banId === source.banId,
          );
          effects.push({
            type: "UPSERT_DOMAIN_TIMER",
            timer: existingTimer ?? {
              id: context.allocateId("timer") as DomainTimerId,
              banId: source.banId,
              startedAt: context.now,
              durationMinutes: original.durationMinutes,
              state: "RUNNING",
              checkPairCreated: false,
            },
          });
        }
        break;
      }
      case "UPSERT_CHECK_PAIR": {
        if (row.eventId === "E-22") {
          const updated = instantiateE22Pair(row, input);
          if (!updated.ok) {
            return updated;
          }
          effects.push(...updated.effects);
          break;
        }
        if (row.eventId === "E-23") {
          const completed = instantiateE23Completion(row, input, suppressImmediateUi, 0);
          if (!completed.ok) {
            return completed;
          }
          effects.push(
            ...completed.effects.filter(
              (effect) => effect.type === "UPSERT_CHECK_PAIR" || effect.type === "UPSERT_BAN",
            ),
          );
          break;
        }
        const banId = eventField<BanId>(event, "banId");
        const ban = banId ? snapshot.extended.entities.bans[banId] : undefined;
        if (!banId || !ban?.receiverId) {
          return missing(row, "Check pair creation requires the Ban and both participants");
        }
        const existingPair = Object.values(snapshot.extended.entities.checkPairs).find(
          (pair) => pair.banId === banId,
        );
        if (existingPair) {
          effects.push({ type: "UPSERT_CHECK_PAIR", pair: existingPair });
          break;
        }
        const pair: CheckPair = {
          id: context.allocateId("check-pair") as CheckPairId,
          banId,
          receiverItemId: context.allocateId("notification") as NotificationItemId,
          senderItemId: context.allocateId("notification") as NotificationItemId,
          receiverAnswer: null,
          senderAnswer: null,
          resultingStatus: null,
        };
        effects.push({ type: "UPSERT_CHECK_PAIR", pair });
        break;
      }
      case "UPSERT_NOTIFICATION_ITEM": {
        const seq =
          nextFifoSequence(snapshot) +
          effects.filter((effect) => effect.type === "UPSERT_NOTIFICATION_ITEM").length;
        if (row.eventId === "E-42") {
          const pairEffect = [...effects]
            .reverse()
            .find((effect) => effect.type === "UPSERT_CHECK_PAIR");
          if (!pairEffect || pairEffect.type !== "UPSERT_CHECK_PAIR") {
            return missing(row, "E-42 Check Items require the Check pair from this row");
          }
          const already = Object.values(snapshot.extended.entities.notificationItems).filter(
            (item) => item.kind === "CHECK" && item.checkPairId === pairEffect.pair.id,
          );
          if (already.length >= 2) {
            break;
          }
          const ban = snapshot.extended.entities.bans[pairEffect.pair.banId];
          if (!ban?.receiverId) {
            return missing(row, "E-42 Check Items require Ban sender and receiver ownership");
          }
          const receiver: CheckNotificationItem = {
            id: pairEffect.pair.receiverItemId,
            ownerId: ban.receiverId,
            banId: pairEffect.pair.banId,
            fifoSequence: seq,
            lifecycle: { status: "UNPROCESSED", display: "WAITING" },
            kind: "CHECK",
            role: "RECEIVER",
            checkPairId: pairEffect.pair.id,
          };
          const sender: CheckNotificationItem = {
            id: pairEffect.pair.senderItemId,
            ownerId: ban.senderId,
            banId: pairEffect.pair.banId,
            fifoSequence: seq + 1,
            lifecycle: { status: "UNPROCESSED", display: "WAITING" },
            kind: "CHECK",
            role: "SENDER",
            checkPairId: pairEffect.pair.id,
          };
          effects.push({ type: "UPSERT_NOTIFICATION_ITEM", item: receiver });
          effects.push({ type: "UPSERT_NOTIFICATION_ITEM", item: sender });
        } else if (row.eventId === "E-45") {
          const itemId = eventField<NotificationItemId>(event, "incomingBanItemId");
          const banId = eventField<BanId>(event, "targetBanId");
          if (!itemId || !banId) {
            return missing(row, "E-45 requires the target Incoming Ban Item identity");
          }
          const existing = snapshot.extended.entities.notificationItems[itemId];
          if (existing) {
            effects.push({
              type: "UPSERT_NOTIFICATION_ITEM",
              item: {
                ...existing,
                lifecycle:
                  existing.lifecycle.status === "PROCESSED"
                    ? existing.lifecycle
                    : { status: "UNPROCESSED", display: active },
              },
            });
          } else {
            effects.push({
              type: "UPSERT_NOTIFICATION_ITEM",
              item: {
                id: itemId,
                ownerId: context.currentUserId,
                banId,
                fifoSequence: seq,
                lifecycle: { status: "UNPROCESSED", display: active },
                kind: "INCOMING_BAN",
              },
            });
          }
        } else if (row.eventId === "E-10") {
          const banId = eventField<BanId>(event, "createdBanId");
          const draft = createBanSendFacts(input);
          const receiverId = draft?.selectedContactId ?? null;
          if (!banId || !receiverId) {
            return missing(
              row,
              "CONTACT Create Ban Incoming Item requires created Ban and receiver",
            );
          }
          const incoming = ensureReceiverIncoming(
            input,
            effects,
            row,
            banId,
            receiverId,
            seq,
            waiting,
          );
          if (incoming) {
            return incoming;
          }
        } else if (row.eventId === "E-20") {
          const banId = eventField<BanId>(event, "banId");
          const ban = banId ? snapshot.extended.entities.bans[banId] : undefined;
          if (!banId || !ban?.receiverId) {
            return missing(row, "OVERBOARD Status Items require the Ban and both participants");
          }
          const existing = existingStatusItems(snapshot, banId, "OVERBOARD");
          if (existing.length >= 2) {
            break;
          }
          effects.push({
            type: "UPSERT_NOTIFICATION_ITEM",
            item: {
              id: context.allocateId("notification") as NotificationItemId,
              ownerId: ban.receiverId,
              banId,
              fifoSequence: seq,
              lifecycle: { status: "UNPROCESSED", display: active },
              kind: "STATUS",
              role: "RECEIVER",
              status: "OVERBOARD",
            },
          });
          effects.push({
            type: "UPSERT_NOTIFICATION_ITEM",
            item: {
              id: context.allocateId("notification") as NotificationItemId,
              ownerId: ban.senderId,
              banId,
              fifoSequence: seq + 1,
              lifecycle: { status: "UNPROCESSED", display: waiting },
              kind: "STATUS",
              role: "SENDER",
              status: "OVERBOARD",
            },
          });
        } else if (row.eventId === "E-30") {
          const replyBanId = eventField<BanId>(event, "replyBanId");
          const replyBan =
            [...effects]
              .reverse()
              .find(
                (effect): effect is Extract<Effect, { type: "UPSERT_BAN" }> =>
                  effect.type === "UPSERT_BAN" && effect.ban.id === replyBanId,
              )?.ban ?? (replyBanId ? snapshot.extended.entities.bans[replyBanId] : undefined);
          const incoming = ensureReceiverIncoming(
            input,
            effects,
            row,
            replyBan?.id,
            replyBan?.receiverId,
            seq,
            waiting,
          );
          if (incoming) {
            return incoming;
          }
          if (!row.state.includes("FROM_INCOMING_BAN")) {
            break;
          }
          const source = replySourceOf(input);
          const timer = effects.find((effect) => effect.type === "UPSERT_DOMAIN_TIMER");
          if (
            !source ||
            source.kind !== "INCOMING_BAN" ||
            !timer ||
            timer.type !== "UPSERT_DOMAIN_TIMER"
          ) {
            return missing(
              row,
              "E-30 Timer Notification Item requires FROM_INCOMING_BAN source and domain Timer",
            );
          }
          const existingTimerItem =
            Object.values(snapshot.extended.entities.notificationItems).find(
              (item) => item.kind === "TIMER" && item.banId === source.banId,
            ) ??
            effects.find(
              (effect) =>
                effect.type === "UPSERT_NOTIFICATION_ITEM" &&
                effect.item.kind === "TIMER" &&
                effect.item.banId === source.banId,
            );
          if (!existingTimerItem) {
            effects.push({
              type: "UPSERT_NOTIFICATION_ITEM",
              item: {
                id: context.allocateId("notification") as NotificationItemId,
                ownerId: context.currentUserId,
                banId: source.banId,
                fifoSequence:
                  nextFifoSequence(snapshot) +
                  effects.filter((effect) => effect.type === "UPSERT_NOTIFICATION_ITEM").length,
                kind: "TIMER",
                domainTimerId: timer.timer.id,
                lifecycle: { status: "UNPROCESSED", display: waiting },
              },
            });
          }
        } else if (row.eventId === "E-23") {
          const completed = instantiateE23Completion(row, input, suppressImmediateUi, seq);
          if (!completed.ok) {
            return completed;
          }
          effects.push(...completed.effects);
        }
        break;
      }
      case "SET_NOTIFICATION_LIFECYCLE": {
        const source = replySourceOf(input);
        const itemId =
          eventField<NotificationItemId>(event, "sourceItemId") ??
          eventField<NotificationItemId>(event, "checkItemId") ??
          (row.eventId === "E-19"
            ? snapshot.extended.activeNotificationItemId
            : (source?.itemId ?? snapshot.extended.activeNotificationItemId));
        if (!itemId) {
          return missing(row, "SET_NOTIFICATION_LIFECYCLE requires the source Notification Item");
        }
        effects.push({
          type: "SET_NOTIFICATION_LIFECYCLE",
          itemId,
          lifecycle: { status: "PROCESSED" },
        });
        break;
      }
      default:
        break;
    }
  }

  if (
    row.eventId === "E-45" &&
    (row.branch === "guard-a" ||
      row.branch === "guard-a-dispatch" ||
      row.branch === "first-launch-resolved")
  ) {
    const banId = eventField<BanId>(event, "targetBanId");
    const receiverId = eventField<UserId>(event, "receiverId");
    const itemId = eventField<NotificationItemId>(event, "incomingBanItemId");
    const ban = banId ? snapshot.extended.entities.bans[banId] : undefined;
    if (
      ban &&
      receiverId &&
      receiverId === context.currentUserId &&
      (ban.receiverId === null || ban.receiverId === receiverId)
    ) {
      effects.push({
        type: "UPSERT_BAN",
        ban: { ...ban, receiverId, boundViaTelegramShareLink: true },
      });
    }
    // Bootstrap first-launch Matrix omits UPSERT_NOTIFICATION_ITEM; Guard A still requires
    // exactly one linked Incoming Ban Item for the target Ban.
    if (itemId && banId && receiverId === context.currentUserId) {
      const already = effects.some(
        (effect) =>
          effect.type === "UPSERT_NOTIFICATION_ITEM" &&
          effect.item.id === itemId &&
          effect.item.kind === "INCOMING_BAN",
      );
      if (!already) {
        const existing = snapshot.extended.entities.notificationItems[itemId];
        if (existing) {
          effects.push({
            type: "UPSERT_NOTIFICATION_ITEM",
            item: {
              ...existing,
              lifecycle:
                existing.lifecycle.status === "PROCESSED"
                  ? existing.lifecycle
                  : { status: "UNPROCESSED", display: "ACTIVE" },
            },
          });
        } else {
          effects.push({
            type: "UPSERT_NOTIFICATION_ITEM",
            item: {
              id: itemId,
              ownerId: context.currentUserId,
              banId,
              fifoSequence: nextFifoSequence(snapshot),
              lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
              kind: "INCOMING_BAN",
            },
          });
        }
      }
    }
    for (const operation of Object.values(snapshot.runtime.pendingOperations)) {
      if (
        (operation.kind === "CREATE_BAN_SEND" ||
          operation.kind === "OVERBOARD" ||
          operation.kind === "CHECK_ANSWER" ||
          operation.kind === "REPLY_BAN_SEND") &&
        !operation.resultApplied &&
        !operation.supersededByExternalEntry
      ) {
        effects.push({
          type: "MARK_OPERATION_SUPERSEDED_BY_EXTERNAL_ENTRY",
          operationId: operation.operationId,
        });
      }
    }
  }
  if (row.eventId === "E-13") {
    const share = matchingShare(input);
    if (share) {
      effects.push({
        type: "UPSERT_SHARE_OPERATION",
        operation: { ...share, status: "CANCELLED" },
      });
    }
  }
  if (row.eventId === "E-32" && row.branch === "share-unresolved") {
    for (const share of Object.values(snapshot.extended.entities.shareOperations)) {
      if (share.status === "ACTIVE") {
        effects.push({
          type: "UPSERT_SHARE_OPERATION",
          operation: { ...share, status: "CANCELLED" },
        });
      }
    }
  }
  if (row.eventId === "E-20" || row.eventId === "E-22" || row.eventId === "E-23") {
    const operation = correlatedPendingOperation(input);
    if (operation && !operation.resultApplied) {
      effects.push({
        type: "MARK_OPERATION_RESULT_APPLIED",
        operationId: operation.operationId,
      });
    }
  }
  if (row.eventId === "E-21") {
    const operation = correlatedPendingOperation(input);
    if (operation && !operation.resultApplied) {
      effects.push({
        type: "CLEAR_OPERATION",
        operationId: operation.operationId,
      });
    }
  }

  return { ok: true, effects };
}
