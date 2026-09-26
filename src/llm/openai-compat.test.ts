import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OpenAICompatBackend } from "./openai-compat.ts";

describe("OpenAICompatBackend", () => {
  test("posts to <baseUrl>/chat/completions with a bearer token", async (t) => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "<think>hmm</think>hello" } }],
            usage: { completion_tokens: 5 },
          }),
          { status: 200 },
        ),
      );
    });

    const backend = new OpenAICompatBackend({
      baseUrl: "https://example.com/v1/",
      apiKey: "test-key",
      model: "test-model",
    });
    const result = await backend.chat([{ role: "user", content: "hi" }]);

    assert.equal(capturedUrl, "https://example.com/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");

    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(body.temperature, 0.8);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);

    assert.equal(result.content, "hello");
    assert.equal(result.outputTokens, 5);
  });

  test("a non-ok response throws with just the status, not the echoed body", async (t) => {
    t.mock.method(globalThis, "fetch", () =>
      Promise.resolve(new Response("request body echoed back", { status: 400 })),
    );

    const backend = new OpenAICompatBackend({ baseUrl: "https://example.com", apiKey: "k", model: "m" });
    await assert.rejects(() => backend.chat([]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "openai-compat 400");
      return true;
    });
  });
});
