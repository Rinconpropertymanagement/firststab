import OpenAI from "openai";
import type { AdapterResponse } from "../types.js";
import { ProviderAdapter, type CompletionOptions } from "./base.js";

// ── THE CHEAP CLOUD ONE ─────────────────────────────────────────────────────
// Same shape as the local adapter — read local.ts first. The only real
// differences: it talks to OpenAI's servers (so it needs a key), and it costs a
// little money (so we add up the price).

const DEFAULT_MODEL = "gpt-4o-mini";

// Approximate price in US dollars per 1,000,000 tokens (a token ≈ ¾ of a word).
// Check current prices on the provider's pricing page — they change over time.
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export class OpenAIAdapter extends ProviderAdapter {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(apiKey: string) {
    super();
    this.client = new OpenAI({ apiKey });
  }

  async complete(options: CompletionOptions): Promise<AdapterResponse> {
    const start = Date.now();
    const model = options.model || DEFAULT_MODEL;

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options.max_tokens,
      messages: options.messages,
    });

    const inTok = response.usage?.prompt_tokens ?? 0;
    const outTok = response.usage?.completion_tokens ?? 0;

    return {
      content: response.choices[0]?.message?.content ?? "",
      provider: "openai",
      model,
      cost_usd: priceOf(model, inTok, outTok),
      latency_ms: Date.now() - start,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: DEFAULT_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  static defaultModel(): string {
    return DEFAULT_MODEL;
  }
}

function priceOf(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output;
}
