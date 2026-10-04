import type { AuthenticatedContext } from "@98plus/identity";
import type { RelationshipContextSource } from "@98plus/persistence";
import type { Failure } from "@98plus/product-model";
import type { ApplicationExecutionResult, ProductExecutorDependencies } from "../execute.ts";
import { executeProductEvent } from "../execute.ts";
import type { ProductEventInput } from "../event.ts";
import {
  reconcileRimInitialization,
  type RimInitializationObservation,
} from "./initialize-rim-conversation.ts";
import { buildRelationshipContextData } from "./relationship-context.ts";
import { continuePendingRimAi } from "./recover-pending-rim-ai.ts";
import type { RimAiPort } from "./rim-ai-port.ts";
import type { RimConversationInitializationPort } from "./rim-conversation-port.ts";
import type { RimProviderRetrievalPort } from "./rim-provider-retrieval.ts";

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
 * Provider completion is structurally validated before E-58. Invalid output uses
 * the existing E-59 failure path and does not mint proposalId values.
 * The Kernel remains the correlation authority and the only writer of Product state.
 */
export async function continueRimEffects(
  execution: ApplicationExecutionResult,
  tools: Readonly<{
    context: AuthenticatedContext;
    clientClaimedUserId?: string;
    deps: ProductExecutorDependencies;
    rimAi: RimAiPort;
    conversation?: RimConversationInitializationPort;
    initializationLog?: RimInitializationObservation[];
    retrieval?: RimProviderRetrievalPort | null;
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
    if (effect.type === "REQUEST_RIM_AI") {
      const settled = await continuePendingRimAi({
        context: tools.context,
        ...(tools.clientClaimedUserId === undefined
          ? {}
          : { clientClaimedUserId: tools.clientClaimedUserId }),
        deps: tools.deps,
        rimAi: tools.rimAi,
        ...(tools.conversation === undefined ? {} : { conversation: tools.conversation }),
        ...(tools.initializationLog === undefined
          ? {}
          : { initializationLog: tools.initializationLog }),
        retrieval: tools.retrieval ?? null,
        origin: effect.conversationalOrigin,
        userRetry: current.event.name === "RIM.PRESS_RETRY_AI",
      });
      return settled ?? current;
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
    if (event.name === "RIM.CONTEXT_READY" && next.status === "APPLIED") {
      const initialized = await reconcileRimInitialization({
        context: tools.context,
        ...(tools.clientClaimedUserId === undefined
          ? {}
          : { clientClaimedUserId: tools.clientClaimedUserId }),
        deps: tools.deps,
        rimAi: tools.rimAi,
        ...(tools.conversation === undefined ? {} : { conversation: tools.conversation }),
        ...(tools.initializationLog === undefined
          ? {}
          : { initializationLog: tools.initializationLog }),
      });
      if (initialized) {
        current = initialized;
      }
    }
  }
  return current;
}

async function followUpEvent(
  execution: ApplicationExecutionResult,
  effect: NonNullable<ReturnType<typeof rimEffect>>,
  rimChatId: NonNullable<ApplicationExecutionResult["snapshot"]["extended"]["rimChat"]>["id"],
  tools: Parameters<typeof continueRimEffects>[1],
): Promise<ProductEventInput> {
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
  throw new Error(`Unsupported RIM external effect: ${effect.type}`);
}
