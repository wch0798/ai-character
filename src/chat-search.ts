export type TextPart = { text: string; match: boolean };

export type ConversationMatch = {
  count: number;
  snippet: TextPart[] | null;
};

function normalize(value: string): string {
  return value.toLocaleLowerCase();
}

/** Splits `text` into alternating plain/matching parts (case-insensitive). */
export function splitMatches(text: string, query: string): TextPart[] {
  const needle = normalize(query.trim());
  const haystack = normalize(text);
  if (!needle || haystack.length !== text.length) {
    return [{ text, match: false }];
  }
  const parts: TextPart[] = [];
  let cursor = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, cursor)) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}

export function countMatches(text: string, query: string): number {
  return splitMatches(text, query).filter((part) => part.match).length;
}

/** A short window of text around the first match, with ellipses where it was cut. */
export function snippetAround(text: string, query: string, radius = 28): TextPart[] | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const needle = normalize(query.trim());
  const index = normalize(flat).indexOf(needle);
  if (!needle || index === -1) {
    return null;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + needle.length + radius);
  const parts = splitMatches(flat.slice(start, end), query);
  if (start > 0) parts.unshift({ text: "…", match: false });
  if (end < flat.length) parts.push({ text: "…", match: false });
  return parts;
}

/** Match count across a conversation's messages and a snippet from the first matching one. */
export function matchConversation(messages: ReadonlyArray<{ content: string }>, query: string): ConversationMatch {
  let count = 0;
  let snippet: TextPart[] | null = null;
  for (const message of messages) {
    const hits = countMatches(message.content, query);
    if (hits > 0) {
      count += hits;
      snippet ??= snippetAround(message.content, query);
    }
  }
  return { count, snippet };
}

/** Cycles through `total` results; `step` is +1 / -1. */
export function stepIndex(current: number, step: number, total: number): number {
  if (total <= 0) return -1;
  return (((current + step) % total) + total) % total;
}

export function appendParts(target: HTMLElement, parts: TextPart[], markClass: string): void {
  for (const part of parts) {
    if (part.match) {
      const mark = document.createElement("mark");
      mark.className = markClass;
      mark.textContent = part.text;
      target.append(mark);
    } else {
      target.append(document.createTextNode(part.text));
    }
  }
}

/** Wraps every match inside the message texts with `<mark>`; returns the marks in document order. */
export function highlightMessages(root: HTMLElement, query: string): HTMLElement[] {
  clearHighlights(root);
  if (!query.trim()) return [];
  const textNodes: Text[] = [];
  for (const container of root.querySelectorAll<HTMLElement>(".message-text")) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textNodes.push(node as Text);
    }
  }
  for (const node of textNodes) {
    const parts = splitMatches(node.data, query);
    if (!parts.some((part) => part.match)) continue;
    const fragment = document.createElement("span");
    appendParts(fragment, parts, "chat-find-hit");
    node.replaceWith(...fragment.childNodes);
  }
  return [...root.querySelectorAll<HTMLElement>("mark.chat-find-hit")];
}

export function clearHighlights(root: HTMLElement): void {
  for (const mark of root.querySelectorAll<HTMLElement>("mark.chat-find-hit")) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  root.normalize();
}
