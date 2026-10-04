import {
  executeProductEvent,
  FakeRimAiAdapter,
  randomIdAllocator,
  systemClock,
  type ApplicationClock,
  type IdAllocator,
  type ProductEventInput,
  type ProductExecutorDependencies,
  recoverPendingRimAi,
  type RimAiPort,
  type RimContextFailures,
  type RimConversationInitializationPort,
  type RimProviderRetrievalPort,
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
import {
  selectRimProvider,
  type OpenAiSdkClient,
  type RimProviderSelection,
} from "./openai/compose-rim-provider.ts";
import type { TelegramPersistentReentryBootstrapIntent } from "./telegram-persistent-reentry.ts";

export const DEFAULT_DEV_AUTH_SECRET = "test-secret";
export const DEFAULT_TEST_TELEGRAM_USERS = ["1001", "1002"] as const;

export type ContactSendCompletion = "success" | "failure";
export type OverboardCompletion = "success" | "failure" | "fail-once";
export type ReplyBanCompletion = "success" | "failure" | "fail-once";
export type CheckAnswerCompletion = "success" | "failure" | "fail-once";
export type TelegramSharePrepareMode = "live" | "mock";
export type TelegramPersistentReentryBootstrapSend = "success" | "failure" | "fail-once";

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
  /**
   * Bootstrap delivery mode. Defaults to telegramSharePrepare.
   * Explicit "live" never treats missing TELEGRAM_BOT_TOKEN as mock success.
   */
  telegramPersistentReentryBootstrapMode: TelegramSharePrepareMode;
  /** Injected bootstrap send outcome for Stage 13A corrective tests. */
  telegramPersistentReentryBootstrapSend: TelegramPersistentReentryBootstrapSend;
  /**
   * Optional test gate invoked after a durable claim is acquired and before send.
   * Used to prove concurrent callers observe ALREADY_CLAIMED without double-send.
   */
  telegramPersistentReentryBootstrapAfterClaim: (() => Promise<void>) | null;
  /** Mock/live bootstrap send intents for Stage 13A tests and diagnostics. */
  telegramPersistentReentryBootstrapIntents: TelegramPersistentReentryBootstrapIntent[];
  /** Selected provider. Explicit test ports keep the Fake label and do not read env. */
  rimProvider: "fake" | "openai";
  /** Configured generation model. Null in Fake mode. */
  rimModel: string | null;
  rimAi: RimAiPort;
  /**
   * Conversation initialization. Null in Fake mode so the Fake adapter's
   * initialize remains the conversationPortFrom fallback.
   */
  rimConversationInitialization: RimConversationInitializationPort | null;
  /** Known-response retrieval. Null in Fake mode. */
  rimProviderRetrieval: RimProviderRetrievalPort | null;
  rimContextFailures: RimContextFailures;
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
  telegramPersistentReentryBootstrapMode?: TelegramSharePrepareMode;
  telegramPersistentReentryBootstrapSend?: TelegramPersistentReentryBootstrapSend;
  telegramPersistentReentryBootstrapAfterClaim?: () => Promise<void>;
  rimAi?: RimAiPort;
  rimConversationInitialization?: RimConversationInitializationPort | null;
  rimProviderRetrieval?: RimProviderRetrievalPort | null;
  rimContextFailures?: RimContextFailures;
  /**
   * Test seam for OpenAI mode. Production uses createOpenAiClient.
   * Invoked only when RIM_PROVIDER=openai and no explicit port is injected.
   */
  createOpenAiClient?: (apiKey: string) => OpenAiSdkClient;
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

function explicitRimPorts(options: CreateBanContactRuntimeOptions): boolean {
  return (
    options.rimAi !== undefined ||
    options.rimConversationInitialization !== undefined ||
    options.rimProviderRetrieval !== undefined
  );
}

function resolveRimProvider(options: CreateBanContactRuntimeOptions): RimProviderSelection {
  if (explicitRimPorts(options)) {
    return {
      provider: "fake",
      model: null,
      rimAi: options.rimAi ?? new FakeRimAiAdapter(),
      rimConversationInitialization: options.rimConversationInitialization ?? null,
      rimProviderRetrieval: options.rimProviderRetrieval ?? null,
    };
  }
  return selectRimProvider({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.createOpenAiClient === undefined
      ? {}
      : { createClient: options.createOpenAiClient }),
  });
}

export function rimProviderTools(runtime: CreateBanContactRuntime): {
  rimAi: RimAiPort;
  retrieval: RimProviderRetrievalPort | null;
  conversation?: RimConversationInitializationPort;
} {
  return {
    rimAi: runtime.rimAi,
    retrieval: runtime.rimProviderRetrieval,
    ...(runtime.rimConversationInitialization
      ? { conversation: runtime.rimConversationInitialization }
      : {}),
  };
}

export function createCreateBanContactRuntime(
  options: CreateBanContactRuntimeOptions = {},
): CreateBanContactRuntime {
  const provider = resolveRimProvider(options);
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
    telegramPersistentReentryBootstrapMode:
      options.telegramPersistentReentryBootstrapMode ?? options.telegramSharePrepare ?? "live",
    telegramPersistentReentryBootstrapSend:
      options.telegramPersistentReentryBootstrapSend ?? "success",
    telegramPersistentReentryBootstrapAfterClaim:
      options.telegramPersistentReentryBootstrapAfterClaim ?? null,
    telegramPersistentReentryBootstrapIntents: [],
    rimProvider: provider.provider,
    rimModel: provider.model,
    rimAi: provider.rimAi,
    rimConversationInitialization: provider.rimConversationInitialization,
    rimProviderRetrieval: provider.rimProviderRetrieval,
    rimContextFailures: options.rimContextFailures ?? { remainingFailures: 0 },
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
      telegramPersistentReentryBootstrapSent: loaded.telegramPersistentReentryBootstrapSent,
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
): Promise<{
  loaded: LoadedSnapshot;
  diagnostics: TestUiDiagnostics;
  execution: Awaited<ReturnType<typeof executeAuthenticatedEvent>> | null;
}> {
  const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
  if (loaded.snapshot.controlState !== null) {
    const recovered = await recoverPendingRimAi({
      context,
      deps: executorDeps(runtime),
      ...rimProviderTools(runtime),
    });
    return {
      ...(await loadDiagnostics(runtime, context, recovered)),
      execution: recovered,
    };
  }
  if (loaded.snapshot.runtime.bootstrap.status === "FIRST_LAUNCH_EXTERNAL_ENTRY") {
    return { ...(await loadDiagnostics(runtime, context)), execution: null };
  }
  const execution = await executeAuthenticatedEvent(runtime, context, {
    name: "APP.NORMAL_OPEN",
    payload: { serverState: {} },
  });
  return { ...(await loadDiagnostics(runtime, context, execution)), execution };
}

export function userIdOf(runtime: CreateBanContactRuntime, telegramUserId: string): UserId | null {
  const found = runtime.sql.tables.findIdentityByTelegramUserId(telegramUserId);
  return found?.userId ?? null;
}
