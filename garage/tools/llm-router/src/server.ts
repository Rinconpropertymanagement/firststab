import { createServer } from "http";
import { LlmRouter } from "./router.js";
import type { RouterRequest } from "./types.js";

// ── THE LITTLE WEB SERVICE ───────────────────────────────────────────────────
// This is what your tools actually talk to. It listens on a port and offers
// three doors:
//   POST /route   → ask the AI (the main one)
//   GET  /health  → are the AI providers alive?
//   GET  /stats   → what have I spent, and how much did the free lane save?

const router = new LlmRouter({
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  openai_api_key: process.env.OPENAI_API_KEY,
  ollama_base_url: process.env.OLLAMA_BASE_URL,
});

const PORT = Number(process.env.PORT ?? 3001);

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === "POST" && url === "/route") {
      const body = await readJson(req);
      if (!body.task || !Array.isArray(body.messages)) {
        return json(400, { error: "Send { task: 'cheap'|'balanced'|'smart', messages: [...] }" });
      }
      const answer = await router.complete(body as RouterRequest);
      return json(200, answer);
    }

    if (req.method === "GET" && url === "/health") {
      return json(200, await router.health());
    }

    if (req.method === "GET" && (url === "/stats" || url === "/")) {
      return json(200, router.stats());
    }

    return json(404, { error: "Not found. Try POST /route, GET /health, or GET /stats." });
  } catch (err) {
    // Something went wrong talking to the AI provider. Tell the caller plainly.
    return json(502, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`Money-saver router listening on http://localhost:${PORT}`);
  console.log(`  POST /route   ask the AI`);
  console.log(`  GET  /health  provider status`);
  console.log(`  GET  /stats   spend so far`);
});

// Read and parse a JSON request body.
function readJson(req: import("http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Request body was not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}
