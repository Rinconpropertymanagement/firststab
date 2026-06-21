import OpenAI from "openai";
import type { AdapterResponse, Task } from "../types.js";
import { ProviderAdapter, type CompletionOptions } from "./base.js";

// ── THE FREE ONE ──────────────────────────────────────────────────────────────
// This talks to Ollama — a free AI model running on your own garage server.
// Because it runs on hardware you already pay for, every answer costs $0.
//
// Ollama speaks the same "language" as OpenAI (same request shape), so we reuse
// the OpenAI library and just point it at your local server instead of the cloud.
//
// This file is the REFERENCE ANSWER. The OpenAI and Anthropic adapters are the
// same idea — read this one first and the others will make sense.

const DEFAULT_MODEL = "qwen2.5:7b";
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

// A small AI model on a regular server can occasionally hang. If it takes longer
// than this, we give up and let the router fall back to a cloud model — so a slow
// local model never makes your tool feel broken.
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 20_000);

export class LocalAdapter extends ProviderAdapter {
  readonly name = "local" as const;
  private client: OpenAI;
  private host: string;

  constructor() {
    super();
    this.client = new OpenAI({
      apiKey: "ollama", // the local model ignores this, but the library wants something
      baseURL: BASE_URL,
    });
    // Ollama's "is it alive?" check lives at the server root, not under /v1.
    this.host = BASE_URL.replace(/\/v1\/?$/, "");
  }

  async complete(options: CompletionOptions): Promise<AdapterResponse> {
    const start = Date.now();

    // Set a timer; if the model hangs past TIMEOUT_MS we abort and throw.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.client.chat.completions.create(
        {
          model: options.model || DEFAULT_MODEL,
          max_tokens: options.max_tokens,
          messages: options.messages,
        },
        { signal: controller.signal }
      );

      return {
        content: response.choices[0]?.message?.content ?? "",
        provider: "local",
        model: options.model || DEFAULT_MODEL,
        cost_usd: 0, // it runs on your own server — always free
        latency_ms: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`); // lists installed models
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: unknown[] };
      return Array.isArray(body.models) && body.models.length > 0;
    } catch {
      return false;
    }
  }

  // The router asks "which local model for this lane?" Small fast model for the
  // quick stuff, the slightly bigger one for short writing/summaries.
  static modelFor(task: Task): string {
    return task === "cheap" ? "phi4-mini:3.8b" : DEFAULT_MODEL;
  }
}
