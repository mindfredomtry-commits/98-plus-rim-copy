import type { Effect } from "@98plus/product-model";

export const EXTERNAL_EFFECT_TYPES = [
  "REQUEST_RELATIONSHIP_CONTEXT",
  "REQUEST_RIM_AI",
  "OPEN_TELEGRAM_SHARE",
  "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE",
] as const;

export type ExternalEffectType = (typeof EXTERNAL_EFFECT_TYPES)[number];

export type ExternalEffect = Extract<Effect, { type: ExternalEffectType }>;

export type PendingExternalEffect = Readonly<{
  effect: ExternalEffect;
  completed: false;
}>;

function isExternalEffect(effect: Effect): effect is ExternalEffect {
  return (EXTERNAL_EFFECT_TYPES as readonly string[]).includes(effect.type);
}

export function pendingExternalEffects(
  effects: readonly Effect[],
): readonly PendingExternalEffect[] {
  return effects.filter(isExternalEffect).map((effect) => ({ effect, completed: false as const }));
}
