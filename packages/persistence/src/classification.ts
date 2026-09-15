export type SnapshotFieldClass =
  | "DURABLE_PRODUCT_FACT"
  | "DURABLE_USER_SESSION_STATE"
  | "TRANSIENT_EXECUTION_STATE"
  | "EXTERNAL_DERIVED_DATA";

export const SNAPSHOT_FIELD_CLASSIFICATION = {
  controlState: "DURABLE_USER_SESSION_STATE",
  "extended.entities.bans": "DURABLE_PRODUCT_FACT",
  "extended.entities.bans.createdSeq": "DURABLE_PRODUCT_FACT",
  "extended.entities.notificationItems": "DURABLE_PRODUCT_FACT",
  "extended.entities.domainTimers": "DURABLE_PRODUCT_FACT",
  "extended.entities.checkPairs": "DURABLE_PRODUCT_FACT",
  "extended.entities.shareOperations": "DURABLE_PRODUCT_FACT",
  "extended.entities.shareOperations.ownerId": "DURABLE_PRODUCT_FACT",
  "runtime.pendingOperations": "DURABLE_PRODUCT_FACT",
  "runtime.pendingOperations.ownerId": "DURABLE_PRODUCT_FACT",
  "extended.pendingExternalEntry": "DURABLE_PRODUCT_FACT",
  "extended.telegramPersistentReentryEligible": "DURABLE_USER_SESSION_STATE",
  "extended.telegramPersistentReentryEstablished": "DURABLE_USER_SESSION_STATE",
  "extended.telegramPersistentReentryActiveRequestId": "DURABLE_USER_SESSION_STATE",
  "extended.entities.bans.boundViaTelegramShareLink": "DURABLE_PRODUCT_FACT",
  "extended.rimChat": "DURABLE_USER_SESSION_STATE",
  "extended.savedFrozenRimChat": "DURABLE_USER_SESSION_STATE",
  "extended.createBanDraft": "DURABLE_USER_SESSION_STATE",
  "extended.replyBanDraft": "DURABLE_USER_SESSION_STATE",
  "extended.replySource": "DURABLE_USER_SESSION_STATE",
  "extended.successfulBanId": "DURABLE_USER_SESSION_STATE",
  "extended.activeNotificationItemId": "DURABLE_USER_SESSION_STATE",
  "extended.priorities": "DURABLE_USER_SESSION_STATE",
  "runtime.connection": "DURABLE_USER_SESSION_STATE",
  "runtime.session": "DURABLE_USER_SESSION_STATE",
  "runtime.bootstrap": "DURABLE_USER_SESSION_STATE",
  "runtime.transitionInFlight": "TRANSIENT_EXECUTION_STATE",
  "relationshipContext.data.recentBansChronological": "EXTERNAL_DERIVED_DATA",
  REQUEST_RELATIONSHIP_CONTEXT: "TRANSIENT_EXECUTION_STATE",
  REQUEST_RIM_AI: "TRANSIENT_EXECUTION_STATE",
} as const satisfies Record<string, SnapshotFieldClass>;
