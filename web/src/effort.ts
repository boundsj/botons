// The effort control's state, kept apart from the components so a test can run it against the server.
import { effortProblem, type ModelEfforts } from '../../shared/effort.ts';
import type { ProviderInfo } from '../../shared/types.ts';

/** What the provider's own model list says `model` takes, as the server checks it; null when it says nothing. */
export function knownEfforts(provider: ProviderInfo | undefined, model: string): ModelEfforts | null {
  const m = provider?.models.find((x) => x.id === model.trim());
  if (!m?.efforts?.length) return null;
  return { model: m.id, label: m.label, levels: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) };
}

/**
 * The level the form shows for `wanted` (the saved one, or the one the owner picked) on this brain: `wanted` when the
 * provider has it and the model's list, if it has one, does too; else "", the default. Switching brains back and forth
 * keeps `wanted`, so a level the next brain has comes back.
 */
export function shownEffort(provider: ProviderInfo | undefined, model: string, wanted: string): string {
  if (!wanted || !provider) return '';
  return effortProblem(provider.id, wanted, knownEfforts(provider, model)) ? '' : wanted;
}

/**
 * The effort a Boton's save sends. A level the owner picked that the brain has: it (the default too: their choice,
 * said nowhere). Nothing they picked: nothing, so the server keeps the saved level where the new brain has it and,
 * where it doesn't, puts it back to the default and says so in the chat. A level they picked that the brain they then
 * moved to doesn't have (the form says so): nothing when the saved level doesn't fit either, so the chat says that one
 * went back to the default; else the default.
 */
export function effortPatch(o: { picked: boolean; wanted: string; shown: string; savedShown: string }): { effort?: string } {
  if (!o.picked) return {};
  if (o.wanted && o.shown !== o.wanted) return o.savedShown ? { effort: '' } : {};
  return { effort: o.shown };
}
