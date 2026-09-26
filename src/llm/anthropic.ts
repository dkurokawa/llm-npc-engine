/**
 * The Claude API. The third rung: the steadiest Japanese and the least tuning.
 *
 * Called over raw HTTP rather than through `@anthropic-ai/sdk`, so the engine
 * stays dependency-free and a reader can run it with nothing but Node. An app
 * built on top of this is better off with the official SDK.
 */

import { stripThinking, type ChatMessage, type ChatResult, type LlmBackend } from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  baseUrl?: string;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { output_tokens?: number };
}

const API_VERSION = "2023-06-01";

export class AnthropicBackend implements LlmBackend {
  readonly label: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #baseUrl: string;

  constructor(opts: AnthropicOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model;
    // NPC lines are a couple of sentences; a small cap keeps replies snappy.
    this.#maxTokens = opts.maxTokens ?? 512;
    this.#baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.label = `anthropic:${opts.model}`;
  }

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    // Claude takes the system prompt as its own parameter rather than a message.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages.filter((m) => m.role !== "system");

    const started = Date.now();
    const res = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: this.#maxTokens,
        ...(system ? { system } : {}),
        messages: turns,
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}`);
    }
    const body = (await res.json()) as AnthropicResponse;
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      content: stripThinking(text),
      elapsedMs: Date.now() - started,
      outputTokens: body.usage?.output_tokens,
    };
  }
}
