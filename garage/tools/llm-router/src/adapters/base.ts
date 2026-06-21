import type { AdapterResponse, ChatMessage, ProviderName } from "../types.js";

// Every AI provider — the free local one, OpenAI, Claude — does the same two
// things: take a list of messages and give back text, and tell you whether it's
// alive. This base class is that promise. Each real provider fills it in.
//
// The whole point: once you've seen one adapter, you've seen them all. Adding a
// new AI provider is copying one of these files and changing the address + price.

export interface CompletionOptions {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
}

export abstract class ProviderAdapter {
  // What this provider is called in logs and responses.
  abstract readonly name: ProviderName;

  // Send messages, get text back (plus what it cost and how long it took).
  abstract complete(options: CompletionOptions): Promise<AdapterResponse>;

  // Is this provider reachable right now? The router uses this to decide
  // whether to send work here or skip to the backup.
  abstract healthCheck(): Promise<boolean>;
}
