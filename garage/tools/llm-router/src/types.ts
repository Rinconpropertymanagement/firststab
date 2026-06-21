// The shared vocabulary for the whole router. Everything else imports from here.

// Which provider answered. "local" = the free model on your own server.
export type ProviderName = "local" | "openai" | "anthropic";

// The three lanes. This is the one decision a tool author has to make:
//   cheap    → simple work (yes/no, scoring, short summaries) → free local model
//   balanced → medium work (translation, suggestions)         → cheap cloud model
//   smart    → hard work (reasoning, important writing)       → Claude
export type Task = "cheap" | "balanced" | "smart";

// A single turn in a conversation. "system" is the instructions, "user" is the
// question, "assistant" is a previous answer.
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// What a tool sends to the router.
export interface RouterRequest {
  task: Task;
  messages: ChatMessage[];
  max_tokens?: number; // default 1024
  // Privacy switch: when true, this request will ONLY ever touch your own
  // server. It never goes to a cloud provider, even as a fallback. Use it for
  // anything containing a person's private details.
  keep_local?: boolean;
}

// What the router sends back.
export interface RouterResponse {
  content: string;
  provider: ProviderName;
  model: string;
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
}

// What one provider adapter returns (the router adds nothing fancy on top).
export interface AdapterResponse {
  content: string;
  provider: ProviderName;
  model: string;
  cost_usd: number;
  latency_ms: number;
}

// Configuration, read from environment variables in server.ts.
export interface RouterConfig {
  anthropic_api_key?: string; // optional — enables the "smart" lane
  openai_api_key?: string;    // optional — enables the "balanced" lane + cheap fallback
  ollama_base_url?: string;   // your free local model, e.g. http://localhost:11434/v1
}
