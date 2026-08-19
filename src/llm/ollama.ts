/** Local models through Ollama. The zero-cost first rung: no key, no account. */

import { stripThinking, type ChatMessage, type ChatResult, type LlmBackend } from "./types.ts";

export interface OllamaOptions {
  host?: string;
  model: string;
  temperature?: number;
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
  eval_count?: number;
}

export class OllamaBackend implements LlmBackend {
  readonly label: string;
  readonly #host: string;
  readonly #model: string;
  readonly #temperature: number;

  constructor(opts: OllamaOptions) {
    this.#host = (opts.host ?? "http://localhost:11434").replace(/\/$/, "");
    this.#model = opts.model;
    this.#temperature = opts.temperature ?? 0.8;
    this.label = `ollama:${opts.model}`;
  }

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${this.#host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.#model,
        messages,
        stream: false,
        options: { temperature: this.#temperature },
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as OllamaChatResponse;
    return {
      // Some builds return the scratchpad in its own field; either way it is
      // the reply text we want, with any thinking removed.
      content: stripThinking(body.message?.content ?? ""),
      elapsedMs: Date.now() - started,
      outputTokens: body.eval_count,
    };
  }
}
