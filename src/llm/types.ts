/** The contract every backend implements. Nothing above this layer knows which one is in use. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  elapsedMs: number;
  /** Tokens generated, when the backend reports it. */
  outputTokens?: number;
}

export interface LlmBackend {
  /** Identifies the backend and model in logs and recordings. */
  readonly label: string;
  chat(messages: ChatMessage[]): Promise<ChatResult>;
}

/**
 * Reasoning-tuned models emit their scratchpad before the reply. Left in, it
 * shows up as an NPC thinking out loud, so it is stripped at the boundary
 * rather than in each backend.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    // An unterminated block means the reply was cut off mid-thought; keeping
    // the fragment is worse than dropping it.
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();
}
