import {
  invoke,
} from "@tauri-apps/api/core";

type InvokeFunction = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

export async function askClaude(
  prompt: string,
  invokeFunction: InvokeFunction = invoke
): Promise<string> {
  const text = prompt.trim();

  if (!text) {
    throw new Error(
      "메시지가 비어 있습니다."
    );
  }

  const result =
    await invokeFunction(
      "ask_claude",
      {
        prompt: text,
      }
    );

  if (typeof result !== "string") {
    throw new Error(
      "Claude 응답 형식이 올바르지 않습니다."
    );
  }

  return result;
}
