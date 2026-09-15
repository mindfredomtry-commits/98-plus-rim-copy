import type {
  Ban,
  BanDraft,
  CheckPair,
  DomainTimer,
  NotificationItem,
  ReplyBanDraft,
  ReplySource,
  RimChat,
  ShareOperation,
} from "./entities.ts";
import type {
  BanId,
  DomainTimerId,
  DurationMinutes,
  NotificationItemId,
  OperationId,
  ShareLinkId,
  UserId,
} from "./ids.ts";
import type { ConnectionState, Instant, SessionStatus } from "./primitives.ts";
import type { ProductControlState } from "./states.ts";

export type EntityState = Readonly<{
  bans: Readonly<Record<string, Ban>>;
  notificationItems: Readonly<Record<string, NotificationItem>>;
  checkPairs: Readonly<Record<string, CheckPair>>;
  domainTimers: Readonly<Record<string, DomainTimer>>;
  shareOperations: Readonly<Record<string, ShareOperation>>;
}>;

export type PendingExternalEntry = Readonly<{
  shareLinkId: ShareLinkId;
  shareTargetBanId: BanId;
  currentTelegramUserId: UserId;
  entryTimestamp: Instant;
  firstLaunch: boolean;
}>;

export type PriorityState = Readonly<{
  statusItemId: NotificationItemId | null;
  timerItemId: NotificationItemId | null;
}>;

export type ExtendedState = Readonly<{
  rimChat: RimChat | null;
  savedFrozenRimChat: RimChat | null;
  createBanDraft: BanDraft | null;
  replyBanDraft: ReplyBanDraft | null;
  replySource: ReplySource | null;
  successfulBanId: BanId | null;
  activeNotificationItemId: NotificationItemId | null;
  priorities: PriorityState;
  pendingExternalEntry: PendingExternalEntry | null;
  /** User becomes eligible after qualifying E-20 / E-30 FROM_INCOMING_BAN on Share-bound Ban. */
  telegramPersistentReentryEligible: boolean;
  /** True after authoritative E-61; never re-offer CTA once established. */
  telegramPersistentReentryEstablished: boolean;
  /** Integration fact: active permission request id for Guard A; null when none. */
  telegramPersistentReentryActiveRequestId: string | null;
  entities: EntityState;
}>;

export type PendingOperationKind =
  "CREATE_BAN_SEND" | "REPLY_BAN_SEND" | "OVERBOARD" | "CHECK_ANSWER";

export type PendingSendDraft = Readonly<{
  banText: string;
  durationMinutes: DurationMinutes;
  selectedContactId: UserId | null;
  origin: BanDraft["origin"] | null;
}>;

export type PendingOperation = Readonly<{
  operationId: OperationId;
  kind: PendingOperationKind;
  originatingState: ProductControlState;
  originatingItemId: NotificationItemId | null;
  resultApplied: boolean;
  supersededByExternalEntry: boolean;
  sendDraft: PendingSendDraft | null;
}>;

export type BootstrapState = { status: "COMPLETE" } | { status: "FIRST_LAUNCH_EXTERNAL_ENTRY" };

export type RuntimeState = Readonly<{
  connection: ConnectionState;
  session: SessionStatus;
  bootstrap: BootstrapState;
  transitionInFlight: OperationId | null;
  pendingOperations: Readonly<Record<string, PendingOperation>>;
}>;

export type ProductSnapshot = Readonly<{
  controlState: ProductControlState | null;
  extended: ExtendedState;
  runtime: RuntimeState;
}>;

export function lookupDomainTimer(
  snapshot: ProductSnapshot,
  domainTimerId: DomainTimerId,
): DomainTimer | undefined {
  return snapshot.extended.entities.domainTimers[domainTimerId];
}
