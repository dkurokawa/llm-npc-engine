import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OllamaBackend } from "./ollama.ts";

describe("OllamaBackend", () => {
  test("posts the model and messages to <host>/api/chat, and strips thinking from the reply", async (t) => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: { content: "<think>hmm</think>hello" }, eval_count: 12 }),
          { status: 200 },
        ),
      );
    });

    const backend = new OllamaBackend({ host: "http://example:1234/", model: "test-model" });
    const result = await backend.chat([{ role: "user", content: "hi" }]);

    assert.equal(capturedUrl, "http://example:1234/api/chat");
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(body.options, { temperature: 0.8 });

    assert.equal(result.content, "hello");
    assert.equal(result.outputTokens, 12);
  });

  test("a non-ok response throws with the status and body text", async (t) => {
    t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response("boom", { status: 500 })));

    const backend = new OllamaBackend({ model: "test-model" });
    await assert.rejects(() => backend.chat([]), /ollama 500: boom/);
  });
});
