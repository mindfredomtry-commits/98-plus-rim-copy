import type {
  AiRequestId,
  BanId,
  CheckPairId,
  ContextRequestId,
  DomainTimerId,
  DurationMinutes,
  NotificationItemId,
  Percentage,
  RimChatId,
  ShareAttemptId,
  UserId,
} from "./ids.ts";
import type {
  BanStatus,
  CheckAnswer,
  CheckDerivedStatus,
  Failure,
  Instant,
  Role,
  ShareToken,
} from "./primitives.ts";

/**
 * Canonical Ban acceptance is only PENDING | ACCEPTED.
 * Frozen MVP5 E-20 represents OVERBOARD as Ban.status, not Ban.acceptance:
 * the Ban remains not accepted, duration does not start, and no DomainTimer is created.
 * Ban.createdAt is not a kernel field; Stage 4 may store creation order as persistence metadata.
 */
export type BanAcceptance = "PENDING" | "ACCEPTED";

export type Ban = Readonly<{
  id: BanId;
  senderId: UserId;
  /** CONTACT: existing registered UserId. Template: null until future External Entry binding. */
  receiverId: UserId | null;
  banText: string;
  durationMinutes: DurationMinutes;
  acceptance: BanAcceptance;
  status: BanStatus | null;
}>;

export type DomainTimerState = "RUNNING" | "EXPIRED";

export type DomainTimer = Readonly<{
  id: DomainTimerId;
  banId: BanId;
  startedAt: Instant;
  durationMinutes: DurationMinutes;
  state: DomainTimerState;
  checkPairCreated: boolean;
}>;

export type CheckPair = Readonly<{
  id: CheckPairId;
  banId: BanId;
  receiverItemId: NotificationItemId;
  senderItemId: NotificationItemId;
  receiverAnswer: CheckAnswer | null;
  senderAnswer: CheckAnswer | null;
  resultingStatus: CheckDerivedStatus | null;
}>;

export type NotificationLifecycle =
  { status: "UNPROCESSED"; display: "WAITING" | "ACTIVE" } | { status: "PROCESSED" };

type NotificationBase = Readonly<{
  id: NotificationItemId;
  ownerId: UserId;
  banId: BanId;
  fifoSequence: number;
  lifecycle: NotificationLifecycle;
}>;

export type IncomingBanNotificationItem = NotificationBase &
  Readonly<{
    kind: "INCOMING_BAN";
  }>;

export type TimerNotificationItem = NotificationBase &
  Readonly<{
    kind: "TIMER";
    domainTimerId: DomainTimerId;
  }>;

export type CheckNotificationItem = NotificationBase &
  Readonly<{
    kind: "CHECK";
    role: Role;
    checkPairId: CheckPairId;
  }>;

export type StatusNotificationItem = NotificationBase &
  Readonly<{
    kind: "STATUS";
    role: Role;
    status: BanStatus;
  }>;

export type NotificationItem =
  | IncomingBanNotificationItem
  | TimerNotificationItem
  | CheckNotificationItem
  | StatusNotificationItem;

export type RelationshipBan = Readonly<{
  banText: string;
  senderId: UserId;
  receiverId: UserId;
  status: BanStatus | null;
}>;

export type RimSuggestion = Readonly<{
  banText: string;
  fulfillmentProbability: Percentage;
}>;

export type ThreeSuggestions = readonly [RimSuggestion, RimSuggestion, RimSuggestion];

export type RimAiResult =
  | { kind: "CONVERSATIONAL"; text: string }
  | { kind: "BAN_SUGGESTIONS"; suggestions: ThreeSuggestions };

export type RimMessage =
  | { kind: "USER"; text: string }
  | { kind: "RIM"; text: string }
  | { kind: "SUGGESTIONS"; suggestions: ThreeSuggestions };

export type RelationshipContextStatus = "loading" | "ready" | "error";

export type RelationshipContextData = Readonly<{
  recentBansChronological: readonly RelationshipBan[];
  statusCounts: Readonly<Record<BanStatus, number>> | null;
  bantasticPercentage: Percentage | null;
}>;

export type RelationshipContext = Readonly<{
  selectedContactId: UserId;
  status: RelationshipContextStatus;
  requestId: ContextRequestId;
  data: RelationshipContextData | null;
  failure: Failure | null;
}>;

export type AiOperation =
  | { status: "IDLE" }
  | { status: "PENDING"; requestId: AiRequestId }
  | { status: "FAILED"; requestId: AiRequestId; failure: Failure };

export type RimChat = Readonly<{
  id: RimChatId;
  selectedContactId: UserId | null;
  relationshipContext: RelationshipContext | null;
  messages: readonly RimMessage[];
  inputDraft: string;
  aiOperation: AiOperation;
}>;

export type CreateBanOrigin = "CONTACT" | "TEMPLATE" | "RIM";

export type BanDraft = Readonly<{
  origin: CreateBanOrigin;
  selectedContactId: UserId | null;
  banText: string;
  durationMinutes: DurationMinutes | null;
}>;

export type ReplyBanDraft = Readonly<{
  banText: string;
  durationMinutes: DurationMinutes | null;
}>;

export type ReplySource =
  | {
      kind: "INCOMING_BAN";
      itemId: NotificationItemId;
      banId: BanId;
    }
  | {
      kind: "STATUS";
      itemId: NotificationItemId;
      banId: BanId;
    };

/**
 * Kernel writes ACTIVE, CONFIRMED, and CANCELLED (E-12 / E-13 / E-32).
 * INVALIDATED remains on the contract because MVP5 describes cancelled/terminated Share
 * as unable to create a Ban; no accepted path currently emits INVALIDATED.
 * Stage 4 must not persist INVALIDATED unless a later accepted kernel path produces it.
 */
export type ShareOperationStatus = "ACTIVE" | "CONFIRMED" | "CANCELLED" | "INVALIDATED";

export type ShareOperation = Readonly<{
  attemptId: ShareAttemptId;
  draft: BanDraft;
  token: ShareToken;
  status: ShareOperationStatus;
  createdBanId: BanId | null;
}>;

export function isTimerNotificationItem(item: NotificationItem): item is TimerNotificationItem {
  return item.kind === "TIMER";
}

export function markTimerNotificationItemProcessed(
  item: TimerNotificationItem,
): TimerNotificationItem {
  return {
    ...item,
    lifecycle: { status: "PROCESSED" },
  };
}
