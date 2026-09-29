import type { AuthenticatedContext } from "@98plus/identity";
import type { RelationshipContextSource } from "@98plus/persistence";
import type { Failure } from "@98plus/product-model";
import type { ApplicationExecutionResult, ProductExecutorDependencies } from "../execute.ts";
import { executeProductEvent } from "../execute.ts";
import type { ProductEventInput } from "../event.ts";
import { FakeRimAiFailure } from "./fake-rim-ai-adapter.ts";
import { buildRelationshipContextData } from "./relationship-context.ts";
import type { RimAiPort } from "./rim-ai-port.ts";

export type RimContextFailures = { remainingFailures: number };

const MAX_RIM_FOLLOW_UPS = 4;

function rimEffect(execution: ApplicationExecutionResult) {
  return (
    execution.pendingExternalEffects.find(
      (item) =>
        item.effect.type === "REQUEST_RELATIONSHIP_CONTEXT" ||
        item.effect.type === "REQUEST_RIM_AI",
    )?.effect ?? null
  );
}

/**
 * Completes frozen RIM external effects by dispatching E-56/E-57 or E-58/E-59.
 * The Kernel remains the only writer of Product state.
 */
export async function continueRimEffects(
  execution: ApplicationExecutionResult,
  tools: Readonly<{
    context: AuthenticatedContext;
    clientClaimedUserId?: string;
    deps: ProductExecutorDependencies;
    rimAi: RimAiPort;
    contextFailures: RimContextFailures;
    loadSources: (
      currentUserId: ApplicationExecutionResult["currentUserId"],
      contactId: ApplicationExecutionResult["currentUserId"],
    ) => Promise<readonly RelationshipContextSource[]>;
  }>,
): Promise<ApplicationExecutionResult> {
  let current = execution;
  for (let step = 0; step < MAX_RIM_FOLLOW_UPS; step += 1) {
    const effect = rimEffect(current);
    if (!effect || current.status !== "APPLIED") {
      return current;
    }
    const chat = current.snapshot.extended.rimChat;
    if (!chat) {
      return current;
    }
    const event = await followUpEvent(current, effect, chat.id, tools);
    const next = await executeProductEvent(
      {
        context: tools.context,
        event,
        ...(tools.clientClaimedUserId === undefined
          ? {}
          : { clientClaimedUserId: tools.clientClaimedUserId }),
      },
      tools.deps,
    );
    current = next;
  }
  return current;
}

async function followUpEvent(
  execution: ApplicationExecutionResult,
  effect: NonNullable<ReturnType<typeof rimEffect>>,
  rimChatId: NonNullable<ApplicationExecutionResult["snapshot"]["extended"]["rimChat"]>["id"],
  tools: Parameters<typeof continueRimEffects>[1],
): Promise<ProductEventInput> {
  const chat = execution.snapshot.extended.rimChat;
  if (effect.type === "REQUEST_RELATIONSHIP_CONTEXT") {
    if (tools.contextFailures.remainingFailures > 0) {
      tools.contextFailures.remainingFailures -= 1;
      return {
        name: "RIM.CONTEXT_FAILED",
        payload: {
          rimChatId,
          selectedContactId: effect.contactId,
          requestId: effect.requestId,
          failure: { code: "RELATIONSHIP_CONTEXT_FAILED" } as unknown as Failure,
        },
      };
    }
    try {
      const sources = await tools.loadSources(execution.currentUserId, effect.contactId);
      const relationshipContext = buildRelationshipContextData({
        currentUserId: execution.currentUserId,
        sources,
        nowMs: tools.deps.clock.nowMs(),
      });
      return {
        name: "RIM.CONTEXT_READY",
        payload: {
          rimChatId,
          selectedContactId: effect.contactId,
          requestId: effect.requestId,
          relationshipContext,
        },
      };
    } catch (error) {
      return {
        name: "RIM.CONTEXT_FAILED",
        payload: {
          rimChatId,
          selectedContactId: effect.contactId,
          requestId: effect.requestId,
          failure: {
            code: "RELATIONSHIP_CONTEXT_FAILED",
            message: error instanceof Error ? error.message : "relationship context failed",
          } as unknown as Failure,
        },
      };
    }
  }
  if (effect.type !== "REQUEST_RIM_AI") {
    throw new Error(`Unsupported RIM external effect: ${effect.type}`);
  }
  const snapshot = effect.snapshot;
  const data = chat?.relationshipContext?.status === "ready" ? chat.relationshipContext.data : null;
  try {
    const result = await tools.rimAi.respond({
      requestId: snapshot.requestId,
      rimChatId: snapshot.rimChatId,
      userMessage: snapshot.userMessage,
      contextRequestId: snapshot.contextRequestId,
      relationshipContext: data ?? {
        aggregates: {
          userToContact: {
            bansSentCount: 0,
            statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
          },
          contactToUser: {
            bansSentCount: 0,
            statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
          },
        },
        recentBans: [],
      },
      messages: chat?.messages ?? [],
    });
    return {
      name: "RIM.AI_RESULT_RECEIVED",
      payload: { rimChatId: snapshot.rimChatId, requestId: snapshot.requestId, result },
    };
  } catch (error) {
    const failure =
      error instanceof FakeRimAiFailure
        ? error.failure
        : ({
            code: "RIM_AI_FAILED",
            message: error instanceof Error ? error.message : "rim ai failed",
          } as unknown as Failure);
    return {
      name: "RIM.AI_REQUEST_FAILED",
      payload: { rimChatId: snapshot.rimChatId, requestId: snapshot.requestId, failure },
    };
  }
}
