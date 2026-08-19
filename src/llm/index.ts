/**
 * Picks a backend from the environment.
 *
 * Switching between a local model, a cheap hosted one, and Claude is one line
 * in `.env` — no code in `src/core/` knows which is in use. See `.env.example`.
 */

import { AnthropicBackend } from "./anthropic.ts";
import { OllamaBackend } from "./ollama.ts";
import { OpenAICompatBackend } from "./openai-compat.ts";
import type { LlmBackend } from "./types.ts";

export type { ChatMessage, ChatResult, LlmBackend } from "./types.ts";
export { AnthropicBackend, OllamaBackend, OpenAICompatBackend };

export type BackendName = "ollama" | "openai-compat" | "anthropic";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set (required by LLM_BACKEND)`);
  return v;
}

export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): LlmBackend {
  const name = (env.LLM_BACKEND ?? "ollama") as BackendName;

  switch (name) {
    case "ollama":
      return new OllamaBackend({
        host: env.OLLAMA_HOST,
        model: env.OLLAMA_MODEL ?? "llama3.1:8b-instruct-q4_k_m",
      });

    case "openai-compat":
      return new OpenAICompatBackend({
        baseUrl: required(env, "OPENAI_COMPAT_BASE_URL"),
        apiKey: required(env, "OPENAI_COMPAT_API_KEY"),
        model: required(env, "OPENAI_COMPAT_MODEL"),
      });

    case "anthropic":
      return new AnthropicBackend({
        apiKey: required(env, "ANTHROPIC_API_KEY"),
        model: env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
      });

    default:
      throw new Error(
        `unknown LLM_BACKEND: ${name} (expected ollama, openai-compat, or anthropic)`,
      );
  }
}
