// API list prices in USD per million tokens (Anthropic first-party rates).
// quotameter uses these only as a weight for comparing messages with the
// plan's percentage limits. Pro and Max are not billed per token.
//
// Cache writes cost 1.25x input (5 minute TTL) or 2x input (1 hour TTL).
// Cache reads are 0.1x input except where a model sets its own read price.
// Checked against Claude Code's own costUSD on 2026-10-13.

const P = (input, output, cacheRead = input * 0.1) => ({ input, output, cacheRead });

export const PRICES = {
  'claude-fable-5-1': P(10, 50, 0.25),
  'claude-mythos-5-1': P(10, 50, 0.25),
  'claude-fable-5': P(10, 50, 1),
  'claude-opus-5-5': P(4, 20, 0.2),
  'claude-opus-5': P(5, 25),
  'claude-opus-4-8': P(5, 25),
  'claude-opus-4-7': P(5, 25),
  'claude-opus-4-6': P(5, 25),
  'claude-opus-4-5': P(5, 25),
  'claude-opus-4-1': P(15, 75),
  'claude-opus-4': P(15, 75),
  'claude-sonnet-5-5': P(2, 10, 0.2),
  'claude-sonnet-5': P(2, 10),
  'claude-sonnet-4-6': P(3, 15),
  'claude-sonnet-4-5': P(3, 15),
  'claude-sonnet-4': P(3, 15),
  'claude-haiku-5-5': P(0.1, 0.5),
  'claude-haiku-4-5': P(1, 5),
};

// Haiku 5.5 charges more once a prompt goes past 100K tokens.
const LONG_PROMPT = {
  'claude-haiku-5-5': { threshold: 100_000, price: P(0.5, 2.5) },
};

// Fast mode runs the same model at a premium.
const FAST_MULTIPLIER = { 'claude-opus-5-5': 2, 'claude-opus-5': 2, 'claude-opus-4-8': 2 };

// Strip date suffixes and provider prefixes: "anthropic.claude-opus-4-5-20251101" -> "claude-opus-4-5".
export function normalizeModel(model) {
  if (!model) return null;
  let m = String(model).toLowerCase();
  m = m.replace(/^.*?(claude-)/, '$1').replace(/@.*$/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  return m;
}

// Newest model of each family, used when a log names a model this table does not know yet.
const FAMILY_FALLBACK = { fable: 'claude-fable-5-1', mythos: 'claude-mythos-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

export function isKnownModel(model) {
  const m = normalizeModel(model);
  return !!m && (!!PRICES[m] || Object.keys(PRICES).some((k) => m.startsWith(k)));
}

export function priceFor(model) {
  const m = normalizeModel(model);
  if (!m) return null;
  if (PRICES[m]) return PRICES[m];
  // Longest known prefix first, so "claude-sonnet-4-5-v2" still prices as Sonnet 4.5.
  const key = Object.keys(PRICES).filter((k) => m.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (key) return PRICES[key];
  const family = Object.keys(FAMILY_FALLBACK).find((f) => m.includes(f));
  return family ? PRICES[FAMILY_FALLBACK[family]] : null;
}

// usage: the `usage` object from a Claude Code assistant record.
// Returns USD, or null when the model is unknown.
export function costOf(model, usage, { speed } = {}) {
  let price = priceFor(model);
  if (!price || !usage) return null;
  const m = normalizeModel(model);
  const input = usage.input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const writeTotal = usage.cache_creation_input_tokens || 0;
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? writeTotal - w1h;
  const output = usage.output_tokens || 0;

  const long = LONG_PROMPT[m];
  if (long && input + read + writeTotal > long.threshold) price = long.price;

  const perM =
    input * price.input +
    w5m * price.input * 1.25 +
    w1h * price.input * 2 +
    read * price.cacheRead +
    output * price.output;
  const fast = (speed || usage.speed) === 'fast' ? FAST_MULTIPLIER[m] || 1 : 1;
  return (perM / 1e6) * fast;
}
