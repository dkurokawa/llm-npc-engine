import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AnthropicBackend } from "./anthropic.ts";

describe("AnthropicBackend", () => {
  test("moves system messages into the `system` field and posts /v1/messages", async (t) => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "<thinking>hmm</thinking>hello" }],
            usage: { output_tokens: 7 },
          }),
          { status: 200 },
        ),
      );
    });

    const backend = new AnthropicBackend({ apiKey: "test-key", model: "test-model" });
    const result = await backend.chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);

    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");

    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(body.system, "be terse");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);

    assert.equal(result.content, "hello");
    assert.equal(result.outputTokens, 7);
  });

  test("omits `system` entirely when there is no system message", async (t) => {
    let capturedInit: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ content: [] }), { status: 200 }));
    });

    const backend = new AnthropicBackend({ apiKey: "k", model: "m" });
    await backend.chat([{ role: "user", content: "hi" }]);

    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    assert.equal("system" in body, false);
  });

  test("a non-ok response throws with just the status", async (t) => {
    t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response("", { status: 401 })));

    const backend = new AnthropicBackend({ apiKey: "k", model: "m" });
    await assert.rejects(() => backend.chat([]), /anthropic 401/);
  });
});
