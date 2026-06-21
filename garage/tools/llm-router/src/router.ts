import { createHash } from "crypto";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { LocalAdapter } from "./adapters/local.js";
import { ProviderAdapter } from "./adapters/base.js";
import type {
  AdapterResponse,
  ProviderName,
  RouterConfig,
  RouterRequest,
  RouterResponse,
  Task,
} from "./types.js";

// ── THE TRAFFIC COP ──────────────────────────────────────────────────────────
// One job: for each request, pick which AI answers it, try the cheap one first,
// fall back to a backup if it fails, and remember recent answers so repeats are
// free. Everything money-saving happens here.

// How long to remember a recent answer, per lane. If the exact same question
// comes in again within this window, we return the saved answer for $0.
const CACHE_TTL_MS: Record<Task, number> = {
  cheap: 60 * 60 * 1000, // 1 hour
  balanced: 60 * 60 * 1000, // 1 hour
  smart: 0, // never cache the hard stuff — it's usually unique
};

interface CacheEntry {
  value: AdapterResponse;
  expires: number;
}

export class LlmRouter {
  private anthropic: AnthropicAdapter | null;
  private openai: OpenAIAdapter | null;
  private local: LocalAdapter | null;

  // A simple in-memory memory of recent answers. (A bigger system would use a
  // database like Redis; for one garage server, a plain map is plenty.)
  private cache = new Map<string, CacheEntry>();

  // Running tally so you can see what you've spent and saved.
  private spend = { total_usd: 0, by_provider: { local: 0, openai: 0, anthropic: 0 } };
  private counts = { total: 0, cache_hits: 0, by_provider: { local: 0, openai: 0, anthropic: 0 } };

  constructor(config: RouterConfig) {
    this.anthropic = config.anthropic_api_key ? new AnthropicAdapter(config.anthropic_api_key) : null;
    this.openai = config.openai_api_key ? new OpenAIAdapter(config.openai_api_key) : null;
    this.local = config.ollama_base_url ? new LocalAdapter() : null;
  }

  async complete(request: RouterRequest): Promise<RouterResponse> {
    const { primary, fallback, model } = await this.pickLane(request);
    const max_tokens = request.max_tokens ?? 1024;

    // 1) Have we answered this exact question recently? Return it for free.
    const key = cacheKey(request, model);
    const ttl = CACHE_TTL_MS[request.task];
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > Date.now()) {
        this.counts.total++;
        this.counts.cache_hits++;
        return { ...hit.value, cache_hit: true, latency_ms: 0 };
      }
    }

    const options = { model, messages: request.messages, max_tokens };

    // 2) Try the primary (usually the cheapest one that fits the lane).
    let raw: AdapterResponse;
    try {
      raw = await primary.complete(options);
    } catch (primaryError) {
      // 3) Primary failed (e.g. local model is down or timed out). Use the backup.
      if (!fallback) throw primaryError;
      raw = await fallback.complete({ ...options, model: defaultModelFor(fallback) });
    }

    // 4) Record cost, remember the answer, return it.
    this.tally(raw);
    if (ttl > 0) this.cache.set(key, { value: raw, expires: Date.now() + ttl });
    return { ...raw, cache_hit: false };
  }

  // Decide who answers. This is the heart of the money-saving.
  private async pickLane(request: RouterRequest): Promise<{
    primary: ProviderAdapter;
    fallback: ProviderAdapter | null;
    model: string;
  }> {
    // PRIVACY SWITCH: keep_local means this NEVER leaves your server — no cloud
    // fallback, even if the local model is down (we'd rather fail than leak it).
    if (request.keep_local) {
      if (!this.local) throw new Error("keep_local was set, but no local model is configured.");
      return { primary: this.local, fallback: null, model: LocalAdapter.modelFor(request.task) };
    }

    const localUp = this.local !== null && (await this.local.healthCheck());

    // CHEAP lane → free local model first, cloud as backup.
    if (request.task === "cheap" && localUp) {
      return {
        primary: this.local!,
        fallback: this.openai ?? this.anthropic,
        model: LocalAdapter.modelFor("cheap"),
      };
    }

    // SMART lane → Claude only. No backup; if you wanted the smart one, a cheaper
    // model isn't an acceptable substitute.
    if (request.task === "smart" && this.anthropic) {
      return { primary: this.anthropic, fallback: null, model: AnthropicAdapter.defaultModel() };
    }

    // BALANCED lane (and the fallback for everything else) → cheap cloud model,
    // Claude as backup.
    if (this.openai) {
      return { primary: this.openai, fallback: this.anthropic, model: OpenAIAdapter.defaultModel() };
    }

    // Last resort — whatever we have configured.
    if (this.anthropic) return { primary: this.anthropic, fallback: null, model: AnthropicAdapter.defaultModel() };
    if (this.local && localUp) return { primary: this.local, fallback: null, model: LocalAdapter.modelFor(request.task) };
    throw new Error("No AI providers are configured. Add at least one key or the local model.");
  }

  private tally(raw: AdapterResponse): void {
    this.counts.total++;
    this.counts.by_provider[raw.provider]++;
    this.spend.total_usd += raw.cost_usd;
    this.spend.by_provider[raw.provider] += raw.cost_usd;
  }

  // For the /stats page — see what you've spent and how much the free lane saved.
  stats() {
    return { spend: this.spend, counts: this.counts };
  }

  // For the /health page — which providers are alive.
  async health() {
    return {
      local: this.local ? await this.local.healthCheck() : null,
      openai: this.openai ? await this.openai.healthCheck() : null,
      anthropic: this.anthropic ? await this.anthropic.healthCheck() : null,
    };
  }
}

// Build a unique fingerprint of a request, so identical questions share a cached
// answer but different ones don't.
function cacheKey(request: RouterRequest, model: string): string {
  const basis = JSON.stringify({ model, messages: request.messages });
  return createHash("sha256").update(basis).digest("hex");
}

function defaultModelFor(adapter: ProviderAdapter): string {
  if (adapter instanceof AnthropicAdapter) return AnthropicAdapter.defaultModel();
  if (adapter instanceof OpenAIAdapter) return OpenAIAdapter.defaultModel();
  return LocalAdapter.modelFor("balanced");
}
