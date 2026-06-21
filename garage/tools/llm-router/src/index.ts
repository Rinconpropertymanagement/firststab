// If another tool in your garage wants to use the router directly (instead of
// over the web), it can import the pieces from here.
export { LlmRouter } from "./router.js";
export { ProviderAdapter } from "./adapters/base.js";
export { LocalAdapter } from "./adapters/local.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { AnthropicAdapter } from "./adapters/anthropic.js";
export type {
  Task,
  ChatMessage,
  ProviderName,
  RouterRequest,
  RouterResponse,
  RouterConfig,
} from "./types.js";
