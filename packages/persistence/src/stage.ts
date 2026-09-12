export const PERSISTENCE_STAGE = 4;

export const STAGE_4_EXCLUDES = [
  "external-entry",
  "e-41-pending-expired",
  "e-44-share-link-opened",
  "e-45-share-link-resolved",
  "e-46-share-link-rejected",
  "receiver-binding",
  "telegram-adapters",
  "rim-ai",
  "openai",
  "ui-screens",
  "create-ban-flow",
  "notifications-flow",
  "reply-ban-flow",
  "timer-flow",
  "check-flow",
  "status-flow",
  "share-flow",
  "product-http-endpoints",
  "worker-execution",
] as const;
