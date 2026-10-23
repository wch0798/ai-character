import {
  invoke,
} from "@tauri-apps/api/core";

type StageInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<string>;

type RemoveInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<void>;

export async function stageAttachment(
  path: string,
  invokeFunction: StageInvoke =
    (command, args) =>
      invoke<string>(
        command,
        args
      )
): Promise<string> {
  return invokeFunction(
    "stage_attachment",
    { path }
  );
}

export async function removeStagedAttachment(
  path: string,
  invokeFunction: RemoveInvoke =
    (command, args) =>
      invoke<void>(
        command,
        args
      )
): Promise<void> {
  await invokeFunction(
    "remove_staged_attachment",
    { path }
  );
}

/** Saves a screenshot pasted with Ctrl+V to a temp file and returns its path. */
export async function savePastedImage(blob: Blob): Promise<string> {
  // Sent as the raw body: a JSON array of numbers would be about four times the image size.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return invoke<string>("save_pasted_image", bytes, { headers: { "x-mime": blob.type } });
}
