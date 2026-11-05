/**
 * Token estimation.
 *
 * The default estimator is characters ÷ 4, which is a rough approximation.
 * Every estimate is explicitly labelled as an estimate so a caller never
 * mistakes it for a provider's exact count.
 *
 * When an Anthropic API key is available, `countTokensExact` can ask the
 * Messages API for a real count. That is opt-in: it costs a network call.
 */

/** The result of a token estimate. */
export interface TokenEstimate {
  /** The estimated number of tokens. */
  tokens: number;
  /** The number of characters measured. */
  characters: number;
  /** True when the number is an estimate rather than an exact provider count. */
  estimated: true;
  /** The method used. */
  method: 'chars-per-token' | 'provider';
}

/** An exact token count from the provider. */
export interface ExactTokenCount {
  tokens: number;
  characters: number;
  estimated: false;
  method: 'provider';
}

/** Characters per token used by the default estimator. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/** Estimate the tokens in a string. */
export function estimateTokens(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): TokenEstimate {
  const characters = text.length;
  return {
    tokens: Math.ceil(characters / charsPerToken),
    characters,
    estimated: true,
    method: 'chars-per-token',
  };
}

/**
 * Count tokens exactly using the Anthropic API.
 *
 * The Anthropic SDK does not expose a standalone counting endpoint, so the
 * count is obtained by asking the Messages API to count, which is itself
 * billable and slow. This is used only when a caller explicitly wants
 * precision (for example, the benchmark harness).
 */
export async function countTokensExact(
  text: string,
  model: string,
  apiKey: string,
): Promise<ExactTokenCount> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: text }],
  });
  return {
    tokens: response.input_tokens,
    characters: text.length,
    estimated: false,
    method: 'provider',
  };
}
