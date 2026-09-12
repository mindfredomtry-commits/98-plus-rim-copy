export const IMPLEMENTATION_STAGE = 2;

export const STAGE_1_EXCLUDES = [
  "transition-resolver-behavior",
  "database-persistence",
  "telegram-adapters",
  "rim-ai",
  "ui-screens",
  "create-ban-flow",
  "notifications-flow",
  "reply-ban-flow",
  "timer-flow",
  "check-flow",
  "status-flow",
  "share-flow",
] as const;

export const STAGE_2_EXCLUDES = [
  "database-persistence",
  "telegram-adapters",
  "rim-ai",
  "ui-screens",
  "create-ban-flow",
  "notifications-flow",
  "reply-ban-flow",
  "timer-flow",
  "check-flow",
  "status-flow",
  "share-flow",
] as const;
