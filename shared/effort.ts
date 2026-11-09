// How hard a Boton's agent CLI thinks: the levels each provider takes, checked where they are set. Node builtins
// only (none at all), so doctor and the `botons` CLI can load it without node_modules.

export interface EffortLevel {
  id: string;
  label: string;
}

export interface ProviderEffort {
  /** The CLI's name, as refusals say it. */
  name: string;
  /** Every level the provider takes, weakest first. */
  levels: readonly EffortLevel[];
  /** How it reaches the CLI, for the owner. */
  via: string;
  /** What runs when no level is set. */
  defaultText: string;
}

const level = (id: string, label = id[0].toUpperCase() + id.slice(1)): EffortLevel => ({ id, label });

/**
 * Claude Code: `--effort`. It runs a level the model doesn't have as the highest one it has below it, and its
 * CLAUDE_CODE_EFFORT_LEVEL would win over the flag, which is why the agent environment never passes it on.
 * Codex: `model_reasoning_effort`, whose levels are its ReasoningEffort names; which of them a model takes is in
 * its model list (ProviderModel.efforts).
 */
export const PROVIDER_EFFORT: Readonly<Record<string, ProviderEffort>> = {
  'claude-cli': {
    name: 'Claude Code',
    levels: [level('low'), level('medium'), level('high'), level('xhigh', 'Extra high'), level('max')],
    via: 'Claude Code’s --effort',
    defaultText: 'Claude Code’s default for the model',
  },
  'codex-cli': {
    name: 'Codex',
    levels: [level('none'), level('minimal'), level('low'), level('medium'), level('high'), level('xhigh', 'Extra high'), level('max'), level('ultra')],
    via: 'Codex’s model_reasoning_effort',
    defaultText: 'Codex’s default for the model',
  },
  // The Messages API's output_config.effort; which levels a model takes is in the key's model list (its effort capability).
  'anthropic-api': {
    name: 'The Anthropic API',
    levels: [level('low'), level('medium'), level('high'), level('xhigh', 'Extra high'), level('max')],
    via: 'the Anthropic API’s output_config.effort',
    defaultText: 'the model’s default',
  },
  // The Responses API's reasoning.effort; not every model takes every level, and its model list doesn't say which.
  'openai-api': {
    name: 'The OpenAI API',
    levels: [level('none'), level('minimal'), level('low'), level('medium'), level('high'), level('xhigh', 'Extra high'), level('max')],
    via: 'the OpenAI API’s reasoning.effort',
    defaultText: 'the model’s default',
  },
  mock: { name: 'The mock provider', levels: [level('low'), level('medium'), level('high')], via: 'the mock provider', defaultText: 'the mock’s default' },
};

/** Every level any provider takes. */
export const EFFORT_IDS: readonly string[] = [...new Set(Object.values(PROVIDER_EFFORT).flatMap((p) => p.levels.map((l) => l.id)))];

export const providerEffort = (provider: string): ProviderEffort | null => PROVIDER_EFFORT[provider] ?? null;

/**
 * What the provider's own model list says one model takes: its levels and, when it says, the one it runs without a
 * setting. Only a list the provider gives counts; null (no list, or a model it doesn't list) means nothing is known
 * about the model, and only the provider's levels are checked.
 */
export interface ModelEfforts {
  model: string;
  label: string;
  levels: readonly string[];
  defaultEffort?: string;
}

/**
 * Why `effort` can't be asked of `provider` ("" is always fine: its default), or null. With `known`, the model's own
 * list is checked too; without it, a provider's level may still be one the model lacks, which only the CLI can tell.
 */
export function effortProblem(provider: string, effort: string, known?: ModelEfforts | null): string | null {
  if (effort === '') return null;
  const p = providerEffort(provider);
  if (!p) return `${provider} has no effort setting: leave it at the provider's default ("")`;
  if (!p.levels.some((l) => l.id === effort)) return `${p.name} has no effort level "${effort}": use one of ${p.levels.map((l) => l.id).join(', ')}, or "" for its default`;
  if (known && !known.levels.includes(effort)) {
    const usable = p.levels.filter((l) => known.levels.includes(l.id)).map((l) => l.id);
    const name = known.label && known.label !== known.model ? `${known.label} (${known.model})` : known.model;
    const fallback = known.defaultEffort ? `, or "" for its default (${known.defaultEffort}, as the list says)` : ', or "" for its default';
    return `${p.name}'s model list has no effort level "${effort}" for ${name}: use one of ${usable.join(', ')}${fallback}`;
  }
  return null;
}
