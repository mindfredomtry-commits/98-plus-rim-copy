import { findChatProposal } from "../entities.ts";
import type { Guard } from "../guards.ts";
import type { ProposalId, UserId } from "../ids.ts";
import type { MatrixContractRow } from "../matrix.ts";
import { isValidBanText, isValidDurationMinutes } from "../primitives.ts";
import type { ResolveInput } from "./types.ts";
import {
  activeItem,
  fifoHead,
  instantValue,
  pendingOfKind,
  sourceReplyBanTimerIsUnprocessed,
  statusControlState,
  ttlExpired,
  unprocessedItems,
  validAskRimOrigin,
} from "./snapshot.ts";

function checkAnswerPayload(input: ResolveInput) {
  const payload = input.event.payload as {
    operationId?: string;
    checkItemId?: string;
    checkPairId?: string;
  };
  return payload;
}

function checkAnswerItemConsistent(input: ResolveInput, checkItemId: string): boolean {
  const pairId = checkAnswerPayload(input).checkPairId;
  const item = input.snapshot.extended.entities.notificationItems[checkItemId];
  if (!item || item.kind !== "CHECK") {
    return false;
  }
  if (pairId && item.checkPairId !== pairId) {
    return false;
  }
  if (pairId && !input.snapshot.extended.entities.checkPairs[pairId]) {
    return false;
  }
  return true;
}

function matchingCheckAnswerOperation(input: ResolveInput) {
  const { checkItemId, operationId } = checkAnswerPayload(input);
  const pending = Object.values(input.snapshot.runtime.pendingOperations).filter(
    (operation) => operation.kind === "CHECK_ANSWER",
  );
  const byId = operationId ? (input.snapshot.runtime.pendingOperations[operationId] ?? null) : null;
  if (byId) {
    if (byId.kind !== "CHECK_ANSWER") {
      return null;
    }
    if (checkItemId && byId.originatingItemId !== checkItemId) {
      return null;
    }
    return byId;
  }
  if (!checkItemId) {
    return null;
  }
  return pending.find((operation) => operation.originatingItemId === checkItemId) ?? null;
}

export function correlatedPendingOperation(input: ResolveInput) {
  const operationId =
    "operationId" in input.event.payload
      ? (input.event.payload as { operationId?: string }).operationId
      : undefined;
  if (input.eventId === "E-22" || input.eventId === "E-23") {
    return matchingCheckAnswerOperation(input);
  }
  if (operationId) {
    return input.snapshot.runtime.pendingOperations[operationId] ?? null;
  }
  return null;
}

function matchingOperation(input: ResolveInput) {
  return correlatedPendingOperation(input);
}

function overboardResultPayload(input: ResolveInput) {
  return input.event.payload as { sourceItemId?: string; banId?: string };
}

function matchingUnappliedOverboard(input: ResolveInput): boolean {
  const operation = matchingOperation(input);
  if (
    !operation ||
    operation.kind !== "OVERBOARD" ||
    operation.resultApplied ||
    operation.supersededByExternalEntry
  ) {
    return false;
  }
  const payload = overboardResultPayload(input);
  if (
    payload.sourceItemId &&
    operation.originatingItemId &&
    payload.sourceItemId !== operation.originatingItemId
  ) {
    return false;
  }
  if (payload.banId && operation.originatingItemId) {
    const item = input.snapshot.extended.entities.notificationItems[operation.originatingItemId];
    if (item && item.banId !== payload.banId) {
      return false;
    }
  }
  return true;
}

function validCurrentCheckAnswerResult(input: ResolveInput): boolean {
  const { checkItemId } = checkAnswerPayload(input);
  if (!checkItemId || !checkAnswerItemConsistent(input, checkItemId)) {
    return false;
  }
  const operation = matchingCheckAnswerOperation(input);
  return (
    !!operation &&
    operation.kind === "CHECK_ANSWER" &&
    operation.originatingItemId === checkItemId &&
    !operation.resultApplied &&
    !operation.supersededByExternalEntry
  );
}

function matchingShare(input: ResolveInput) {
  const attemptId =
    "shareAttemptId" in input.event.payload
      ? (input.event.payload as { shareAttemptId?: string }).shareAttemptId
      : undefined;
  if (!attemptId) {
    return null;
  }
  return input.snapshot.extended.entities.shareOperations[attemptId] ?? null;
}

function currentContactId(input: ResolveInput): UserId | null {
  const chat = input.snapshot.extended.rimChat;
  return chat ? chat.selectedContactId : null;
}

function eventContactId(input: ResolveInput) {
  const body = input.event.payload as { contactId?: string; selectedContactId?: string };
  return body.contactId ?? body.selectedContactId ?? null;
}

function eventRequestId(input: ResolveInput) {
  const body = input.event.payload as { requestId?: string; contextRequestId?: string };
  return body.requestId ?? body.contextRequestId ?? null;
}

function eventRimChatId(input: ResolveInput) {
  return (input.event.payload as { rimChatId?: string }).rimChatId ?? null;
}

function contextReady(input: ResolveInput): boolean {
  return input.snapshot.extended.rimChat?.relationshipContext?.status === "ready";
}

function activeAi(input: ResolveInput): boolean {
  return input.snapshot.extended.rimChat?.aiOperation.status === "PENDING";
}

function draftWhitespace(input: ResolveInput): boolean {
  return (input.snapshot.extended.rimChat?.inputDraft ?? "").trim().length === 0;
}

function createDraftValid(input: ResolveInput): boolean {
  const draft = input.snapshot.extended.createBanDraft;
  return (
    !!draft &&
    isValidBanText(draft.banText) &&
    draft.durationMinutes !== null &&
    isValidDurationMinutes(draft.durationMinutes)
  );
}

function replyDraftValid(input: ResolveInput): boolean {
  const draft = input.snapshot.extended.replyBanDraft;
  return (
    !!draft &&
    isValidBanText(draft.banText) &&
    draft.durationMinutes !== null &&
    isValidDurationMinutes(draft.durationMinutes)
  );
}

function incomingTargetUnprocessed(input: ResolveInput): boolean {
  const itemId = (input.event.payload as { incomingBanItemId?: string }).incomingBanItemId;
  if (!itemId) {
    return true;
  }
  const item = input.snapshot.extended.entities.notificationItems[itemId];
  return !item || item.lifecycle.status === "UNPROCESSED";
}

function incomingTargetProcessed(input: ResolveInput): boolean {
  const itemId = (input.event.payload as { incomingBanItemId?: string }).incomingBanItemId;
  if (!itemId) {
    return false;
  }
  const item = input.snapshot.extended.entities.notificationItems[itemId];
  return !!item && item.lifecycle.status === "PROCESSED";
}

/** MVP7 Guard B: Ban receiver bound to current user AND linked Incoming processed. */
function externalEntryGuardB(input: ResolveInput): boolean {
  if (!incomingTargetProcessed(input)) {
    return false;
  }
  const banId = (input.event.payload as { targetBanId?: string }).targetBanId;
  if (!banId) {
    return false;
  }
  const ban = input.snapshot.extended.entities.bans[banId];
  if (!ban || ban.receiverId === null) {
    return false;
  }
  return ban.receiverId === input.context.currentUserId;
}

function telegramPersistentReentryRequestMatches(input: ResolveInput): boolean {
  const active = input.snapshot.extended.telegramPersistentReentryActiveRequestId;
  const requestId = (input.event.payload as { requestId?: string }).requestId;
  return active !== null && !!requestId && active === requestId;
}

/** E-61 Guard A: valid active request + eligible + not yet established. */
function telegramPersistentReentryGrantedGuardA(input: ResolveInput): boolean {
  return (
    telegramPersistentReentryRequestMatches(input) &&
    input.snapshot.extended.telegramPersistentReentryEligible === true &&
    input.snapshot.extended.telegramPersistentReentryEstablished === false
  );
}

/** E-62 Guard A: valid active request + not yet established. */
function telegramPersistentReentryDeclinedGuardA(input: ResolveInput): boolean {
  return (
    telegramPersistentReentryRequestMatches(input) &&
    input.snapshot.extended.telegramPersistentReentryEstablished === false
  );
}

function currentContextRequest(input: ResolveInput): boolean {
  const chat = input.snapshot.extended.rimChat;
  const selectedContactId = (input.event.payload as { selectedContactId?: string })
    .selectedContactId;
  const requestId = eventRequestId(input);
  return (
    !!chat &&
    !!chat.relationshipContext &&
    chat.id === eventRimChatId(input) &&
    chat.selectedContactId === selectedContactId &&
    chat.relationshipContext.requestId === requestId
  );
}

/** Current logical AI request that can still accept a result or a failure. */
function currentAiRequest(input: ResolveInput): boolean {
  const chat = input.snapshot.extended.rimChat;
  const requestId = eventRequestId(input);
  return (
    !!chat &&
    chat.id === eventRimChatId(input) &&
    chat.aiOperation.status === "PENDING" &&
    chat.aiOperation.requestId === requestId
  );
}

function canonicalProposalSelectable(input: ResolveInput): boolean {
  const chat = input.snapshot.extended.rimChat;
  const proposalId = (input.event.payload as { proposalId?: ProposalId }).proposalId;
  if (!chat || !proposalId || chat.id !== eventRimChatId(input)) {
    return false;
  }
  if (!findChatProposal(chat, proposalId)) {
    return false;
  }
  return !Object.values(input.snapshot.extended.entities.bans).some(
    (ban) => ban.sourceProposalId === proposalId,
  );
}

function evaluateStructured(guard: Guard, input: ResolveInput): boolean {
  switch (guard.type) {
    case "ALWAYS":
      return true;
    case "BAN_DRAFT_VALID":
      return guard.draft === "CREATE" ? createDraftValid(input) : replyDraftValid(input);
    case "NO_PENDING_OPERATION":
      return pendingOfKind(input.snapshot, guard.kind).length === 0;
    case "MATCHING_OPERATION":
      return matchingOperation(input)?.resultApplied === guard.resultApplied;
    case "ACTIVE_ITEM":
      return input.snapshot.extended.activeNotificationItemId === guard.itemId;
    case "ITEM_KIND": {
      const item = input.snapshot.extended.entities.notificationItems[guard.itemId];
      return item?.kind === guard.kind;
    }
    case "ITEM_UNPROCESSED": {
      const item = input.snapshot.extended.entities.notificationItems[guard.itemId];
      return item?.lifecycle.status === "UNPROCESSED";
    }
    case "HAS_UNPROCESSED_ITEMS":
      return unprocessedItems(input.snapshot, input.context.currentUserId).length > 0;
    case "QUEUE_EMPTY":
      return unprocessedItems(input.snapshot, input.context.currentUserId).length === 0;
    case "STATUS_PRIORITY_APPLICABLE": {
      const id = input.snapshot.extended.priorities.statusItemId;
      const item = id ? input.snapshot.extended.entities.notificationItems[id] : null;
      return !!item && item.kind === "STATUS" && item.lifecycle.status === "UNPROCESSED";
    }
    case "TIMER_PRIORITY_APPLICABLE": {
      const id = input.snapshot.extended.priorities.timerItemId;
      const item = id ? input.snapshot.extended.entities.notificationItems[id] : null;
      return !!item && item.kind === "TIMER" && item.lifecycle.status === "UNPROCESSED";
    }
    case "NO_APPLICABLE_PRIORITY":
      return (
        !evaluateStructured({ type: "STATUS_PRIORITY_APPLICABLE" }, input) &&
        !evaluateStructured({ type: "TIMER_PRIORITY_APPLICABLE" }, input)
      );
    case "PENDING_EXTERNAL_ENTRY_EXISTS":
      return input.snapshot.extended.pendingExternalEntry !== null;
    case "PENDING_EXTERNAL_ENTRY_TTL_EXPIRED":
      return ttlExpired(input.snapshot, input.context.now);
    case "EXTERNAL_ENTRY_GUARD_A":
      return incomingTargetUnprocessed(input);
    case "EXTERNAL_ENTRY_GUARD_B":
      return externalEntryGuardB(input);
    case "TELEGRAM_PERSISTENT_REENTRY_GRANTED_GUARD_A":
      return telegramPersistentReentryGrantedGuardA(input);
    case "TELEGRAM_PERSISTENT_REENTRY_GRANTED_GUARD_B":
      return !telegramPersistentReentryGrantedGuardA(input);
    case "TELEGRAM_PERSISTENT_REENTRY_DECLINED_GUARD_A":
      return telegramPersistentReentryDeclinedGuardA(input);
    case "TELEGRAM_PERSISTENT_REENTRY_DECLINED_GUARD_B":
      return !telegramPersistentReentryDeclinedGuardA(input);
    case "CURRENT_RIM_REQUEST":
      return guard.request === "CONTEXT" ? currentContextRequest(input) : currentAiRequest(input);
    case "SELECTED_CONTACT_ABSENT":
      return currentContactId(input) === null;
    case "SELECTED_CONTACT_IS_DIFFERENT": {
      const current = currentContactId(input);
      const next = eventContactId(input);
      return current !== null && next !== null && current !== next;
    }
    case "SELECTED_CONTACT_IS_UNCHANGED": {
      const current = currentContactId(input);
      const next = eventContactId(input);
      return current !== null && current === next;
    }
    case "RIM_INPUT_NON_WHITESPACE":
      return !draftWhitespace(input);
    case "RELATIONSHIP_CONTEXT_READY":
      return contextReady(input);
    case "NO_ACTIVE_AI_REQUEST":
      return !activeAi(input);
    case "UNPROCESSED_TIMER_NOTIFICATION_ITEM_EXISTS":
      // E-29 FROM_INCOMING Matrix type name is unchanged. MVP5 meaning is the
      // Timer of replySource.banId, not any unprocessed Timer elsewhere.
      return sourceReplyBanTimerIsUnprocessed(input.snapshot, input.context.currentUserId);
    case "CONNECTION_OFFLINE":
      return input.snapshot.runtime.connection === "OFFLINE";
    case "SOURCE_TEXT":
      return evaluateSourceText(guard.text, input);
    case "NOT":
      return !evaluateStructured(guard.guard, input);
    case "ALL":
      return guard.guards.every((inner) => evaluateStructured(inner, input));
    case "ANY":
      return guard.guards.some((inner) => evaluateStructured(inner, input));
    default: {
      const _never: never = guard;
      return _never;
    }
  }
}

function domainTimerForBan(input: ResolveInput, banId: string) {
  return Object.values(input.snapshot.extended.entities.domainTimers).find(
    (timer) => timer.banId === banId,
  );
}

function domainTimerDurationElapsed(input: ResolveInput, banId: string): boolean {
  const timer = domainTimerForBan(input, banId);
  if (!timer || !isValidDurationMinutes(timer.durationMinutes)) {
    return false;
  }
  const durationMs = Number(timer.durationMinutes) * 60 * 1000;
  return instantValue(input.context.now) >= instantValue(timer.startedAt) + durationMs;
}

function expiredBanEligible(input: ResolveInput): boolean {
  const banId = (input.event.payload as { banId?: string }).banId;
  if (!banId) {
    return false;
  }
  const ban = input.snapshot.extended.entities.bans[banId];
  if (!ban || ban.acceptance !== "ACCEPTED" || ban.status === "OVERBOARD" || !ban.receiverId) {
    return false;
  }
  const alreadyPaired = Object.values(input.snapshot.extended.entities.checkPairs).some(
    (pair) => pair.banId === banId,
  );
  if (alreadyPaired) {
    return false;
  }
  return domainTimerDurationElapsed(input, banId);
}

function askRimEntryApplicable(input: ResolveInput): boolean {
  const active = activeItem(input.snapshot);
  if (!active || active.kind !== "STATUS" || active.lifecycle.status !== "UNPROCESSED") {
    return false;
  }
  if (active.ownerId !== input.context.currentUserId) {
    return false;
  }
  const ban = input.snapshot.extended.entities.bans[active.banId];
  if (!ban || ban.status !== active.status) {
    return false;
  }
  const role =
    ban.senderId === input.context.currentUserId
      ? "SENDER"
      : ban.receiverId === input.context.currentUserId
        ? "RECEIVER"
        : null;
  if (!role || role !== active.role) {
    return false;
  }
  const counterpart = role === "SENDER" ? ban.receiverId : ban.senderId;
  if (!counterpart) {
    return false;
  }
  return input.snapshot.controlState === statusControlState(active.status, active.role);
}

function otherEligibleBan(input: ResolveInput): boolean {
  if (!expiredBanEligible(input)) {
    return false;
  }
  const banId = (input.event.payload as { banId?: string }).banId;
  const active = activeItem(input.snapshot);
  return !active || active.banId !== banId;
}

function evaluateSourceText(text: string, _input: ResolveInput): boolean {
  const trimmed = text.trim();
  if (trimmed === "—" || trimmed === "" || trimmed === "если применимо") {
    return true;
  }
  return true;
}

function evaluateByBranch(row: MatrixContractRow, input: ResolveInput): boolean {
  const { eventId, branch } = row;
  const head = fifoHead(input.snapshot, input.context.currentUserId);
  const active = activeItem(input.snapshot);
  const chat = input.snapshot.extended.rimChat;

  switch (`${eventId}:${branch}`) {
    case "E-52:valid":
      return !draftWhitespace(input) && contextReady(input) && !activeAi(input);
    case "E-52:whitespace":
      return draftWhitespace(input);
    case "E-52:context-unavailable":
      return !draftWhitespace(input) && !contextReady(input);
    case "E-52:active-ai-request":
      return !draftWhitespace(input) && contextReady(input) && activeAi(input);
    case "E-06:valid-draft":
    case "E-26:valid-draft":
      return row.state.startsWith("REPLY_BAN") ? replyDraftValid(input) : createDraftValid(input);
    case "E-06:invalid-draft":
    case "E-26:invalid-draft":
      return row.state.startsWith("REPLY_BAN") ? !replyDraftValid(input) : !createDraftValid(input);
    case "E-56:current-contact":
    case "E-57:current-contact":
      return currentContextRequest(input);
    case "E-56:stale-contact":
      return !currentContextRequest(input);
    case "E-56:no-new-selection-prior-contact":
      return currentContextRequest(input);
    case "E-56:stale-replaced-contact":
      return !currentContextRequest(input);
    case "E-57:stale-contact":
    case "E-57:stale-replaced-contact":
      return !currentContextRequest(input);
    case "E-58:stale-replaced-contact":
      return !currentAiRequest(input);
    case "E-56:frozen-source-operation":
    case "E-57:frozen-source-operation":
    case "E-58:frozen-source-operation":
    case "E-59:frozen-source-operation":
      return input.snapshot.extended.savedFrozenRimChat !== null;
    case "E-58:current-request":
    case "E-59:current-request":
      return currentAiRequest(input);
    case "E-58:stale-request":
      return !currentAiRequest(input);
    case "E-59:stale-request":
      return !currentAiRequest(input);
    case "E-58:no-new-selection-prior-ai":
      return currentAiRequest(input);
    case "E-49:initial-selected-contact":
      return currentContactId(input) === null;
    case "E-49:change-selected-contact": {
      const current = currentContactId(input);
      const next = eventContactId(input);
      return current !== null && next !== null && current !== next;
    }
    case "E-49:same-current-selected-contact":
      return currentContactId(input) !== null && currentContactId(input) === eventContactId(input);
    case "E-53:failed-current-context":
      return chat?.relationshipContext?.status === "error";
    case "E-54:failed-ai-request": {
      const failedRequestId = (input.event.payload as { failedRequestId?: string }).failedRequestId;
      return (
        chat?.aiOperation.status === "FAILED" &&
        !!failedRequestId &&
        chat.aiOperation.requestId === failedRequestId
      );
    }
    case "E-55:valid-current-suggestion":
      return canonicalProposalSelectable(input);
    case "E-55:invalid-proposal":
      return !canonicalProposalSelectable(input);
    case "E-48:current-chat-exists":
      return true;
    case "E-02:real-contact":
      return eventContactId(input) !== null;
    case "E-10:matching-unapplied":
    case "E-30:matching-unapplied": {
      const operation = matchingOperation(input);
      return !!operation && !operation.resultApplied && !operation.supersededByExternalEntry;
    }
    case "E-20:matching-unapplied":
      return matchingUnappliedOverboard(input);
    case "E-11:matching-operation":
    case "E-11:matching-pending":
    case "E-31:matching-operation": {
      const operation = matchingOperation(input);
      return !!operation && !operation.resultApplied;
    }
    case "E-21:matching-pending": {
      const operation = matchingOperation(input);
      return !!operation && operation.kind === "OVERBOARD" && !operation.resultApplied;
    }
    case "E-21:matching-pending-answer": {
      const operation = matchingOperation(input);
      return !!operation && operation.kind === "CHECK_ANSWER" && !operation.resultApplied;
    }
    case "E-22:matching-first-of-pair": {
      const pairId = (input.event.payload as { checkPairId?: string }).checkPairId;
      const pair = pairId ? input.snapshot.extended.entities.checkPairs[pairId] : null;
      return (
        validCurrentCheckAnswerResult(input) &&
        !!pair &&
        pair.receiverAnswer === null &&
        pair.senderAnswer === null
      );
    }
    case "E-23:resulting-status-bantastic":
      return (
        validCurrentCheckAnswerResult(input) &&
        (input.event.payload as { resultingStatus?: string }).resultingStatus === "BANTASTIC"
      );
    case "E-23:resulting-status-banflict":
      return (
        validCurrentCheckAnswerResult(input) &&
        (input.event.payload as { resultingStatus?: string }).resultingStatus === "BANFLICT"
      );
    case "E-23:resulting-status-fair-enough":
      return (
        validCurrentCheckAnswerResult(input) &&
        (input.event.payload as { resultingStatus?: string }).resultingStatus === "FAIR_ENOUGH"
      );
    case "E-12:matching-share-attempt": {
      const share = matchingShare(input);
      return share?.status === "ACTIVE";
    }
    case "E-13:closed-without-send":
      return matchingShare(input) !== null;
    case "E-42:eligible-ban":
      return expiredBanEligible(input);
    case "E-42:other-eligible-ban":
      return otherEligibleBan(input);
    case "E-42:default":
      return expiredBanEligible(input);
    case "E-09:unprocessed-items-exist":
    case "E-29:unprocessed-items-exist":
    case "E-60:unprocessed-items-exist":
      return unprocessedItems(input.snapshot, input.context.currentUserId).length > 0;
    case "E-09:queue-empty":
    case "E-29:queue-empty":
      return unprocessedItems(input.snapshot, input.context.currentUserId).length === 0;
    case "E-29:timer-processed-queue-empty":
      return (
        !sourceReplyBanTimerIsUnprocessed(input.snapshot, input.context.currentUserId) &&
        unprocessedItems(input.snapshot, input.context.currentUserId).length === 0
      );
    case "E-29:timer-still-unprocessed":
      return sourceReplyBanTimerIsUnprocessed(input.snapshot, input.context.currentUserId);
    case "E-29:timer-processed-other-items":
      return (
        !sourceReplyBanTimerIsUnprocessed(input.snapshot, input.context.currentUserId) &&
        unprocessedItems(input.snapshot, input.context.currentUserId).length > 0
      );
    case "E-14:active-incoming-unprocessed":
      return active?.kind === "INCOMING_BAN" && active.lifecycle.status === "UNPROCESSED";
    case "E-14:active-status-unprocessed":
    case "E-18:active-status-unprocessed":
      return active?.kind === "STATUS" && active.lifecycle.status === "UNPROCESSED";
    case "E-19:active-status-unprocessed":
      return active?.kind === "STATUS" && active.lifecycle.status === "UNPROCESSED";
    case "E-19:active-timer-unprocessed":
      return active?.kind === "TIMER" && active.lifecycle.status === "UNPROCESSED";
    case "E-34:pending-send":
    case "E-34:pending-action":
    case "E-34:pending-answer":
      return Object.keys(input.snapshot.runtime.pendingOperations).length > 0;
    case "E-35:unresolved-operation":
    case "E-35:unresolved-send":
    case "E-35:unresolved-answer":
      return Object.values(input.snapshot.runtime.pendingOperations).some(
        (operation) => !operation.resultApplied,
      );
    case "E-32:timer-unprocessed":
      return true;
    case "E-32:share-unresolved":
      return true;
    case "E-32:local":
      return true;
    case "E-45:guard-a":
    case "E-45:guard-a-dispatch":
      return incomingTargetUnprocessed(input);
    case "E-45:guard-b":
      return externalEntryGuardB(input);
    case "E-46:matching-resolution":
    case "E-46:all-states":
      return true;
    case "E-44:all-states":
    case "E-44:first-launch-offline-unresolved":
      return true;
    case "E-41:established-state":
      return input.snapshot.controlState !== null && ttlExpired(input.snapshot, input.context.now);
    case "E-41:first-launch-expired":
      return (
        input.snapshot.controlState === null &&
        input.snapshot.runtime.bootstrap.status === "FIRST_LAUNCH_EXTERNAL_ENTRY" &&
        ttlExpired(input.snapshot, input.context.now)
      );
    case "E-33:normal-application-open":
      return input.snapshot.runtime.bootstrap.status !== "FIRST_LAUNCH_EXTERNAL_ENTRY";
    case "E-33:suppressed-while-pending-first-launch":
      return input.snapshot.runtime.bootstrap.status === "FIRST_LAUNCH_EXTERNAL_ENTRY";
    case "E-45:first-launch-resolved":
      return (
        input.snapshot.controlState === null &&
        input.snapshot.runtime.bootstrap.status === "FIRST_LAUNCH_EXTERNAL_ENTRY" &&
        incomingTargetUnprocessed(input)
      );
    case "E-43:status-priority":
      return evaluateStructured({ type: "STATUS_PRIORITY_APPLICABLE" }, input);
    case "E-43:timer-priority":
      return evaluateStructured({ type: "TIMER_PRIORITY_APPLICABLE" }, input);
    case "E-43:fifo-incoming-ban":
      return (
        evaluateStructured({ type: "NO_APPLICABLE_PRIORITY" }, input) &&
        head?.kind === "INCOMING_BAN"
      );
    case "E-43:fifo-timer":
      return (
        evaluateStructured({ type: "NO_APPLICABLE_PRIORITY" }, input) && head?.kind === "TIMER"
      );
    case "E-43:fifo-check-receiver":
      return (
        evaluateStructured({ type: "NO_APPLICABLE_PRIORITY" }, input) &&
        head?.kind === "CHECK" &&
        head.role === "RECEIVER"
      );
    case "E-43:fifo-check-sender":
      return (
        evaluateStructured({ type: "NO_APPLICABLE_PRIORITY" }, input) &&
        head?.kind === "CHECK" &&
        head.role === "SENDER"
      );
    case "E-43:fifo-status":
      return (
        evaluateStructured({ type: "NO_APPLICABLE_PRIORITY" }, input) && head?.kind === "STATUS"
      );
    case "E-43:queue-empty":
      return unprocessedItems(input.snapshot, input.context.currentUserId).length === 0;
    case "E-50:no-new-selection":
      return true;
    case "E-50:no-ask-rim-origin":
      return validAskRimOrigin(input.snapshot, input.context.currentUserId) === null;
    case "E-50:valid-ask-rim-origin":
      return validAskRimOrigin(input.snapshot, input.context.currentUserId) !== null;
    case "E-63:active-status-unprocessed":
      return askRimEntryApplicable(input);
    case "E-64:ordinary-current":
      return currentContextRequest(input) && !chat?.askRimOrigin;
    case "E-64:ask-rim-current":
      return (
        currentContextRequest(input) &&
        validAskRimOrigin(input.snapshot, input.context.currentUserId) !== null
      );
    case "E-64:ask-rim-origin-invalid":
      return (
        currentContextRequest(input) &&
        !!chat?.askRimOrigin &&
        validAskRimOrigin(input.snapshot, input.context.currentUserId) === null
      );
    case "E-64:stale":
      return !currentContextRequest(input);
    case "E-47:default":
    case "E-01:default":
    case "E-51:default":
      return true;
    default:
      if (branch === "default" || branch === "offline" || branch === "if-applicable") {
        if (eventId === "E-35" && branch === "offline") {
          return input.snapshot.runtime.connection === "OFFLINE";
        }
        return true;
      }
      if (branch === "guard-a") {
        return incomingTargetUnprocessed(input);
      }
      if (branch === "guard-b") {
        return externalEntryGuardB(input);
      }
      return evaluateSourceText(row.guardsText, input);
  }
}

export function evaluateRowGuard(row: MatrixContractRow, input: ResolveInput): boolean {
  if (row.guards.type !== "SOURCE_TEXT") {
    return evaluateStructured(row.guards, input);
  }
  return evaluateByBranch(row, input);
}

export function isLateServerResult(input: ResolveInput): boolean {
  if (!["E-10", "E-20", "E-22", "E-23", "E-30"].includes(input.eventId)) {
    return false;
  }
  const operation = matchingOperation(input);
  if (!operation || operation.resultApplied) {
    return false;
  }
  return operation.supersededByExternalEntry || input.snapshot.runtime.session === "CLOSED";
}
