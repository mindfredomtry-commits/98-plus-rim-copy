export const CREATE_BAN_CONTACT_STAGE = 6;

export const INCOMING_OVERBOARD_STAGE = 7;

export const REPLY_BAN_FROM_INCOMING_STAGE = 8;

export const TIMER_CHECK_STATUS_STAGE = 9;

export const REPLY_BAN_FROM_STATUS_STAGE = 10;

export const TEMPLATE_CREATE_BAN_STAGE = 11;

export const EXTERNAL_ENTRY_STAGE = 12;

export const CONTACT_RELATIONSHIP_STAGE = 13;

/** Stage 13A — Telegram Persistent Re-entry Runtime / CTA / bootstrap. */
export const TELEGRAM_PERSISTENT_REENTRY_STAGE = "13A";

export const STAGE_6_EXCLUDES = [
  "incoming-ban-processing-ui",
  "overboard-action",
  "reply-ban-from-incoming-ban",
  "timer-processing",
  "check",
  "status",
  "reply-ban-from-status",
  "template-create-ban",
  "telegram-share",
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_7_EXCLUDES = [
  "reply-ban-from-incoming-ban",
  "timer-processing",
  "check",
  "reply-ban-from-status",
  "template-create-ban",
  "telegram-share",
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_8_EXCLUDES = [
  "timer-processing",
  "check",
  "reply-ban-from-status",
  "template-create-ban",
  "telegram-share",
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_9_EXCLUDES = [
  "reply-ban-from-status",
  "template-create-ban",
  "telegram-share",
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_10_EXCLUDES = [
  "template-create-ban",
  "telegram-share",
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_11_EXCLUDES = [
  "external-entry",
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

export const STAGE_12_EXCLUDES = [
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;

/** Stage 13B implements MVP8 Contact set; later product work remains excluded. */
export const STAGE_13B_EXCLUDES = [
  "rim-ai",
  "relationship-context-execution",
  "openai",
  "full-notifications-ui",
  "select-contact-telegram-sync",
  "premium",
  "payments",
  "analytics",
  "deployment",
  "production-ui",
  "beautiful-ui",
  "ui-mode-toggle",
] as const;
