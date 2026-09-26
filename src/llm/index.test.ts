import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AnthropicBackend, backendFromEnv, OllamaBackend, OpenAICompatBackend } from "./index.ts";

describe("backendFromEnv", () => {
  test("defaults to ollama with its documented default model", () => {
    const backend = backendFromEnv({});
    assert.ok(backend instanceof OllamaBackend);
    assert.equal(backend.label, "ollama:llama3.1:8b-instruct-q4_k_m");
  });

  test("ollama honors OLLAMA_MODEL", () => {
    const backend = backendFromEnv({ LLM_BACKEND: "ollama", OLLAMA_MODEL: "qwen2.5:7b" });
    assert.equal(backend.label, "ollama:qwen2.5:7b");
  });

  test("openai-compat throws naming the first missing required key", () => {
    assert.throws(
      () => backendFromEnv({ LLM_BACKEND: "openai-compat" }),
      /OPENAI_COMPAT_BASE_URL is not set/,
    );
  });

  test("openai-compat builds once every required key is present", () => {
    const backend = backendFromEnv({
      LLM_BACKEND: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "https://example.com/v1",
      OPENAI_COMPAT_API_KEY: "key",
      OPENAI_COMPAT_MODEL: "some-model",
    });
    assert.ok(backend instanceof OpenAICompatBackend);
    assert.equal(backend.label, "openai-compat:some-model");
  });

  test("anthropic throws when its key is missing", () => {
    assert.throws(
      () => backendFromEnv({ LLM_BACKEND: "anthropic" }),
      /ANTHROPIC_API_KEY is not set/,
    );
  });

  test("anthropic builds with its default model when only the key is given", () => {
    const backend = backendFromEnv({ LLM_BACKEND: "anthropic", ANTHROPIC_API_KEY: "key" });
    assert.ok(backend instanceof AnthropicBackend);
    assert.equal(backend.label, "anthropic:claude-haiku-4-5");
  });

  test("an unrecognized backend name is rejected", () => {
    assert.throws(
      () => backendFromEnv({ LLM_BACKEND: "bogus" }),
      /unknown LLM_BACKEND: bogus/,
    );
  });
});
