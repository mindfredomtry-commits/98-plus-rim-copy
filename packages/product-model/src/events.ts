import type { AuthorityReference, ReferencedDefinition } from "./authority.ts";
import { AUTHORITY_DOCUMENTS } from "./authority.ts";
import type {
  AiRequestId,
  BanId,
  CheckPairId,
  ContextRequestId,
  NotificationItemId,
  OperationId,
  ProposalId,
  RimChatId,
  ShareAttemptId,
  ShareLinkId,
  UserId,
} from "./ids.ts";
import type {
  CheckAnswer,
  CheckDerivedStatus,
  Failure,
  ServerState,
  ShareLinkFailureReason,
  ShareResult,
  TemplateContext,
} from "./primitives.ts";
import type { RelationshipContextData, ReplySource, RimAiResult } from "./entities.ts";

const eventRegistry = AUTHORITY_DOCUMENTS.eventRegistry;

function refs(
  locator: string,
  extras: readonly AuthorityReference[] = [],
): readonly [AuthorityReference, ...AuthorityReference[]] {
  return [{ document: eventRegistry, locator }, ...extras];
}

export type EventSourceClass =
  "UI" | "SERVER" | "TELEGRAM" | "LIFECYCLE" | "CONNECTIVITY" | "TIME" | "STATE_MACHINE" | "AI";

export type EventPayloadMap = {
  "CREATE_BAN.PRESS_START": Record<string, never>;
  "CREATE_BAN.SELECT_CONTACT": { contactId: UserId };
  "CREATE_BAN.SELECT_TEMPLATE": { templateContext: TemplateContext };
  "CREATE_BAN.CHANGE_BAN_TEXT": { banText: string };
  "CREATE_BAN.CHANGE_DURATION": { durationMinutes: number };
  "CREATE_BAN.PRESS_NEXT": Record<string, never>;
  "CREATE_BAN.PRESS_BACK": Record<string, never>;
  "CREATE_BAN.PRESS_FORBID": Record<string, never>;
  "CREATE_BAN.PRESS_FORBID_MORE": Record<string, never>;
  "CREATE_BAN.SEND_CONFIRMED": { operationId: OperationId; createdBanId: BanId };
  "CREATE_BAN.SEND_FAILED": { operationId: OperationId; failure: Failure };
  "CREATE_BAN.SHARE_CONFIRMED": { shareAttemptId: ShareAttemptId; result: ShareResult };
  "CREATE_BAN.SHARE_CANCELLED": { shareAttemptId: ShareAttemptId };
  "NOTIFICATIONS.PRESS_REPLY_BAN": Record<string, never>;
  "NOTIFICATIONS.PRESS_OVERBOARD": Record<string, never>;
  "NOTIFICATIONS.CHECK_ANSWER.FULFILLED": Record<string, never>;
  "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED": Record<string, never>;
  "NOTIFICATIONS.PRESS_BAN_MORE": Record<string, never>;
  "NOTIFICATIONS.PRESS_TO_BANS": Record<string, never>;
  "NOTIFICATIONS.PRESS_ASK_RIM": Record<string, never>;
  "NOTIFICATIONS.OVERBOARD_CONFIRMED": {
    sourceItemId: NotificationItemId;
    banId: BanId;
    operationId: OperationId;
  };
  "NOTIFICATIONS.ACTION_FAILED": {
    sourceItemId: NotificationItemId;
    operationId: OperationId;
    failure: Failure;
  };
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST": {
    checkItemId: NotificationItemId;
    answer: CheckAnswer;
    checkPairId: CheckPairId;
  };
  "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND": {
    checkItemId: NotificationItemId;
    answer: CheckAnswer;
    checkPairId: CheckPairId;
    resultingStatus: CheckDerivedStatus;
  };
  "REPLY_BAN.CHANGE_BAN_TEXT": { banText: string };
  "REPLY_BAN.CHANGE_DURATION": { durationMinutes: number };
  "REPLY_BAN.PRESS_NEXT": Record<string, never>;
  "REPLY_BAN.PRESS_BACK": Record<string, never>;
  "REPLY_BAN.PRESS_FORBID": Record<string, never>;
  "REPLY_BAN.PRESS_FORBID_MORE": Record<string, never>;
  "REPLY_BAN.SEND_CONFIRMED": {
    operationId: OperationId;
    replyBanId: BanId;
    source: ReplySource;
  };
  "REPLY_BAN.SEND_FAILED": { operationId: OperationId; failure: Failure };
  "APP.FULL_CLOSE": Record<string, never>;
  "APP.NORMAL_OPEN": { serverState: ServerState };
  "CONNECTION.LOST": Record<string, never>;
  "CONNECTION.RESTORED": Record<string, never>;
  "EXTERNAL_ENTRY.PENDING_EXPIRED": Record<string, never>;
  "BAN.DURATION_EXPIRED": { banId: BanId };
  "NOTIFICATIONS.SELECT_NEXT": Record<string, never>;
  "TELEGRAM_SHARE_LINK.OPENED": {
    shareLinkId: ShareLinkId;
    shareTargetBanId: BanId;
    currentTelegramUserId: UserId;
  };
  "TELEGRAM_SHARE_LINK.RESOLVED": {
    targetBanId: BanId;
    receiverId: UserId;
    incomingBanItemId: NotificationItemId;
  };
  "TELEGRAM_SHARE_LINK.REJECTED": { failureReason: ShareLinkFailureReason };
  "RIM.PRESS_START_CHAT": Record<string, never>;
  "RIM.PRESS_SELECT_CONTACT": Record<string, never>;
  "RIM.SELECT_CONTACT": { contactId: UserId };
  "RIM.PRESS_BACK": Record<string, never>;
  "RIM.CHANGE_INPUT_DRAFT": { inputDraft: string };
  "RIM.PRESS_SEND": Record<string, never>;
  "RIM.PRESS_RETRY_CONTEXT": { failedRequestId: ContextRequestId };
  "RIM.PRESS_RETRY_AI": { failedRequestId: AiRequestId };
  "RIM.PRESS_SUGGESTION_FORBID": {
    rimChatId: RimChatId;
    proposalId: ProposalId;
  };
  "RIM.CONTEXT_READY": {
    rimChatId: RimChatId;
    selectedContactId: UserId;
    relationshipContext: RelationshipContextData;
    requestId: ContextRequestId;
  };
  "RIM.CONTEXT_FAILED": {
    rimChatId: RimChatId;
    selectedContactId: UserId;
    requestId: ContextRequestId;
    failure: Failure;
  };
  "RIM.AI_RESULT_RECEIVED": { rimChatId: RimChatId; requestId: AiRequestId; result: RimAiResult };
  "RIM.AI_REQUEST_FAILED": { rimChatId: RimChatId; requestId: AiRequestId; failure: Failure };
  "RIM.INITIALIZATION_UNRECOVERABLE": {
    rimChatId: RimChatId;
    selectedContactId: UserId;
    contextRequestId: ContextRequestId;
  };
  "RIM.PRESS_NOTIFICATIONS": Record<string, never>;
  "TELEGRAM_PERSISTENT_REENTRY.GRANTED": { requestId: string };
  "TELEGRAM_PERSISTENT_REENTRY.DECLINED": { requestId: string };
};

export type CanonicalEventName = keyof EventPayloadMap;

export type CanonicalEvent = {
  [K in CanonicalEventName]: {
    name: K;
    payload: EventPayloadMap[K];
  };
}[CanonicalEventName];

export type CanonicalEventId =
  | "E-01"
  | "E-02"
  | "E-03"
  | "E-04"
  | "E-05"
  | "E-06"
  | "E-07"
  | "E-08"
  | "E-09"
  | "E-10"
  | "E-11"
  | "E-12"
  | "E-13"
  | "E-14"
  | "E-15"
  | "E-16"
  | "E-17"
  | "E-18"
  | "E-19"
  | "E-20"
  | "E-21"
  | "E-22"
  | "E-23"
  | "E-24"
  | "E-25"
  | "E-26"
  | "E-27"
  | "E-28"
  | "E-29"
  | "E-30"
  | "E-31"
  | "E-32"
  | "E-33"
  | "E-34"
  | "E-35"
  | "E-41"
  | "E-42"
  | "E-43"
  | "E-44"
  | "E-45"
  | "E-46"
  | "E-47"
  | "E-48"
  | "E-49"
  | "E-50"
  | "E-51"
  | "E-52"
  | "E-53"
  | "E-54"
  | "E-55"
  | "E-56"
  | "E-57"
  | "E-58"
  | "E-59"
  | "E-60"
  | "E-61"
  | "E-62"
  | "E-63"
  | "E-64";

export const ABSENT_EVENT_IDS = ["E-36", "E-37", "E-38", "E-39", "E-40"] as const;
export type AbsentEventId = (typeof ABSENT_EVENT_IDS)[number];

export type CanonicalEventDefinition = ReferencedDefinition &
  Readonly<{
    id: CanonicalEventId;
    name: CanonicalEventName;
    source: EventSourceClass;
  }>;

export const CANONICAL_EVENT_DEFINITIONS = [
  {
    id: "E-01",
    name: "CREATE_BAN.PRESS_START",
    source: "UI",
    references: refs("E-01 CREATE_BAN.PRESS_START"),
  },
  {
    id: "E-02",
    name: "CREATE_BAN.SELECT_CONTACT",
    source: "UI",
    references: refs("E-02 CREATE_BAN.SELECT_CONTACT"),
  },
  {
    id: "E-03",
    name: "CREATE_BAN.SELECT_TEMPLATE",
    source: "UI",
    references: refs("E-03 CREATE_BAN.SELECT_TEMPLATE"),
  },
  {
    id: "E-04",
    name: "CREATE_BAN.CHANGE_BAN_TEXT",
    source: "UI",
    references: refs("E-04 CREATE_BAN.CHANGE_BAN_TEXT"),
  },
  {
    id: "E-05",
    name: "CREATE_BAN.CHANGE_DURATION",
    source: "UI",
    references: refs("E-05 CREATE_BAN.CHANGE_DURATION"),
  },
  {
    id: "E-06",
    name: "CREATE_BAN.PRESS_NEXT",
    source: "UI",
    references: refs("E-06 CREATE_BAN.PRESS_NEXT"),
  },
  {
    id: "E-07",
    name: "CREATE_BAN.PRESS_BACK",
    source: "UI",
    references: refs("E-07 CREATE_BAN.PRESS_BACK"),
  },
  {
    id: "E-08",
    name: "CREATE_BAN.PRESS_FORBID",
    source: "UI",
    references: refs("E-08 CREATE_BAN.PRESS_FORBID"),
  },
  {
    id: "E-09",
    name: "CREATE_BAN.PRESS_FORBID_MORE",
    source: "UI",
    references: refs("E-09 CREATE_BAN.PRESS_FORBID_MORE"),
  },
  {
    id: "E-10",
    name: "CREATE_BAN.SEND_CONFIRMED",
    source: "SERVER",
    references: refs("E-10 CREATE_BAN.SEND_CONFIRMED"),
  },
  {
    id: "E-11",
    name: "CREATE_BAN.SEND_FAILED",
    source: "SERVER",
    references: refs("E-11 CREATE_BAN.SEND_FAILED"),
  },
  {
    id: "E-12",
    name: "CREATE_BAN.SHARE_CONFIRMED",
    source: "TELEGRAM",
    references: refs("E-12 CREATE_BAN.SHARE_CONFIRMED"),
  },
  {
    id: "E-13",
    name: "CREATE_BAN.SHARE_CANCELLED",
    source: "TELEGRAM",
    references: refs("E-13 CREATE_BAN.SHARE_CANCELLED"),
  },
  {
    id: "E-14",
    name: "NOTIFICATIONS.PRESS_REPLY_BAN",
    source: "UI",
    references: refs("E-14 NOTIFICATIONS.PRESS_REPLY_BAN"),
  },
  {
    id: "E-15",
    name: "NOTIFICATIONS.PRESS_OVERBOARD",
    source: "UI",
    references: refs("E-15 NOTIFICATIONS.PRESS_OVERBOARD"),
  },
  {
    id: "E-16",
    name: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
    source: "UI",
    references: refs("E-16 NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
  },
  {
    id: "E-17",
    name: "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
    source: "UI",
    references: refs("E-17 NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"),
  },
  {
    id: "E-18",
    name: "NOTIFICATIONS.PRESS_BAN_MORE",
    source: "UI",
    references: refs("E-18 NOTIFICATIONS.PRESS_BAN_MORE"),
  },
  {
    id: "E-19",
    name: "NOTIFICATIONS.PRESS_TO_BANS",
    source: "UI",
    references: refs("E-19 NOTIFICATIONS.PRESS_TO_BANS"),
  },
  {
    id: "E-20",
    name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
    source: "SERVER",
    references: refs("E-20 NOTIFICATIONS.OVERBOARD_CONFIRMED"),
  },
  {
    id: "E-21",
    name: "NOTIFICATIONS.ACTION_FAILED",
    source: "SERVER",
    references: refs("E-21 NOTIFICATIONS.ACTION_FAILED"),
  },
  {
    id: "E-22",
    name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
    source: "SERVER",
    references: refs("E-22 NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST"),
  },
  {
    id: "E-23",
    name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
    source: "SERVER",
    references: refs("E-23 NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND"),
  },
  {
    id: "E-24",
    name: "REPLY_BAN.CHANGE_BAN_TEXT",
    source: "UI",
    references: refs("E-24 REPLY_BAN.CHANGE_BAN_TEXT"),
  },
  {
    id: "E-25",
    name: "REPLY_BAN.CHANGE_DURATION",
    source: "UI",
    references: refs("E-25 REPLY_BAN.CHANGE_DURATION"),
  },
  {
    id: "E-26",
    name: "REPLY_BAN.PRESS_NEXT",
    source: "UI",
    references: refs("E-26 REPLY_BAN.PRESS_NEXT"),
  },
  {
    id: "E-27",
    name: "REPLY_BAN.PRESS_BACK",
    source: "UI",
    references: refs("E-27 REPLY_BAN.PRESS_BACK"),
  },
  {
    id: "E-28",
    name: "REPLY_BAN.PRESS_FORBID",
    source: "UI",
    references: refs("E-28 REPLY_BAN.PRESS_FORBID"),
  },
  {
    id: "E-29",
    name: "REPLY_BAN.PRESS_FORBID_MORE",
    source: "UI",
    references: refs("E-29 REPLY_BAN.PRESS_FORBID_MORE"),
  },
  {
    id: "E-30",
    name: "REPLY_BAN.SEND_CONFIRMED",
    source: "SERVER",
    references: refs("E-30 REPLY_BAN.SEND_CONFIRMED"),
  },
  {
    id: "E-31",
    name: "REPLY_BAN.SEND_FAILED",
    source: "SERVER",
    references: refs("E-31 REPLY_BAN.SEND_FAILED"),
  },
  {
    id: "E-32",
    name: "APP.FULL_CLOSE",
    source: "LIFECYCLE",
    references: refs("E-32 APP.FULL_CLOSE"),
  },
  {
    id: "E-33",
    name: "APP.NORMAL_OPEN",
    source: "LIFECYCLE",
    references: refs("E-33 APP.NORMAL_OPEN"),
  },
  {
    id: "E-34",
    name: "CONNECTION.LOST",
    source: "CONNECTIVITY",
    references: refs("E-34 CONNECTION.LOST"),
  },
  {
    id: "E-35",
    name: "CONNECTION.RESTORED",
    source: "CONNECTIVITY",
    references: refs("E-35 CONNECTION.RESTORED"),
  },
  {
    id: "E-41",
    name: "EXTERNAL_ENTRY.PENDING_EXPIRED",
    source: "TIME",
    references: refs("E-41 EXTERNAL_ENTRY.PENDING_EXPIRED"),
  },
  {
    id: "E-42",
    name: "BAN.DURATION_EXPIRED",
    source: "TIME",
    references: refs("E-42 BAN.DURATION_EXPIRED"),
  },
  {
    id: "E-43",
    name: "NOTIFICATIONS.SELECT_NEXT",
    source: "STATE_MACHINE",
    references: refs("E-43 NOTIFICATIONS.SELECT_NEXT"),
  },
  {
    id: "E-44",
    name: "TELEGRAM_SHARE_LINK.OPENED",
    source: "TELEGRAM",
    references: refs("E-44 TELEGRAM_SHARE_LINK.OPENED"),
  },
  {
    id: "E-45",
    name: "TELEGRAM_SHARE_LINK.RESOLVED",
    source: "SERVER",
    references: refs("E-45 TELEGRAM_SHARE_LINK.RESOLVED"),
  },
  {
    id: "E-46",
    name: "TELEGRAM_SHARE_LINK.REJECTED",
    source: "SERVER",
    references: refs("E-46 TELEGRAM_SHARE_LINK.REJECTED"),
  },
  {
    id: "E-47",
    name: "RIM.PRESS_START_CHAT",
    source: "UI",
    references: refs("E-47 RIM.PRESS_START_CHAT"),
  },
  {
    id: "E-48",
    name: "RIM.PRESS_SELECT_CONTACT",
    source: "UI",
    references: refs("E-48 RIM.PRESS_SELECT_CONTACT"),
  },
  {
    id: "E-49",
    name: "RIM.SELECT_CONTACT",
    source: "UI",
    references: refs("E-49 RIM.SELECT_CONTACT"),
  },
  { id: "E-50", name: "RIM.PRESS_BACK", source: "UI", references: refs("E-50 RIM.PRESS_BACK") },
  {
    id: "E-51",
    name: "RIM.CHANGE_INPUT_DRAFT",
    source: "UI",
    references: refs("E-51 RIM.CHANGE_INPUT_DRAFT"),
  },
  { id: "E-52", name: "RIM.PRESS_SEND", source: "UI", references: refs("E-52 RIM.PRESS_SEND") },
  {
    id: "E-53",
    name: "RIM.PRESS_RETRY_CONTEXT",
    source: "UI",
    references: refs("E-53 RIM.PRESS_RETRY_CONTEXT"),
  },
  {
    id: "E-54",
    name: "RIM.PRESS_RETRY_AI",
    source: "UI",
    references: refs("E-54 RIM.PRESS_RETRY_AI"),
  },
  {
    id: "E-55",
    name: "RIM.PRESS_SUGGESTION_FORBID",
    source: "UI",
    references: refs("E-55 RIM.PRESS_SUGGESTION_FORBID"),
  },
  {
    id: "E-56",
    name: "RIM.CONTEXT_READY",
    source: "SERVER",
    references: refs("E-56 RIM.CONTEXT_READY"),
  },
  {
    id: "E-57",
    name: "RIM.CONTEXT_FAILED",
    source: "SERVER",
    references: refs("E-57 RIM.CONTEXT_FAILED"),
  },
  {
    id: "E-58",
    name: "RIM.AI_RESULT_RECEIVED",
    source: "AI",
    references: refs("E-58 RIM.AI_RESULT_RECEIVED"),
  },
  {
    id: "E-59",
    name: "RIM.AI_REQUEST_FAILED",
    source: "AI",
    references: refs("E-59 RIM.AI_REQUEST_FAILED"),
  },
  {
    id: "E-60",
    name: "RIM.PRESS_NOTIFICATIONS",
    source: "UI",
    references: refs("E-60 RIM.PRESS_NOTIFICATIONS"),
  },
  {
    id: "E-61",
    name: "TELEGRAM_PERSISTENT_REENTRY.GRANTED",
    source: "TELEGRAM",
    references: refs("E-61 TELEGRAM_PERSISTENT_REENTRY.GRANTED"),
  },
  {
    id: "E-62",
    name: "TELEGRAM_PERSISTENT_REENTRY.DECLINED",
    source: "TELEGRAM",
    references: refs("E-62 TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
  },
  {
    id: "E-63",
    name: "NOTIFICATIONS.PRESS_ASK_RIM",
    source: "UI",
    references: refs("E-63 NOTIFICATIONS.PRESS_ASK_RIM"),
  },
  {
    id: "E-64",
    name: "RIM.INITIALIZATION_UNRECOVERABLE",
    source: "SERVER",
    references: refs("E-64 RIM.INITIALIZATION_UNRECOVERABLE"),
  },
] as const satisfies readonly CanonicalEventDefinition[];

export const CANONICAL_EVENT_COUNT = 59;

export function isCanonicalEventId(value: string): value is CanonicalEventId {
  return CANONICAL_EVENT_DEFINITIONS.some((definition) => definition.id === value);
}

export function isCanonicalEventName(value: string): value is CanonicalEventName {
  return CANONICAL_EVENT_DEFINITIONS.some((definition) => definition.name === value);
}

export function isAbsentEventId(value: string): value is AbsentEventId {
  return (ABSENT_EVENT_IDS as readonly string[]).includes(value);
}

export function assertCanonicalEventId(value: string): CanonicalEventId {
  if (isAbsentEventId(value)) {
    throw new Error(
      `${value} is intentionally absent from the Event Registry and must not be invented.`,
    );
  }
  if (!isCanonicalEventId(value)) {
    throw new Error(`${value} is not a canonical Product Event.`);
  }
  return value;
}
