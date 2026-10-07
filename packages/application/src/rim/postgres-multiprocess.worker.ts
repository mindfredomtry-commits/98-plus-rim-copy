import { openPostgresPersistence, PostgresProductStore } from "@98plus/persistence";
import type { RimAiResult, UserId } from "@98plus/product-model";
import { randomIdAllocator } from "../clock.ts";
import { authContext } from "../test-harness.ts";
import { reconcileRimInitialization } from "./initialize-rim-conversation.ts";
import type { RimInitializationObservation } from "./initialize-rim-conversation.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import type { RimAiPort } from "./rim-ai-port.ts";
import { parseRimProviderRuntime } from "./rim-provider-runtime.ts";
import type { ProviderConversationId } from "./rim-provider-runtime.ts";

export type WorkerAction = "init-hold" | "init-recover" | "user-hold" | "user-recover";

export type WorkerJob = Readonly<{
  databaseUrl: string;
  schema: string;
  action: WorkerAction;
  userId: string;
  telegram: string;
  text: string;
}>;

export type WorkerResult = Readonly<{
  eventName: string | null;
  status: string | null;
  continuity: string | null;
  initialization: string | null;
  attemptId: string | null;
  retiredAttemptId: string | null;
  responds: number;
  initializes: number;
  log: readonly string[];
  controlState: string | null;
  rimTexts: readonly string[];
}>;

type ParentMessage = { cmd: "run"; job: WorkerJob } | { cmd: "release" };

function assertSchemaName(schema: string): void {
  if (!/^mvp17_[0-9a-f]+$/.test(schema)) {
    throw new Error("refusing to interpolate an unexpected schema name");
  }
}

let releaseHold: () => void = () => undefined;
const released = new Promise<void>((resolve) => {
  releaseHold = resolve;
});

async function hold(): Promise<void> {
  process.send?.({ phase: "provider" });
  await released;
}

async function run(job: WorkerJob): Promise<WorkerResult> {
  assertSchemaName(job.schema);
  const db = openPostgresPersistence({
    connectionString: job.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${job.schema} -c application_name=mvp17_pass6_worker`,
  });
  const responds: string[] = [];
  const initializes: string[] = [];
  const log: RimInitializationObservation[] = [];
  try {
    const store = new PostgresProductStore(db.sql);
    const deps = {
      store,
      clock: { nowMs: () => 2_000_000 },
      allocateId: randomIdAllocator(),
    };
    const context = authContext(job.userId as UserId, job.telegram);
    const rimAi: RimAiPort = {
      async respond(request): Promise<RimAiResult> {
        responds.push(request.continuityMode);
        if (job.action === "user-hold") {
          await hold();
        }
        return { kind: "MESSAGE", text: job.text };
      },
    };
    const conversation = {
      async initialize(): Promise<{ conversationId: ProviderConversationId }> {
        initializes.push("initialize");
        if (job.action === "init-hold") {
          await hold();
        }
        return { conversationId: "conv-child" as ProviderConversationId };
      },
    };
    const execution =
      job.action === "init-hold" || job.action === "init-recover"
        ? await reconcileRimInitialization({
            context,
            deps,
            rimAi,
            conversation,
            initializationLog: log,
          })
        : await recoverPendingRimAi({
            context,
            deps,
            rimAi,
            conversation,
            initializationLog: log,
            retrieval: null,
          });
    const loaded = await store.loadProductSnapshot(job.userId as UserId);
    const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
    const runtime = parsed.status === "PRESENT" ? parsed.runtime : null;
    const texts = (loaded.snapshot.extended.rimChat?.messages ?? []).flatMap((message) =>
      message.kind === "RIM" ? [message.text] : [],
    );
    return {
      eventName: execution?.event.name ?? null,
      status: execution?.status ?? null,
      continuity: runtime?.continuityMode ?? null,
      initialization: runtime?.initialization.submissionState ?? null,
      attemptId: runtime?.attempt?.attemptId ?? null,
      retiredAttemptId: runtime?.retiredAttemptId ?? null,
      responds: responds.length,
      initializes: initializes.length,
      log,
      controlState: loaded.snapshot.controlState,
      rimTexts: texts,
    };
  } finally {
    await db.close();
  }
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (typeof value !== "object" || value === null || !("cmd" in value)) {
    return false;
  }
  return value.cmd === "run" || value.cmd === "release";
}

if (process.env.MVP17_MULTIPROCESS_WORKER === "1") {
  process.on("message", (value: unknown) => {
    if (!isParentMessage(value)) {
      return;
    }
    if (value.cmd === "release") {
      releaseHold();
      return;
    }
    void run(value.job).then(
      (result) => {
        process.send?.({ phase: "result", result });
        process.exit(0);
      },
      (error: unknown) => {
        process.send?.({
          phase: "error",
          message: error instanceof Error ? (error.stack ?? error.message) : "worker failed",
        });
        process.exit(1);
      },
    );
  });
}
