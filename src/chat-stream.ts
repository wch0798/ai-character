import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderStreamEvent } from "./automatic-provider";

export const PROVIDER_STREAM_EVENT = "provider-stream";

/** Next visible text for a stream event addressed to `streamId`; other streams leave it unchanged. */
export function applyStreamEvent(current: string, event: ProviderStreamEvent, streamId: string): string {
  if (event.streamId !== streamId) return current;
  return event.reset ? "" : current + event.text;
}

export type LiveReply = { dispose(): void; hasText(): boolean; repaint(): void };

/**
 * Shows partial answer text in a temporary assistant bubble while a provider streams.
 * The caller removes it (dispose) before posting the final, saved reply.
 */
export function startLiveReply(
  streamId: string,
  options: {
    messages: HTMLElement;
    render(target: HTMLElement, text: string): void;
    onFirstText?(): void;
    onUpdate?(): void;
    /** False while another conversation is on screen: the text keeps arriving but isn't drawn. */
    isVisible?(): boolean;
  }
): LiveReply {
  let text = "";
  let bubble: HTMLDivElement | null = null;
  let content: HTMLDivElement | null = null;
  let frame = 0;
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  const paint = () => {
    frame = 0;
    if (disposed) return;
    // Switching conversations redraws the message list, which detaches the bubble.
    if (bubble && !bubble.isConnected) {
      bubble = null;
      content = null;
    }
    if (options.isVisible && !options.isVisible()) {
      bubble?.remove();
      bubble = null;
      content = null;
      return;
    }
    if (!text) {
      bubble?.remove();
      bubble = null;
      content = null;
      return;
    }
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "message assistant is-streaming";
      content = document.createElement("div");
      content.className = "message-text message-md";
      bubble.append(content);
      options.messages.querySelector(".chat-welcome")?.remove();
      options.messages.append(bubble);
      options.onFirstText?.();
    }
    if (content) {
      content.replaceChildren();
      options.render(content, text);
    }
    options.onUpdate?.();
  };

  void listen<ProviderStreamEvent>(PROVIDER_STREAM_EVENT, (event) => {
    const next = applyStreamEvent(text, event.payload, streamId);
    if (next === text || disposed) return;
    text = next;
    if (!frame) frame = window.requestAnimationFrame(paint);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);

  return {
    hasText: () => text.length > 0,
    repaint() {
      if (!frame && !disposed) frame = window.requestAnimationFrame(paint);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      unlisten?.();
      bubble?.remove();
    },
  };
}
