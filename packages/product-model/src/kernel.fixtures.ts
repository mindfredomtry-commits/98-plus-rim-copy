import type {
  AiOperation,
  ApplicationProposal,
  Ban,
  BanDraft,
  CheckPair,
  DomainTimer,
  NotificationItem,
  RelationshipContext,
  RelationshipContextData,
  RimChat,
  RimMessage,
  RimRequestSnapshot,
  ShareOperation,
} from "./entities.ts";
import type { CanonicalEvent, CanonicalEventName, EventPayloadMap } from "./events.ts";
import type { PendingOperation, ProductSnapshot } from "./extended-state.ts";
import type {
  AiRequestId,
  BanId,
  CheckPairId,
  ContextRequestId,
  DomainTimerId,
  DurationMinutes,
  ExecutionProbability,
  NotificationItemId,
  OperationId,
  ProposalId,
  RimChatId,
  ShareAttemptId,
  ShareLinkId,
  UserId,
} from "./ids.ts";
import type { MatrixContractRow } from "./matrix.ts";
import type {
  Failure,
  ServerState,
  ShareLinkFailureReason,
  ShareResult,
  TemplateContext,
} from "./primitives.ts";
import { asInstant, counterAllocator, emptySnapshot } from "./kernel/snapshot.ts";
import type { ExecutionContext } from "./kernel/types.ts";
import type { ProductControlState } from "./states.ts";

export function branded<T>(value: string): T {
  return value as T;
}

export const USER_ID = branded<UserId>("user-1");
export const CONTACT_A = branded<UserId>("contact-1");
export const CONTACT_B = branded<UserId>("contact-2");
export const BAN_ID = branded<BanId>("ban-1");
export const OP_ID = branded<OperationId>("op-1");
export const REQUEST_ID = branded<ContextRequestId>("context-1");
export const AI_REQUEST_ID = branded<AiRequestId>("ai-1");
export const CHAT_ID = branded<RimChatId>("chat-1");
export const PROPOSAL_ID = branded<ProposalId>("proposal-1");
export const PROPOSAL_ID_2 = branded<ProposalId>("proposal-2");
export const PROPOSAL_ID_3 = branded<ProposalId>("proposal-3");
export const SHARE_ATTEMPT_ID = branded<ShareAttemptId>("share-1");
export const INCOMING_ITEM_ID = branded<NotificationItemId>("incoming-1");
export const TIMER_ITEM_ID = branded<NotificationItemId>("timer-item-1");
export const STATUS_ITEM_ID = branded<NotificationItemId>("status-1");
export const CHECK_ITEM_ID = branded<NotificationItemId>("check-1");
export const CHECK_SENDER_ITEM_ID = branded<NotificationItemId>("check-sender-1");
export const OTHER_USER = branded<UserId>("user-2");
export const REPLY_BAN_ID = branded<BanId>("ban-reply");

const EMPTY_STATUS_COUNTS = {
  bantastic: 0,
  banflict: 0,
  fairEnough: 0,
  overboard: 0,
} as const;

export const CONTEXT_DATA: RelationshipContextData = {
  aggregates: {
    userToContact: { bansSentCount: 0, statusCounts: { ...EMPTY_STATUS_COUNTS } },
    contactToUser: { bansSentCount: 0, statusCounts: { ...EMPTY_STATUS_COUNTS } },
  },
  recentBans: [],
};

export function kernelContext(now = 1_000_000): ExecutionContext {
  return {
    now: asInstant(now),
    currentUserId: USER_ID,
    allocateId: counterAllocator(),
  };
}

export function eventOf<K extends CanonicalEventName>(
  name: K,
  payload: EventPayloadMap[K],
): CanonicalEvent {
  return { name, payload } as CanonicalEvent;
}

export function defaultEvent(name: CanonicalEventName): CanonicalEvent {
  switch (name) {
    case "CREATE_BAN.PRESS_START":
    case "CREATE_BAN.PRESS_NEXT":
    case "CREATE_BAN.PRESS_BACK":
    case "CREATE_BAN.PRESS_FORBID":
    case "CREATE_BAN.PRESS_FORBID_MORE":
    case "NOTIFICATIONS.PRESS_REPLY_BAN":
    case "NOTIFICATIONS.PRESS_OVERBOARD":
    case "NOTIFICATIONS.CHECK_ANSWER.FULFILLED":
    case "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED":
    case "NOTIFICATIONS.PRESS_BAN_MORE":
    case "NOTIFICATIONS.PRESS_TO_BANS":
    case "REPLY_BAN.PRESS_NEXT":
    case "REPLY_BAN.PRESS_BACK":
    case "REPLY_BAN.PRESS_FORBID":
    case "REPLY_BAN.PRESS_FORBID_MORE":
    case "APP.FULL_CLOSE":
    case "CONNECTION.LOST":
    case "CONNECTION.RESTORED":
    case "EXTERNAL_ENTRY.PENDING_EXPIRED":
    case "NOTIFICATIONS.SELECT_NEXT":
    case "RIM.PRESS_START_CHAT":
    case "RIM.PRESS_SELECT_CONTACT":
    case "RIM.PRESS_BACK":
    case "RIM.PRESS_SEND":
    case "RIM.PRESS_NOTIFICATIONS":
      return eventOf(name, {});
    case "CREATE_BAN.SELECT_CONTACT":
    case "RIM.SELECT_CONTACT":
      return eventOf(name, { contactId: CONTACT_A });
    case "CREATE_BAN.SELECT_TEMPLATE":
      return eventOf(name, { templateContext: {} as TemplateContext });
    case "CREATE_BAN.CHANGE_BAN_TEXT":
    case "REPLY_BAN.CHANGE_BAN_TEXT":
      return eventOf(name, { banText: "no phones" });
    case "CREATE_BAN.CHANGE_DURATION":
    case "REPLY_BAN.CHANGE_DURATION":
      return eventOf(name, { durationMinutes: 3 });
    case "CREATE_BAN.SEND_CONFIRMED":
      return eventOf(name, { operationId: OP_ID, createdBanId: BAN_ID });
    case "CREATE_BAN.SEND_FAILED":
    case "REPLY_BAN.SEND_FAILED":
      return eventOf(name, { operationId: OP_ID, failure: {} as Failure });
    case "CREATE_BAN.SHARE_CONFIRMED":
      return eventOf(name, { shareAttemptId: SHARE_ATTEMPT_ID, result: {} as ShareResult });
    case "CREATE_BAN.SHARE_CANCELLED":
      return eventOf(name, { shareAttemptId: SHARE_ATTEMPT_ID });
    case "NOTIFICATIONS.OVERBOARD_CONFIRMED":
      return eventOf(name, {
        sourceItemId: INCOMING_ITEM_ID,
        banId: BAN_ID,
        operationId: OP_ID,
      });
    case "NOTIFICATIONS.ACTION_FAILED":
      return eventOf(name, {
        sourceItemId: INCOMING_ITEM_ID,
        operationId: OP_ID,
        failure: {} as Failure,
      });
    case "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST":
      return eventOf(name, {
        checkItemId: CHECK_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: branded<CheckPairId>("pair-1"),
      });
    case "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND":
      return eventOf(name, {
        checkItemId: CHECK_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: branded<CheckPairId>("pair-1"),
        resultingStatus: "BANTASTIC",
      });
    case "REPLY_BAN.SEND_CONFIRMED":
      return eventOf(name, {
        operationId: OP_ID,
        replyBanId: branded<BanId>("ban-reply"),
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      });
    case "APP.NORMAL_OPEN":
      return eventOf(name, { serverState: {} as ServerState });
    case "BAN.DURATION_EXPIRED":
      return eventOf(name, { banId: BAN_ID });
    case "TELEGRAM_SHARE_LINK.OPENED":
      return eventOf(name, {
        shareLinkId: branded<ShareLinkId>("share-link-1"),
        shareTargetBanId: BAN_ID,
        currentTelegramUserId: USER_ID,
      });
    case "TELEGRAM_SHARE_LINK.RESOLVED":
      return eventOf(name, {
        targetBanId: BAN_ID,
        receiverId: USER_ID,
        incomingBanItemId: INCOMING_ITEM_ID,
      });
    case "TELEGRAM_SHARE_LINK.REJECTED":
      return eventOf(name, { failureReason: {} as ShareLinkFailureReason });
    case "TELEGRAM_PERSISTENT_REENTRY.GRANTED":
    case "TELEGRAM_PERSISTENT_REENTRY.DECLINED":
      return eventOf(name, { requestId: "reentry-request-1" });
    case "RIM.CHANGE_INPUT_DRAFT":
      return eventOf(name, { inputDraft: "hello" });
    case "RIM.PRESS_RETRY_CONTEXT":
      return eventOf(name, { failedRequestId: REQUEST_ID });
    case "RIM.PRESS_RETRY_AI":
      return eventOf(name, { failedRequestId: AI_REQUEST_ID });
    case "RIM.PRESS_SUGGESTION_FORBID":
      return eventOf(name, {
        rimChatId: CHAT_ID,
        proposalId: PROPOSAL_ID,
      });
    case "RIM.CONTEXT_READY":
      return eventOf(name, {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: REQUEST_ID,
      });
    case "RIM.CONTEXT_FAILED":
      return eventOf(name, {
        rimChatId: CHAT_ID,
        selectedContactId: CONTACT_A,
        requestId: REQUEST_ID,
        failure: {} as Failure,
      });
    case "RIM.AI_RESULT_RECEIVED":
      return eventOf(name, {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        result: { kind: "MESSAGE", text: "ok" },
      });
    case "RIM.AI_REQUEST_FAILED":
      return eventOf(name, {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        failure: {} as Failure,
      });
    default: {
      const _never: never = name;
      return _never;
    }
  }
}

export function logicalAiSnapshot(overrides: Partial<RimRequestSnapshot> = {}): RimRequestSnapshot {
  const requestId = overrides.requestId ?? AI_REQUEST_ID;
  return {
    requestId,
    rimChatId: overrides.rimChatId ?? CHAT_ID,
    userMessage: overrides.userMessage ?? "hello",
    contextRequestId: overrides.contextRequestId ?? REQUEST_ID,
  };
}

export function pendingAi(
  overrides: Partial<RimRequestSnapshot> = {},
): Extract<AiOperation, { status: "PENDING" }> {
  const snapshot = logicalAiSnapshot(overrides);
  return { status: "PENDING", requestId: snapshot.requestId, snapshot };
}

export function failedAi(
  failure: Failure = {} as Failure,
  overrides: Partial<RimRequestSnapshot> = {},
): Extract<AiOperation, { status: "FAILED" }> {
  const snapshot = logicalAiSnapshot(overrides);
  return { status: "FAILED", requestId: snapshot.requestId, snapshot, failure };
}

export function makeChat(overrides: Partial<RimChat> = {}): RimChat {
  return {
    id: CHAT_ID,
    selectedContactId: null,
    relationshipContext: null,
    messages: [],
    inputDraft: "",
    aiOperation: { status: "IDLE" },
    askRimOrigin: null,
    ...overrides,
  };
}

export function loadingContext(
  contactId: UserId = CONTACT_A,
  requestId: ContextRequestId = REQUEST_ID,
): RelationshipContext {
  return {
    selectedContactId: contactId,
    status: "loading",
    requestId,
    data: null,
    failure: null,
  };
}

export function readyContext(
  contactId: UserId = CONTACT_A,
  requestId: ContextRequestId = REQUEST_ID,
): RelationshipContext {
  return {
    selectedContactId: contactId,
    status: "ready",
    requestId,
    data: CONTEXT_DATA,
    failure: null,
  };
}

export function makeBan(overrides: Partial<Ban> = {}): Ban {
  return {
    id: BAN_ID,
    senderId: USER_ID,
    receiverId: OTHER_USER,
    banText: "no phones",
    durationMinutes: 3 as DurationMinutes,
    acceptance: "ACCEPTED",
    status: null,
    boundViaTelegramShareLink: false,
    sourceProposalId: null,
    ...overrides,
  };
}

export function applicationProposal(
  proposalId: ProposalId,
  banText = "no phones",
  executionProbability = 0.5 as ExecutionProbability,
): ApplicationProposal {
  return { proposalId, banText, executionProbability };
}

export function proposalsMessage(
  proposals: readonly [ApplicationProposal, ApplicationProposal, ApplicationProposal] = [
    applicationProposal(PROPOSAL_ID),
    applicationProposal(PROPOSAL_ID_2, "no meetings"),
    applicationProposal(PROPOSAL_ID_3, "no mail"),
  ],
  message = "three bans",
): Extract<RimMessage, { kind: "BAN_PROPOSALS" }> {
  return { kind: "BAN_PROPOSALS", message, proposals };
}

export function makeTimer(overrides: Partial<DomainTimer> = {}): DomainTimer {
  return {
    id: branded<DomainTimerId>("timer-1"),
    banId: BAN_ID,
    startedAt: asInstant(0),
    durationMinutes: 3 as DurationMinutes,
    state: "RUNNING",
    checkPairCreated: false,
    ...overrides,
  };
}

export function incomingItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: INCOMING_ITEM_ID,
    ownerId: USER_ID,
    banId: BAN_ID,
    fifoSequence: 1,
    lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    kind: "INCOMING_BAN",
    ...overrides,
  } as NotificationItem;
}

export function timerItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: TIMER_ITEM_ID,
    ownerId: USER_ID,
    banId: BAN_ID,
    fifoSequence: 1,
    lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    kind: "TIMER",
    domainTimerId: branded<DomainTimerId>("timer-1"),
    ...overrides,
  } as NotificationItem;
}

export function statusItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: STATUS_ITEM_ID,
    ownerId: USER_ID,
    banId: BAN_ID,
    fifoSequence: 1,
    lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    kind: "STATUS",
    role: "RECEIVER",
    status: "BANTASTIC",
    ...overrides,
  } as NotificationItem;
}

export function checkItem(
  role: "RECEIVER" | "SENDER" = "RECEIVER",
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: role === "RECEIVER" ? CHECK_ITEM_ID : CHECK_SENDER_ITEM_ID,
    ownerId: USER_ID,
    banId: BAN_ID,
    fifoSequence: 1,
    lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    kind: "CHECK",
    role,
    checkPairId: branded<CheckPairId>("pair-1"),
    ...overrides,
  } as NotificationItem;
}

export function pendingOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    operationId: OP_ID,
    kind: "CREATE_BAN_SEND",
    originatingState: "CREATE_BAN.CONFIRM.CONTACT",
    originatingItemId: null,
    resultApplied: false,
    supersededByExternalEntry: false,
    sendDraft: null,
    ...overrides,
  };
}

function withCheckWorld(snapshot: ProductSnapshot, row: MatrixContractRow): ProductSnapshot {
  const role: "RECEIVER" | "SENDER" = row.state.includes("SENDER") ? "SENDER" : "RECEIVER";
  const ban = makeBan({
    senderId: role === "SENDER" ? USER_ID : OTHER_USER,
    receiverId: role === "RECEIVER" ? USER_ID : OTHER_USER,
    acceptance: "ACCEPTED",
  });
  const pair: CheckPair = {
    id: branded<CheckPairId>("pair-1"),
    banId: BAN_ID,
    receiverItemId: CHECK_ITEM_ID,
    senderItemId: CHECK_SENDER_ITEM_ID,
    receiverAnswer: row.eventId === "E-23" && role === "SENDER" ? "FULFILLED" : null,
    senderAnswer: row.eventId === "E-23" && role === "RECEIVER" ? "FULFILLED" : null,
    resultingStatus: null,
  };
  const active = checkItem(role, {
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const other = checkItem(role === "RECEIVER" ? "SENDER" : "RECEIVER", { ownerId: OTHER_USER });
  let next = withEntities(snapshot, {
    bans: { [BAN_ID]: ban },
    checkPairs: { "pair-1": pair },
    notificationItems: { [active.id]: active, [other.id]: other },
  });
  next = {
    ...next,
    extended: { ...next.extended, activeNotificationItemId: active.id },
  };
  return withOperation(
    next,
    pendingOp({
      kind: "CHECK_ANSWER",
      originatingState: row.state as ProductControlState,
      originatingItemId: active.id,
    }),
  );
}

function withReplyWorld(snapshot: ProductSnapshot, row: MatrixContractRow): ProductSnapshot {
  const fromStatus = row.state.includes("STATUS");
  const sourceItem = fromStatus
    ? statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } })
    : incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } });
  let next = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        durationMinutes: 12 as DurationMinutes,
      }),
    },
    notificationItems: { [sourceItem.id]: sourceItem },
  });
  next = {
    ...next,
    extended: {
      ...next.extended,
      activeNotificationItemId: sourceItem.id,
      replyBanDraft: { banText: "reply text", durationMinutes: 15 as DurationMinutes },
      replySource: {
        kind: fromStatus ? "STATUS" : "INCOMING_BAN",
        itemId: sourceItem.id,
        banId: BAN_ID,
      },
    },
  };
  return withOperation(
    next,
    pendingOp({
      kind: "REPLY_BAN_SEND",
      originatingState: row.state as ProductControlState,
      originatingItemId: sourceItem.id,
    }),
  );
}

export function shareOp(overrides: Partial<ShareOperation> = {}): ShareOperation {
  return {
    attemptId: SHARE_ATTEMPT_ID,
    draft: {
      origin: "TEMPLATE",
      selectedContactId: null,
      banText: "no phones",
      durationMinutes: 3 as DurationMinutes,
      proposalId: null,
    },
    token: "share-token" as never,
    status: "ACTIVE",
    createdBanId: null,
    ...overrides,
  };
}

export function withControlState(
  snapshot: ProductSnapshot,
  controlState: ProductControlState | null,
): ProductSnapshot {
  if (controlState === snapshot.controlState) {
    return snapshot;
  }
  return {
    ...snapshot,
    controlState,
    extended: {
      ...snapshot.extended,
      telegramPersistentReentryCtaSurfaceGeneration:
        snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration + 1,
    },
  };
}

export function withChat(snapshot: ProductSnapshot, chat: RimChat | null): ProductSnapshot {
  return {
    ...snapshot,
    extended: { ...snapshot.extended, rimChat: chat },
  };
}

export function withEntities(
  snapshot: ProductSnapshot,
  patch: Partial<ProductSnapshot["extended"]["entities"]>,
): ProductSnapshot {
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: { ...snapshot.extended.entities, ...patch },
    },
  };
}

export function withItems(
  snapshot: ProductSnapshot,
  items: readonly NotificationItem[],
): ProductSnapshot {
  return withEntities(snapshot, {
    notificationItems: Object.fromEntries(items.map((item) => [item.id, item])),
  });
}

export function withOperation(
  snapshot: ProductSnapshot,
  operation: PendingOperation,
): ProductSnapshot {
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      pendingOperations: {
        ...snapshot.runtime.pendingOperations,
        [operation.operationId]: operation,
      },
    },
  };
}

export function validCreateDraft(origin: "CONTACT" | "TEMPLATE" | "RIM" = "CONTACT"): BanDraft {
  return {
    origin,
    selectedContactId: origin === "TEMPLATE" ? null : CONTACT_A,
    banText: "no phones",
    durationMinutes: 3 as DurationMinutes,
    proposalId: origin === "RIM" ? PROPOSAL_ID : null,
  };
}

function withDrafts(snapshot: ProductSnapshot, row: MatrixContractRow): ProductSnapshot {
  let next = snapshot;
  if (typeof row.state === "string" && row.state.startsWith("CREATE_BAN")) {
    const origin = row.state.includes("TEMPLATE")
      ? "TEMPLATE"
      : row.state.includes("RIM")
        ? "RIM"
        : "CONTACT";
    next = {
      ...next,
      extended: {
        ...next.extended,
        createBanDraft:
          row.branch === "invalid-draft"
            ? {
                origin,
                selectedContactId: origin === "TEMPLATE" ? null : CONTACT_A,
                banText: "",
                durationMinutes: null,
                proposalId: null,
              }
            : validCreateDraft(origin),
      },
    };
  }
  if (typeof row.state === "string" && row.state.startsWith("REPLY_BAN")) {
    next = {
      ...next,
      extended: {
        ...next.extended,
        replyBanDraft:
          row.branch === "invalid-draft"
            ? { banText: "", durationMinutes: null }
            : { banText: "no phones", durationMinutes: 3 as DurationMinutes },
        replySource: row.state.includes("STATUS")
          ? { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID }
          : { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      },
    };
  }
  return next;
}

function withDefaultChat(snapshot: ProductSnapshot, row: MatrixContractRow): ProductSnapshot {
  if (row.state !== "RIM.CHAT" && row.state !== "RIM.SELECT_CONTACT" && row.state !== "RIM.LOBBY") {
    if (typeof row.state === "string" && row.state.includes("RIM")) {
      return withChat(
        snapshot,
        makeChat({ selectedContactId: CONTACT_A, relationshipContext: readyContext() }),
      );
    }
    return snapshot;
  }
  if (row.state === "RIM.LOBBY") {
    return snapshot;
  }
  if (row.state === "RIM.SELECT_CONTACT" && row.branch === "initial-selected-contact") {
    return withChat(snapshot, makeChat({ inputDraft: "keep me" }));
  }
  if (row.state === "RIM.CHAT" || row.state === "RIM.SELECT_CONTACT") {
    return withChat(
      snapshot,
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: readyContext(),
        inputDraft: row.branch === "whitespace" ? "   " : "hello",
      }),
    );
  }
  return snapshot;
}

export function fixtureForRow(row: MatrixContractRow): {
  snapshot: ProductSnapshot;
  event: CanonicalEvent;
} {
  let snapshot = emptySnapshot();
  if (row.kind === "BOOTSTRAP") {
    snapshot = withControlState(snapshot, null);
    if (row.branch !== "normal-application-open") {
      snapshot = {
        ...snapshot,
        runtime: { ...snapshot.runtime, bootstrap: { status: "FIRST_LAUNCH_EXTERNAL_ENTRY" } },
      };
    }
  } else if (
    row.kind === "LOCAL" &&
    row.state !== "GLOBAL" &&
    row.state !== "BOOTSTRAP" &&
    row.state !== "E43"
  ) {
    snapshot = withControlState(snapshot, row.state);
  } else {
    snapshot = withControlState(snapshot, "RIM.LOBBY");
  }

  snapshot = withDrafts(snapshot, row);
  snapshot = withDefaultChat(snapshot, row);

  const key = `${row.eventId}:${row.branch}`;
  snapshot = prepareBranchSnapshot(snapshot, row, key);
  const event = eventForRow(row);
  return { snapshot, event };
}

function pendingEntry(firstLaunch: boolean) {
  return {
    shareLinkId: branded<ShareLinkId>("share-link-1"),
    shareTargetBanId: BAN_ID,
    currentTelegramUserId: USER_ID,
    entryTimestamp: asInstant(0),
    firstLaunch,
  };
}

function prepareBranchSnapshot(
  snapshot: ProductSnapshot,
  row: MatrixContractRow,
  key: string,
): ProductSnapshot {
  let next = snapshot;
  const putItem = (item: NotificationItem, active = false) => {
    next = withItems(next, [item]);
    if (active) {
      next = {
        ...next,
        extended: { ...next.extended, activeNotificationItemId: item.id },
      };
    }
  };

  switch (key) {
    case "E-49:change-selected-contact":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          messages: [{ kind: "USER", text: "old" }],
          inputDraft: "old-draft",
          aiOperation: failedAi(),
        }),
      );
      break;
    case "E-49:same-current-selected-contact":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          messages: [{ kind: "RIM", text: "kept" }],
          inputDraft: "kept-draft",
          aiOperation: failedAi(),
        }),
      );
      break;
    case "E-52:context-unavailable":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: loadingContext(),
          inputDraft: "hello",
        }),
      );
      break;
    case "E-52:active-ai-request":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          inputDraft: "hello",
          aiOperation: pendingAi(),
        }),
      );
      break;
    case "E-52:valid":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          inputDraft: "hello",
        }),
      );
      break;
    case "E-53:failed-current-context":
    case "E-57:current-contact":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: {
            selectedContactId: CONTACT_A,
            status: "error",
            requestId: REQUEST_ID,
            data: null,
            failure: {} as Failure,
          },
        }),
      );
      break;
    case "E-54:failed-ai-request":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          aiOperation: failedAi(),
        }),
      );
      break;
    case "E-59:current-request":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          aiOperation: pendingAi(),
        }),
      );
      break;
    case "E-56:current-contact":
    case "E-56:no-new-selection-prior-contact":
    case "E-58:current-request":
    case "E-58:no-new-selection-prior-ai":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: loadingContext(),
          aiOperation: row.eventId === "E-58" ? pendingAi() : { status: "IDLE" },
        }),
      );
      break;
    case "E-56:stale-contact":
    case "E-56:stale-replaced-contact":
    case "E-57:stale-contact":
    case "E-57:stale-replaced-contact":
    case "E-58:stale-request":
    case "E-58:stale-replaced-contact":
    case "E-59:stale-request":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_B,
          relationshipContext: loadingContext(CONTACT_B, branded<ContextRequestId>("context-new")),
          aiOperation: pendingAi({ requestId: branded<AiRequestId>("ai-new") }),
        }),
      );
      break;
    case "E-55:valid-current-suggestion":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          messages: [proposalsMessage()],
        }),
      );
      break;
    case "E-55:invalid-proposal":
      next = withChat(
        next,
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          messages: [
            proposalsMessage([
              applicationProposal(branded<ProposalId>("proposal-other")),
              applicationProposal(PROPOSAL_ID_2, "no meetings"),
              applicationProposal(PROPOSAL_ID_3, "no mail"),
            ]),
          ],
        }),
      );
      break;
    case "E-48:current-chat-exists":
      next = withChat(next, makeChat({ selectedContactId: CONTACT_A }));
      break;
    case "E-56:frozen-source-operation":
    case "E-57:frozen-source-operation":
    case "E-58:frozen-source-operation":
    case "E-59:frozen-source-operation":
      next = {
        ...next,
        extended: {
          ...next.extended,
          savedFrozenRimChat: makeChat({
            selectedContactId: CONTACT_A,
            relationshipContext: readyContext(),
          }),
        },
      };
      break;
    case "E-43:status-priority":
      next = withItems(next, [statusItem()]);
      next = {
        ...next,
        extended: {
          ...next.extended,
          priorities: { statusItemId: STATUS_ITEM_ID, timerItemId: null },
        },
      };
      break;
    case "E-43:timer-priority":
      next = withItems(next, [timerItem()]);
      next = {
        ...next,
        extended: {
          ...next.extended,
          priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
        },
      };
      break;
    case "E-43:fifo-incoming-ban":
    case "E-14:active-incoming-unprocessed":
      putItem(incomingItem(), key.startsWith("E-14"));
      if (key.startsWith("E-14")) {
        putItem(incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }), true);
      }
      break;
    case "E-43:fifo-timer":
      putItem(timerItem());
      break;
    case "E-43:fifo-check-receiver":
      putItem(checkItem("RECEIVER"));
      break;
    case "E-43:fifo-check-sender":
      putItem(checkItem("SENDER"));
      break;
    case "E-43:fifo-status":
      putItem(statusItem());
      break;
    case "E-43:queue-empty":
    case "E-09:queue-empty":
    case "E-29:queue-empty":
    case "E-29:timer-processed-queue-empty":
      next = withItems(next, []);
      break;
    case "E-09:unprocessed-items-exist":
    case "E-29:unprocessed-items-exist":
    case "E-60:unprocessed-items-exist":
    case "E-29:timer-processed-other-items":
      putItem(incomingItem());
      break;
    case "E-29:timer-still-unprocessed":
    case "E-32:timer-unprocessed":
    case "E-32:timer-notification-item-overlay":
    case "E-19:active-timer-unprocessed":
      next = withEntities(next, { domainTimers: { "timer-1": makeTimer() } });
      putItem(timerItem(), key.startsWith("E-19"));
      next = {
        ...next,
        extended: {
          ...next.extended,
          priorities: { ...next.extended.priorities, timerItemId: TIMER_ITEM_ID },
        },
      };
      break;
    case "E-18:active-status-unprocessed":
    case "E-14:active-status-unprocessed":
      putItem(statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }), true);
      break;
    case "E-10:matching-unapplied":
    case "E-11:matching-operation":
    case "E-11:matching-pending":
    case "E-20:matching-unapplied":
    case "E-21:matching-pending":
    case "E-21:matching-pending-answer":
    case "E-22:matching-first-of-pair":
    case "E-30:matching-unapplied":
    case "E-31:matching-operation":
    case "E-34:pending-send":
    case "E-34:pending-action":
    case "E-34:pending-answer":
    case "E-35:unresolved-operation":
    case "E-35:unresolved-send":
    case "E-35:unresolved-answer": {
      const kind =
        row.state.includes("CHECK") || row.eventId === "E-22" || row.eventId === "E-23"
          ? "CHECK_ANSWER"
          : row.eventId === "E-20" || row.eventId === "E-21" || row.eventId === "E-15"
            ? "OVERBOARD"
            : row.state.startsWith("REPLY_BAN")
              ? "REPLY_BAN_SEND"
              : "CREATE_BAN_SEND";
      next = withOperation(
        next,
        pendingOp({
          kind:
            row.state.includes("CHECK") || row.eventId === "E-22" || row.eventId === "E-23"
              ? "CHECK_ANSWER"
              : row.eventId === "E-20" ||
                  row.eventId === "E-21" ||
                  row.eventId === "E-15" ||
                  kind === "OVERBOARD"
                ? "OVERBOARD"
                : kind,
          originatingState: row.state as ProductControlState,
        }),
      );
      if (row.eventId === "E-22" || row.eventId === "E-23") {
        const pair: CheckPair = {
          id: branded<CheckPairId>("pair-1"),
          banId: BAN_ID,
          receiverItemId: CHECK_ITEM_ID,
          senderItemId: branded<NotificationItemId>("check-sender-1"),
          receiverAnswer: null,
          senderAnswer: null,
          resultingStatus: null,
        };
        next = withEntities(next, { checkPairs: { "pair-1": pair } });
        putItem(checkItem("RECEIVER"), true);
      }
      break;
    }
    case "E-12:matching-share-attempt":
    case "E-13:closed-without-send":
    case "E-32:share-unresolved":
      next = withEntities(next, { shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() } });
      break;
    case "E-42:eligible-ban":
    case "E-42:other-eligible-ban":
    case "E-42:default":
      next = withEntities(next, {
        bans: { [BAN_ID]: makeBan() },
        domainTimers: { "timer-1": makeTimer() },
      });
      if (row.branch === "other-eligible-ban") {
        putItem(incomingItem({ banId: branded<BanId>("ban-other") }), true);
      }
      break;
    case "E-45:guard-a":
    case "E-45:guard-a-dispatch":
    case "E-45:first-launch-resolved":
      putItem(incomingItem());
      if (row.kind === "BOOTSTRAP") {
        next = {
          ...next,
          extended: { ...next.extended, pendingExternalEntry: pendingEntry(true) },
        };
      }
      break;
    case "E-45:guard-b":
      putItem(incomingItem({ lifecycle: { status: "PROCESSED" } }));
      next = withEntities(next, {
        bans: {
          [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID }),
        },
      });
      break;
    case "E-61:guard-a":
      next = {
        ...next,
        extended: {
          ...next.extended,
          telegramPersistentReentryEligible: true,
          telegramPersistentReentryEstablished: false,
          telegramPersistentReentryActiveRequestId: "reentry-request-1",
        },
      };
      break;
    case "E-62:guard-a":
      next = {
        ...next,
        extended: {
          ...next.extended,
          telegramPersistentReentryEligible: true,
          telegramPersistentReentryEstablished: false,
          telegramPersistentReentryActiveRequestId: "reentry-request-1",
        },
      };
      break;
    case "E-41:established-state":
      next = {
        ...next,
        extended: { ...next.extended, pendingExternalEntry: pendingEntry(false) },
      };
      break;
    case "E-41:first-launch-expired":
    case "E-44:first-launch-offline-unresolved":
    case "E-33:suppressed-while-pending-first-launch":
      next = {
        ...next,
        runtime: {
          ...next.runtime,
          bootstrap: { status: "FIRST_LAUNCH_EXTERNAL_ENTRY" },
          connection: row.eventId === "E-44" ? "OFFLINE" : next.runtime.connection,
        },
        extended: { ...next.extended, pendingExternalEntry: pendingEntry(true) },
      };
      break;
    case "E-35:offline":
    case "E-35:default":
      if (row.branch === "offline" || row.guards.type === "CONNECTION_OFFLINE") {
        next = { ...next, runtime: { ...next.runtime, connection: "OFFLINE" } };
      }
      break;
    case "LATE_RESULT:after-newer-external-entry":
      next = withControlState(next, "NOTIFICATIONS.INCOMING_BAN");
      next = withOperation(next, pendingOp({ supersededByExternalEntry: true }));
      next = withEntities(next, { bans: { [BAN_ID]: makeBan({ acceptance: "PENDING" }) } });
      putItem(incomingItem(), true);
      break;
    default:
      break;
  }

  if (row.eventId === "E-22" || row.eventId === "E-23") {
    next = withCheckWorld(next, row);
  }
  if (row.eventId === "E-30") {
    next = withReplyWorld(next, row);
  }
  if (row.eventId === "E-10" || row.eventId === "LATE_RESULT") {
    next = {
      ...next,
      extended: {
        ...next.extended,
        createBanDraft: next.extended.createBanDraft ?? validCreateDraft("CONTACT"),
      },
    };
  }
  if (row.eventId === "E-20") {
    next = withEntities(next, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
      },
    });
  }

  if (row.eventId === "E-32" && row.kind === "GLOBAL") {
    next = withEntities(next, { domainTimers: { "timer-1": makeTimer() } });
    next = withItems(next, [timerItem()]);
    next = {
      ...next,
      extended: {
        ...next.extended,
        priorities: { ...next.extended.priorities, timerItemId: TIMER_ITEM_ID },
      },
    };
  }

  if (
    typeof row.state === "string" &&
    row.state.startsWith("NOTIFICATIONS") &&
    !next.extended.activeNotificationItemId
  ) {
    if (row.state === "NOTIFICATIONS.INCOMING_BAN") {
      putItem(incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }), true);
    } else if (row.state === "NOTIFICATIONS.TIMER") {
      putItem(timerItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }), true);
    } else if (row.state === "NOTIFICATIONS.CHECK.RECEIVER") {
      putItem(
        checkItem("RECEIVER", { lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
        true,
      );
    } else if (row.state === "NOTIFICATIONS.CHECK.SENDER") {
      putItem(
        checkItem("SENDER", { lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
        true,
      );
    } else if (row.state.startsWith("NOTIFICATIONS.STATUS")) {
      putItem(statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }), true);
    }
  }

  if (row.eventId === "E-07" && row.state.includes("RIM")) {
    next = {
      ...next,
      extended: {
        ...next.extended,
        savedFrozenRimChat: makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          inputDraft: "frozen-draft",
          messages: [{ kind: "USER", text: "frozen" }],
        }),
        rimChat: makeChat({ selectedContactId: CONTACT_A, inputDraft: "changed" }),
      },
    };
  }

  return next;
}

function eventForRow(row: MatrixContractRow): CanonicalEvent {
  if (row.eventId === "LATE_RESULT") {
    return eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID });
  }
  const base = defaultEvent(row.eventName as CanonicalEventName);
  if (row.eventId === "E-49" && row.branch === "change-selected-contact") {
    return eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B });
  }
  if (row.eventId === "E-22" || row.eventId === "E-23") {
    const itemId = row.state.includes("SENDER") ? CHECK_SENDER_ITEM_ID : CHECK_ITEM_ID;
    const resultingStatus =
      row.branch === "resulting-status-banflict"
        ? "BANFLICT"
        : row.branch === "resulting-status-fair-enough"
          ? "FAIR_ENOUGH"
          : "BANTASTIC";
    return row.eventId === "E-22"
      ? eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
          checkItemId: itemId,
          answer: "FULFILLED",
          checkPairId: branded<CheckPairId>("pair-1"),
        })
      : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
          checkItemId: itemId,
          answer: row.branch === "resulting-status-banflict" ? "NOT_FULFILLED" : "FULFILLED",
          checkPairId: branded<CheckPairId>("pair-1"),
          resultingStatus,
        });
  }
  if (row.eventId === "E-30") {
    const fromStatus = row.state.includes("STATUS");
    return eventOf("REPLY_BAN.SEND_CONFIRMED", {
      operationId: OP_ID,
      replyBanId: REPLY_BAN_ID,
      source: {
        kind: fromStatus ? "STATUS" : "INCOMING_BAN",
        itemId: fromStatus ? STATUS_ITEM_ID : INCOMING_ITEM_ID,
        banId: BAN_ID,
      },
    });
  }
  if (row.eventId === "E-56" && row.branch.startsWith("stale")) {
    return eventOf("RIM.CONTEXT_READY", {
      rimChatId: CHAT_ID,
      selectedContactId: CONTACT_A,
      relationshipContext: CONTEXT_DATA,
      requestId: REQUEST_ID,
    });
  }
  if (row.eventId === "E-58" && row.branch.startsWith("stale")) {
    return eventOf("RIM.AI_RESULT_RECEIVED", {
      rimChatId: CHAT_ID,
      requestId: AI_REQUEST_ID,
      result: { kind: "MESSAGE", text: "stale" },
    });
  }
  return base;
}

export function snapshotWithLobbyChat(): ProductSnapshot {
  return withControlState(emptySnapshot(), "RIM.LOBBY");
}
