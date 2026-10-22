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
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return invoke<string>("save_pasted_image", { bytes, mime: blob.type });
}
