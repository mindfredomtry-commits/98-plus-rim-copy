import { IMPLEMENTATION_STAGE } from "@98plus/product-model";
import {
  APPLICATION_STAGE,
  executeProductEvent,
  randomIdAllocator,
  STAGE_5_EXCLUDES,
  systemClock,
} from "@98plus/application";
import {
  authenticate,
  callerUserId,
  IDENTITY_STAGE,
  loadIdentityConfig,
  STAGE_3_EXCLUDES,
} from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import type { AuthenticatedContext, AuthenticationAttempt, IdentityStore } from "@98plus/identity";
import type { ProductStore } from "@98plus/persistence";
import type { ExecuteProductEventInput, ProductExecutorDependencies } from "@98plus/application";

export const API_STAGE = APPLICATION_STAGE;
export const API_KERNEL_STAGE = IMPLEMENTATION_STAGE;
export const API_IDENTITY_STAGE = IDENTITY_STAGE;
export const API_PERSISTENCE_STAGE = PERSISTENCE_STAGE;
export const API_STAGE_3_EXCLUDES = STAGE_3_EXCLUDES;
export const API_STAGE_5_EXCLUDES = STAGE_5_EXCLUDES;

export {
  CONTACT_RELATIONSHIP_STAGE,
  CREATE_BAN_CONTACT_STAGE,
  EXTERNAL_ENTRY_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  REPLY_BAN_FROM_STATUS_STAGE,
  TEMPLATE_CREATE_BAN_STAGE,
  TELEGRAM_PERSISTENT_REENTRY_STAGE,
  STAGE_6_EXCLUDES,
  STAGE_7_EXCLUDES,
  STAGE_8_EXCLUDES,
  STAGE_9_EXCLUDES,
  STAGE_10_EXCLUDES,
  STAGE_11_EXCLUDES,
  STAGE_12_EXCLUDES,
  STAGE_13B_EXCLUDES,
  TIMER_CHECK_STATUS_STAGE,
} from "./stage.ts";
export {
  createCreateBanContactRuntime,
  seedRegisteredUsers,
  developmentIdentityConfig,
  type CreateBanContactRuntime,
} from "./runtime.ts";
export { listenCreateBanContactServer, createCreateBanContactHttp } from "./http.ts";
export { MemorySqlRegisteredUserDirectory, listSelectableRegisteredUsers } from "./directory.ts";
export { executeIncomingOverboardVertical, pendingOverboard } from "./overboard.ts";
export {
  parseShareStartParam,
  resolveTelegramShareExternalEntry,
  resolvePendingExternalEntryIfOnline,
  applyPendingExternalEntryExpiry,
} from "./external-entry.ts";
export {
  isTelegramShareReplyEntryEligible,
  orchestrateTelegramShareReplyEntry,
} from "./telegram-reply-entry.ts";
export { executeCreateBanContactVertical, pendingCreateBanSend } from "./contact-send.ts";
export { pendingReplyBanSend, shouldCompleteReplyBanSend } from "./reply-ban.ts";
export {
  activeTemplateShareOperation,
  shouldOpenTelegramShare,
  completeTelegramShare,
  buildTelegramShareInvocation,
} from "./template-share.ts";
export {
  prepareTelegramShareMessage,
  invokeTelegramShareMessage,
  telegramShareOutcomeToEventName,
  buildTemplateShareDeepLink,
  normalizeTelegramBotUsername,
} from "./telegram-share.ts";
export {
  beginTelegramPersistentReentryRequest,
  requestWriteAccessOutcomeToEventName,
  sendBootstrapBotMessage,
  deliverPendingTelegramPersistentReentryBootstrap,
  TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_TEXT,
} from "./telegram-persistent-reentry.ts";
export {
  pendingCheckAnswer,
  shouldCompleteCheckAnswer,
  completeCheckAnswer,
  resultingStatusOf,
} from "./check-answer.ts";
export { applyElapsedDomainTimers, expireElapsedDomainTimers } from "./duration-expired.ts";
export { assertSelectableContactId } from "./select-contact.ts";

export { authenticate, callerUserId, executeProductEvent, loadIdentityConfig };

export async function authenticateRequest(
  attempt: AuthenticationAttempt,
  store: IdentityStore,
): Promise<AuthenticatedContext> {
  return authenticate(attempt, loadIdentityConfig(), store);
}

export function productCallerUserId(context: AuthenticatedContext, clientClaimedUserId?: string) {
  return callerUserId(context, clientClaimedUserId);
}

export async function executeAuthenticatedProductEvent(
  context: AuthenticatedContext,
  event: ExecuteProductEventInput["event"],
  store: ProductStore,
  extras: Partial<ProductExecutorDependencies> & { clientClaimedUserId?: string } = {},
) {
  const { clientClaimedUserId, ...deps } = extras;
  return executeProductEvent(
    {
      context,
      event,
      ...(clientClaimedUserId === undefined ? {} : { clientClaimedUserId }),
    },
    {
      store,
      clock: deps.clock ?? systemClock,
      allocateId: deps.allocateId ?? randomIdAllocator(),
    },
  );
}

export async function handleAuthenticatedProductRequest(input: {
  attempt: AuthenticationAttempt;
  event: ExecuteProductEventInput["event"];
  identityStore: IdentityStore;
  productStore: ProductStore;
  clientClaimedUserId?: string;
  clock?: ProductExecutorDependencies["clock"];
  allocateId?: ProductExecutorDependencies["allocateId"];
}) {
  const context = await authenticateRequest(input.attempt, input.identityStore);
  return executeAuthenticatedProductEvent(context, input.event, input.productStore, {
    ...(input.clientClaimedUserId === undefined
      ? {}
      : { clientClaimedUserId: input.clientClaimedUserId }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.allocateId === undefined ? {} : { allocateId: input.allocateId }),
  });
}
