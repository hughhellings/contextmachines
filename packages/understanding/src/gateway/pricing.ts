/**
 * What a model call costs, so a run can say what its AI reading cost. It imports nothing, so
 * anything that calls a model can count its cost without bringing more code along.
 */

/** USD per million tokens, as the provider listed them when this was written: prices change, so check before relying on a figure. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** What one call's tokens cost in USD: 0 for a model with no known price. */
export function cost(model: string, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite * p.cacheWrite) / 1_000_000;
}
