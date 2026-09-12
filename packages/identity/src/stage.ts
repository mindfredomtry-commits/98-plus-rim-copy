export const IDENTITY_STAGE = 3;

export const STAGE_3_EXCLUDES = [
  "external-entry",
  "e-41-pending-expired",
  "e-44-share-link-opened",
  "e-45-share-link-resolved",
  "e-46-share-link-rejected",
  "pending-external-entry",
  "receiver-binding",
  "rim-chat",
  "create-ban-flow",
  "reply-ban-flow",
  "notifications-flow",
  "timer-flow",
  "check-flow",
  "status-flow",
  "ui-screens",
  "rim-ai",
] as const;
