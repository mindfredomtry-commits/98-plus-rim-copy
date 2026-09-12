/**
 * Telegram Mini App initData freshness. Independent from the MVP5
 * pendingExternalEntry TTL (1 minute / E-41). Do not reuse or derive from that clock.
 */
export const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export const AUTH_DATE_FUTURE_SKEW_SECONDS = 60;
