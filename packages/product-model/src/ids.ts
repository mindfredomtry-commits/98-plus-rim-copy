declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** Internal 98+ identity. Selectable contacts are other registered users; not a separate identity namespace. */
export type UserId = Brand<string, "UserId">;
export type BanId = Brand<string, "BanId">;
export type NotificationItemId = Brand<string, "NotificationItemId">;
export type CheckPairId = Brand<string, "CheckPairId">;
export type DomainTimerId = Brand<string, "DomainTimerId">;
export type OperationId = Brand<string, "OperationId">;
export type ShareAttemptId = Brand<string, "ShareAttemptId">;
export type ShareLinkId = Brand<string, "ShareLinkId">;
export type RimChatId = Brand<string, "RimChatId">;
export type ContextRequestId = Brand<string, "ContextRequestId">;
export type AiRequestId = Brand<string, "AiRequestId">;
export type DurationMinutes = Brand<number, "IntegerMinutes3To60">;
export type Percentage = Brand<number, "Percentage0To100">;
