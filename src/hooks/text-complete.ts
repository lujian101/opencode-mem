import type { ClaudeMemClient } from "../client.js";
import type { PluginState } from "../types.js";
import { stripMemoryTagsFromText } from "../utils/strip-tags.js";
import { MAX_OUTPUT_BYTES } from "../constants.js";



export function createTextCompleteHook(
  memClient: ClaudeMemClient,
  state: PluginState,
  cwd = "",
) {
  return async (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ): Promise<void> => {
    if (!input.sessionID) return;
    if (!output.text?.trim()) return;

    // MUST NOT mutate output.text — copy first
    let cleanText = stripMemoryTagsFromText(output.text);
    if (cleanText.length > MAX_OUTPUT_BYTES) {
      cleanText = cleanText.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]";
    }

    state.lastAssistantMessage = cleanText;

    void memClient.sendObservation({
      contentSessionId: input.sessionID,
      tool_name: "assistant_response",
      tool_input: {
        messageID: input.messageID,
        partID: input.partID,
      },
      tool_response: cleanText,
      cwd: cwd || undefined,
      last_user_message: state.lastUserMessage || undefined,
      last_assistant_message: state.lastAssistantMessage || undefined,
      prompt_number: state.promptNumber > 0 ? state.promptNumber : undefined,
    });
  };
}
