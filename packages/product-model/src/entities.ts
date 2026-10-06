import type {
  AiRequestId,
  BanId,
  CheckPairId,
  ContextRequestId,
  DomainTimerId,
  DurationMinutes,
  ExecutionProbability,
  NotificationItemId,
  ProposalId,
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
  /** CONTACT: existing registered UserId. Template: null until authenticated recipient claim. */
  receiverId: UserId | null;
  banText: string;
  durationMinutes: DurationMinutes;
  acceptance: BanAcceptance;
  status: BanStatus | null;
  /** True only when receiver was bound via successful Telegram Share Link External Entry (E-45). */
  boundViaTelegramShareLink: boolean;
  /** RIM-origin provenance. Null for CONTACT and TEMPLATE Bans. */
  sourceProposalId: ProposalId | null;
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

/** AI-facing proposal content. Identity is assigned later on the Application proposal carrier. */
export type RimSuggestion = Readonly<{
  banText: string;
  executionProbability: ExecutionProbability;
}>;

export type ThreeSuggestions = readonly [RimSuggestion, RimSuggestion, RimSuggestion];

export type RimAiResult =
  | { kind: "MESSAGE"; text: string }
  | { kind: "BAN_PROPOSALS"; message: string; proposals: ThreeSuggestions };

/**
 * Canonical Application proposal. Minted only after a correlated BAN_PROPOSALS result.
 * The provider result itself does not carry proposalId.
 */
export type ApplicationProposal = Readonly<{
  proposalId: ProposalId;
  banText: string;
  executionProbability: ExecutionProbability;
}>;

export type ThreeApplicationProposals = readonly [
  ApplicationProposal,
  ApplicationProposal,
  ApplicationProposal,
];

export type RimMessage =
  | { kind: "USER"; text: string }
  | { kind: "RIM"; text: string }
  | { kind: "BAN_PROPOSALS"; message: string; proposals: ThreeApplicationProposals };

export function findChatProposal(
  chat: RimChat,
  proposalId: ProposalId,
): ApplicationProposal | null {
  for (const message of chat.messages) {
    if (message.kind !== "BAN_PROPOSALS") {
      continue;
    }
    const found = message.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (found) {
      return found;
    }
  }
  return null;
}

export type RelationshipContextStatus = "loading" | "ready" | "error";

export type RelationshipDirection = "USER_TO_CONTACT" | "CONTACT_TO_USER";

export type RelationshipStatusCounts = Readonly<{
  bantastic: number;
  banflict: number;
  fairEnough: number;
  overboard: number;
}>;

export type RelationshipDirectionAggregate = Readonly<{
  bansSentCount: number;
  statusCounts: RelationshipStatusCounts;
}>;

export type RelationshipBanLifecycleResult =
  | { readonly kind: "AWAITING_RESPONSE" }
  | { readonly kind: "ACTIVE" }
  | {
      readonly kind: "CHECK_PENDING";
      readonly userAnswer: CheckAnswer | null;
      readonly contactAnswer: CheckAnswer | null;
    }
  | {
      readonly kind: "CHECK_COMPLETED";
      readonly userAnswer: CheckAnswer | null;
      readonly contactAnswer: CheckAnswer | null;
      readonly status: CheckDerivedStatus;
    }
  | { readonly kind: "OVERBOARD" };

export type RelationshipRecentBan = Readonly<{
  direction: RelationshipDirection;
  banText: string;
  ageHours: number;
  result: RelationshipBanLifecycleResult;
}>;

export type RelationshipContextData = Readonly<{
  aggregates: Readonly<{
    userToContact: RelationshipDirectionAggregate;
    contactToUser: RelationshipDirectionAggregate;
  }>;
  /** At most RELATIONSHIP_BAN_LIMIT entries. Pass 1 stores a ready payload and does not build it. */
  recentBans: readonly RelationshipRecentBan[];
}>;

export type AskRimOrigin = Readonly<{
  sourceStatusItemId: NotificationItemId;
  banId: BanId;
  status: BanStatus;
  sourceRole: Role;
}>;

export type RelationshipContext = Readonly<{
  selectedContactId: UserId;
  status: RelationshipContextStatus;
  requestId: ContextRequestId;
  data: RelationshipContextData | null;
  failure: Failure | null;
}>;

/** Immutable logical AI request. Provider attempts are outside this carrier. */
export type RimRequestSnapshot = Readonly<{
  requestId: AiRequestId;
  rimChatId: RimChatId;
  userMessage: string;
  contextRequestId: ContextRequestId;
}>;

export type AiOperation =
  | { status: "IDLE" }
  | { status: "PENDING"; requestId: AiRequestId; snapshot: RimRequestSnapshot }
  | { status: "FAILED"; requestId: AiRequestId; snapshot: RimRequestSnapshot; failure: Failure };

export type RimChat = Readonly<{
  id: RimChatId;
  /** A domain RimChat is one USER↔RIM session about one CONTACT, from birth. */
  selectedContactId: UserId;
  relationshipContext: RelationshipContext | null;
  messages: readonly RimMessage[];
  inputDraft: string;
  aiOperation: AiOperation;
  askRimOrigin: AskRimOrigin | null;
}>;

export type CreateBanOrigin = "CONTACT" | "TEMPLATE" | "RIM";

export type BanDraft = Readonly<{
  origin: CreateBanOrigin;
  selectedContactId: UserId | null;
  banText: string;
  durationMinutes: DurationMinutes | null;
  /** RIM-origin attribution. Null until a later pass assigns an Application proposalId. */
  proposalId: ProposalId | null;
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
 * ACTIVE means the token exists and the existing Ban is still unclaimed.
 * CONFIRMED means an authenticated recipient bound that existing Ban.
 * CANCELLED is only the legacy unresolved share whose createdBanId is null.
 * INVALIDATED remains unused. No accepted path emits it.
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
