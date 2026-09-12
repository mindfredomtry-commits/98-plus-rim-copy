import {
  executeProductEvent,
  randomIdAllocator,
  systemClock,
  type ApplicationClock,
  type IdAllocator,
  type ProductEventInput,
  type ProductExecutorDependencies,
} from "@98plus/application";
import {
  authenticate,
  loadIdentityConfig,
  PostgresIdentityStore,
  type AuthenticatedContext,
  type AuthenticationAttempt,
  type IdentityConfig,
  type IdentityStore,
} from "@98plus/identity";
import {
  MemorySqlClient,
  PostgresProductStore,
  type LoadedSnapshot,
  type ProductStore,
} from "@98plus/persistence";
import type { UserId } from "@98plus/product-model";
import { MemorySqlRegisteredUserDirectory, type RegisteredUserDirectory } from "./directory.ts";
import { toTestUiDiagnostics, type TestUiDiagnostics } from "./diagnostics.ts";

export const DEFAULT_DEV_AUTH_SECRET = "test-secret";
export const DEFAULT_TEST_TELEGRAM_USERS = ["1001", "1002"] as const;

export type ContactSendCompletion = "success" | "failure";
export type OverboardCompletion = "success" | "failure" | "fail-once";
export type ReplyBanCompletion = "success" | "failure" | "fail-once";
export type CheckAnswerCompletion = "success" | "failure" | "fail-once";
export type TelegramSharePrepareMode = "live" | "mock";

export type CreateBanContactRuntime = Readonly<{
  sql: MemorySqlClient;
  identityStore: IdentityStore;
  productStore: ProductStore;
  directory: RegisteredUserDirectory;
  config: IdentityConfig;
  clock: ApplicationClock;
  allocateId: IdAllocator;
  contactSendCompletion: ContactSendCompletion;
  overboardCompletion: OverboardCompletion;
  replyBanCompletion: ReplyBanCompletion;
  checkAnswerCompletion: CheckAnswerCompletion;
  telegramSharePrepare: TelegramSharePrepareMode;
}>;

export type CreateBanContactRuntimeOptions = Readonly<{
  sql?: MemorySqlClient;
  identityStore?: IdentityStore;
  productStore?: ProductStore;
  directory?: RegisteredUserDirectory;
  config?: IdentityConfig;
  env?: NodeJS.ProcessEnv;
  clock?: ApplicationClock;
  allocateId?: IdAllocator;
  seedTelegramUserIds?: readonly string[];
  contactSendCompletion?: ContactSendCompletion;
  overboardCompletion?: OverboardCompletion;
  replyBanCompletion?: ReplyBanCompletion;
  checkAnswerCompletion?: CheckAnswerCompletion;
  telegramSharePrepare?: TelegramSharePrepareMode;
}>;

export function developmentIdentityConfig(
  secret: string = DEFAULT_DEV_AUTH_SECRET,
): IdentityConfig {
  return loadIdentityConfig({
    NODE_ENV: "development",
    APP_ENV: "development",
    IDENTITY_ALLOW_DEV_AUTH: "true",
    IDENTITY_DEV_AUTH_SECRET: secret,
  });
}

export function createCreateBanContactRuntime(
  options: CreateBanContactRuntimeOptions = {},
): CreateBanContactRuntime {
  const sql = options.sql ?? new MemorySqlClient();
  const identityStore = options.identityStore ?? new PostgresIdentityStore(sql);
  const productStore = options.productStore ?? new PostgresProductStore(sql);
  const directory = options.directory ?? new MemorySqlRegisteredUserDirectory(sql);
  const config =
    options.config ?? (options.env ? loadIdentityConfig(options.env) : developmentIdentityConfig());
  return {
    sql,
    identityStore,
    productStore,
    directory,
    config,
    clock: options.clock ?? systemClock,
    allocateId: options.allocateId ?? randomIdAllocator(),
    contactSendCompletion: options.contactSendCompletion ?? "success",
    overboardCompletion: options.overboardCompletion ?? "success",
    replyBanCompletion: options.replyBanCompletion ?? "success",
    checkAnswerCompletion: options.checkAnswerCompletion ?? "success",
    telegramSharePrepare: options.telegramSharePrepare ?? "live",
  };
}

export async function seedRegisteredUsers(
  runtime: CreateBanContactRuntime,
  telegramUserIds: readonly string[] = DEFAULT_TEST_TELEGRAM_USERS,
): Promise<void> {
  for (const telegramUserId of telegramUserIds) {
    await authenticate(
      {
        method: "development",
        secret: runtime.config.developmentAuthSecret ?? DEFAULT_DEV_AUTH_SECRET,
        telegramUserId,
      },
      runtime.config,
      runtime.identityStore,
    );
  }
}

export async function authenticateRuntime(
  runtime: CreateBanContactRuntime,
  attempt: AuthenticationAttempt,
): Promise<AuthenticatedContext> {
  return authenticate(attempt, runtime.config, runtime.identityStore);
}

export function executorDeps(runtime: CreateBanContactRuntime): ProductExecutorDependencies {
  return {
    store: runtime.productStore,
    clock: runtime.clock,
    allocateId: runtime.allocateId,
  };
}

export async function executeAuthenticatedEvent(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  event: ProductEventInput,
  clientClaimedUserId?: string,
) {
  return executeProductEvent(
    {
      context,
      event,
      ...(clientClaimedUserId === undefined ? {} : { clientClaimedUserId }),
    },
    executorDeps(runtime),
  );
}

export async function loadDiagnostics(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
  execution?: Awaited<ReturnType<typeof executeAuthenticatedEvent>> | null,
  previousExecution?: Awaited<ReturnType<typeof executeAuthenticatedEvent>> | null,
  telegramShare?: TestUiDiagnostics["telegramShare"],
  externalEntry?: TestUiDiagnostics["externalEntry"],
  startParamIntake?: TestUiDiagnostics["startParamIntake"],
): Promise<{ loaded: LoadedSnapshot; diagnostics: TestUiDiagnostics }> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  const contacts = await runtime.directory.listSelectableContacts(context.currentUserId);
  return {
    loaded,
    diagnostics: toTestUiDiagnostics({
      currentUserId: context.currentUserId,
      snapshot: loaded.snapshot,
      revision: loaded.revision,
      contacts,
      ...(execution === undefined || execution === null ? {} : { execution }),
      ...(previousExecution === undefined || previousExecution === null
        ? {}
        : { previousExecution }),
      ...(telegramShare === undefined ? {} : { telegramShare }),
      ...(externalEntry === undefined ? {} : { externalEntry }),
      ...(startParamIntake === undefined ? {} : { startParamIntake }),
    }),
  };
}

export async function openLobbyIfNeeded(
  runtime: CreateBanContactRuntime,
  context: AuthenticatedContext,
) {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  if (loaded.snapshot.controlState !== null) {
    return loadDiagnostics(runtime, context);
  }
  if (loaded.snapshot.runtime.bootstrap.status === "FIRST_LAUNCH_EXTERNAL_ENTRY") {
    return loadDiagnostics(runtime, context);
  }
  const execution = await executeAuthenticatedEvent(runtime, context, {
    name: "APP.NORMAL_OPEN",
    payload: { serverState: {} },
  });
  return loadDiagnostics(runtime, context, execution);
}

export function userIdOf(runtime: CreateBanContactRuntime, telegramUserId: string): UserId | null {
  const found = runtime.sql.tables.findIdentityByTelegramUserId(telegramUserId);
  return found?.userId ?? null;
}
