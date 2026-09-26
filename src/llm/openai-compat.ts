/**
 * Any provider speaking the OpenAI chat-completions shape.
 *
 * This is the second rung: several inexpensive providers expose this exact
 * endpoint, so moving between them is a base URL and a model name — which is
 * the whole argument for keeping the backend behind an interface.
 */

import { stripThinking, type ChatMessage, type ChatResult, type LlmBackend } from "./types.ts";

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { completion_tokens?: number };
}

export class OpenAICompatBackend implements LlmBackend {
  readonly label: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #temperature: number;

  constructor(opts: OpenAICompatOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#apiKey = opts.apiKey;
    this.#model = opts.model;
    this.#temperature = opts.temperature ?? 0.8;
    this.label = `openai-compat:${opts.model}`;
  }

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        messages,
        temperature: this.#temperature,
      }),
    });
    if (!res.ok) {
      // The body can echo back request details, so only the status is surfaced.
      throw new Error(`openai-compat ${res.status}`);
    }
    const body = (await res.json()) as OpenAIChatResponse;
    return {
      content: stripThinking(body.choices?.[0]?.message?.content ?? ""),
      elapsedMs: Date.now() - started,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}
