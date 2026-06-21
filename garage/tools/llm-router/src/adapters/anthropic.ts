import Anthropic from "@anthropic-ai/sdk";
import type { AdapterResponse, ChatMessage } from "../types.js";
import { ProviderAdapter, type CompletionOptions } from "./base.js";

// ── THE SMART ONE ────────────────────────────────────────────────────────────
// Claude. The most capable — and the most expensive — so the router only sends
// it the hard jobs. Same adapter shape as the others, with two small quirks:
//   1. Claude wants the "system" instructions passed separately, not mixed into
//      the message list. We split them out below.
//   2. Its library calls the count "input_tokens" / "output_tokens".

const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap Claude for the "smart" lane

// Approximate US dollars per 1,000,000 tokens. Check current pricing — it changes.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
};

export class AnthropicAdapter extends ProviderAdapter {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    super();
    this.client = new Anthropic({ apiKey });
  }

  async complete(options: CompletionOptions): Promise<AdapterResponse> {
    const start = Date.now();
    const model = options.model || DEFAULT_MODEL;

    // Pull the "system" instructions out of the message list (Claude wants them
    // as a separate field), and keep only user/assistant turns in the list.
    const system = options.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const turns = options.messages.filter(
      (m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system"
    );

    const response = await this.client.messages.create({
      model,
      max_tokens: options.max_tokens,
      ...(system ? { system } : {}),
      messages: turns.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      content: text,
      provider: "anthropic",
      model,
      cost_usd: priceOf(model, response.usage.input_tokens, response.usage.output_tokens),
      latency_ms: Date.now() - start,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
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
