export const APPLICATION_STAGE = 5;

export const STAGE_5_EXCLUDES = [
  "openai",
  "telegram-adapters",
  "external-entry",
  "e-41-pending-expired",
  "e-44-share-link-opened",
  "e-45-share-link-resolved",
  "e-46-share-link-rejected",
  "receiver-binding",
  "ui-screens",
  "workers",
  "deployment",
  "analytics",
  "premium",
  "payments",
  "select-contact-discovery",
  "telegram-contact-synchronization",
  "new-product-events",
  "new-product-control-states",
] as const;
