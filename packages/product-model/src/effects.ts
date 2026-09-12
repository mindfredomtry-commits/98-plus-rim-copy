import type {
  Ban,
  BanDraft,
  CheckPair,
  DomainTimer,
  NotificationItem,
  NotificationLifecycle,
  ReplyBanDraft,
  ReplySource,
  RimChat,
  ShareOperation,
} from "./entities.ts";
import type { PendingExternalEntry, PendingOperation } from "./extended-state.ts";
import type {
  AiRequestId,
  ContextRequestId,
  UserId,
  NotificationItemId,
  OperationId,
  ShareAttemptId,
} from "./ids.ts";
import type { ConnectionState } from "./primitives.ts";
import type { ProductControlState } from "./states.ts";

export type TimerNotificationItemProcessCause =
  "APP_FULL_CLOSE" | "PRESS_TO_BANS" | "TELEGRAM_SHARE_LINK_RESOLVED" | "REPLACED_BEFORE_NEW_TIMER";

export type Effect =
  | { type: "SET_CONTROL_STATE"; state: ProductControlState }
  | { type: "END_SESSION" }
  | { type: "SET_CONNECTION"; connection: ConnectionState }
  | { type: "UPSERT_BAN"; ban: Ban }
  | { type: "UPSERT_CHECK_PAIR"; pair: CheckPair }
  | { type: "UPSERT_NOTIFICATION_ITEM"; item: NotificationItem }
  | { type: "UPSERT_DOMAIN_TIMER"; timer: DomainTimer }
  | {
      type: "SET_NOTIFICATION_LIFECYCLE";
      itemId: NotificationItemId;
      lifecycle: NotificationLifecycle;
    }
  | {
      type: "PROCESS_TIMER_NOTIFICATION_ITEM";
      itemId: NotificationItemId;
      cause: TimerNotificationItemProcessCause;
    }
  | { type: "CLEAR_TIMER_PRIORITY"; itemId: NotificationItemId }
  | { type: "SET_TIMER_PRIORITY"; itemId: NotificationItemId }
  | { type: "SET_STATUS_PRIORITY"; itemId: NotificationItemId }
  | { type: "CLEAR_STATUS_PRIORITY"; itemId: NotificationItemId }
  | { type: "SET_CREATE_BAN_DRAFT"; draft: BanDraft | null }
  | { type: "SET_REPLY_BAN_DRAFT"; draft: ReplyBanDraft | null }
  | { type: "SET_REPLY_SOURCE"; source: ReplySource | null }
  | { type: "SET_RIM_CHAT"; chat: RimChat | null }
  | { type: "SET_FROZEN_RIM_CHAT"; chat: RimChat | null }
  | { type: "SET_ACTIVE_NOTIFICATION"; itemId: NotificationItemId | null }
  | { type: "SET_PENDING_EXTERNAL_ENTRY"; entry: PendingExternalEntry | null }
  | { type: "START_OPERATION"; operation: PendingOperation }
  | { type: "CLEAR_OPERATION"; operationId: OperationId }
  | { type: "MARK_OPERATION_RESULT_APPLIED"; operationId: OperationId }
  | { type: "MARK_OPERATION_SUPERSEDED_BY_EXTERNAL_ENTRY"; operationId: OperationId }
  | { type: "OPEN_TELEGRAM_SHARE"; attemptId: ShareAttemptId }
  | { type: "UPSERT_SHARE_OPERATION"; operation: ShareOperation }
  | {
      type: "REQUEST_RELATIONSHIP_CONTEXT";
      requestId: ContextRequestId;
      contactId: UserId;
    }
  | { type: "REQUEST_RIM_AI"; requestId: AiRequestId };

export type EffectType = Effect["type"];

export type DomainTimerMutatingEffectType = Extract<EffectType, "UPSERT_DOMAIN_TIMER">;
export type TimerNotificationItemProcessingEffectType = Extract<
  EffectType,
  "PROCESS_TIMER_NOTIFICATION_ITEM" | "CLEAR_TIMER_PRIORITY"
>;

export type ForbiddenDomainTimerCloseEffectType = never;
