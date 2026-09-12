import type { CanonicalEventName } from "./events.ts";
import type { DomainTimerMutatingEffectType, EffectType } from "./effects.ts";
import type { MatrixEffectDeclaration, MatrixResult } from "./guards.ts";
import { AUTHORITY_DOCUMENTS } from "./authority.ts";

export type RuleLayer = "GLOBAL" | "LOCAL" | "BOOTSTRAP";

export type RuleCompositionKind = "GLOBAL_THEN_LOCAL" | "BOOTSTRAP_ONLY" | "LOCAL_ONLY";

export type GlobalLocalCompositionContract = Readonly<{
  event: CanonicalEventName;
  composition: RuleCompositionKind;
  layers: readonly RuleLayer[];
  result: MatrixResult;
  nextState: null | "CURRENT" | "RIM.LOBBY";
  references: readonly [
    { document: typeof AUTHORITY_DOCUMENTS.matrix; locator: string; rule: string },
  ];
}>;

export const APP_FULL_CLOSE_COMPOSITION = {
  event: "APP.FULL_CLOSE",
  composition: "GLOBAL_THEN_LOCAL",
  layers: ["GLOBAL", "LOCAL"],
  result: "SESSION_END",
  nextState: null,
  references: [
    {
      document: AUTHORITY_DOCUMENTS.matrix,
      locator: "Global rule — APP.FULL_CLOSE / Timer Notification Item processing",
      rule: "E-32 global overlay composed with every local E-32 row",
    },
  ],
} as const satisfies GlobalLocalCompositionContract;

export const APP_FULL_CLOSE_GLOBAL_EFFECTS = [
  {
    type: "PROCESS_TIMER_NOTIFICATION_ITEM",
    appliesWhen: "an unprocessed Timer Notification Item exists for the current user",
  },
  {
    type: "CLEAR_TIMER_PRIORITY",
    appliesWhen: "applicable Timer Priority exists for that Timer Notification Item",
  },
] as const satisfies readonly MatrixEffectDeclaration[];

export const APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES = [
  "UPSERT_DOMAIN_TIMER",
] as const satisfies readonly DomainTimerMutatingEffectType[];

export const E42_DURATION_EXPIRED_EFFECTS = [
  { type: "UPSERT_DOMAIN_TIMER", appliesWhen: "authoritative Ban duration expires" },
  { type: "UPSERT_CHECK_PAIR", appliesWhen: "eligible accepted Ban without existing Check pair" },
  { type: "UPSERT_NOTIFICATION_ITEM", appliesWhen: "receiver Check Notification Item is created" },
  { type: "UPSERT_NOTIFICATION_ITEM", appliesWhen: "sender Check Notification Item is created" },
] as const satisfies readonly MatrixEffectDeclaration[];

export function composeDeclaredEffects(
  globalEffects: readonly MatrixEffectDeclaration[],
  localEffects: readonly MatrixEffectDeclaration[],
  terminal?: MatrixEffectDeclaration,
): readonly MatrixEffectDeclaration[] {
  return terminal
    ? [...globalEffects, ...localEffects, terminal]
    : [...globalEffects, ...localEffects];
}

export function composeAppFullCloseDeclaredEffects(
  localEffects: readonly MatrixEffectDeclaration[],
): readonly MatrixEffectDeclaration[] {
  return composeDeclaredEffects(APP_FULL_CLOSE_GLOBAL_EFFECTS, localEffects, {
    type: "END_SESSION",
  });
}

export function assertsNoDomainTimerMutation(effectTypes: readonly EffectType[]): boolean {
  return !effectTypes.some((type) =>
    (APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES as readonly EffectType[]).includes(type),
  );
}
