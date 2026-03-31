import type { ClaudeMemClient } from "../client.js";
import type { PluginState } from "../types.js";
import { stripMemoryTagsFromText } from "../utils/strip-tags.js";

type TextPartLike = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
};

/**
 * Creates the chat.message hook.
 * Captures user prompts for claude-mem session tracking.
 * Uses fire-and-forget (never blocks opencode).
 *
 * Note: The chat.message hook fires for all messages (user and agent).
 * The optional 'agent' field in input indicates non-user messages and is used as a guard.
 */
export function createCapturePromptHook(
  memClient: ClaudeMemClient,
  state: PluginState,
) {
  return async (
    input: { sessionID: string; agent?: string },
    output: { message: unknown; parts: unknown[] },
  ): Promise<void> => {
    // Guard: skip if no sessionID
    if (!input.sessionID) {
      console.log("[opencode-claude-mem] Skipped - no sessionID, agent:", input.agent);
      return;
    }

    // Extract text from parts array (TextPart items with type === "text")
    const parts = output.parts ?? [];
    const textContent = (parts as TextPartLike[])
      .filter(p => p?.type === "text")
      .map(p => p.text ?? "")
      .join("\n");

    const cleanText = stripMemoryTagsFromText(textContent);
    if (!cleanText.trim()) {
      return;
    }

    state.lastUserMessage = cleanText;
    state.promptNumber += 1;

    void memClient.initSession({
      contentSessionId: input.sessionID,
      project: state.projectName,
      prompt: cleanText,
    });
  };
}
