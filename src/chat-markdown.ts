export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; lines: Inline[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; lines: Inline[][] }
  | { type: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

export type TableAlign = "left" | "center" | "right";

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) {
      result.push({ type: "text", text: text.slice(last, index) });
    }
    const [whole, code, bold, link, linkHref, bare] = match;
    if (code) {
      result.push({ type: "code", text: code.slice(1, -1) });
    } else if (bold) {
      result.push({ type: "bold", children: parseInline(bold.slice(2, -2)) });
    } else if (link && linkHref && isSafeHref(linkHref)) {
      result.push({ type: "link", text: link.slice(1, link.indexOf("](")), href: linkHref });
    } else if (bare && isSafeHref(bare)) {
      result.push({ type: "link", text: bare, href: bare });
    } else {
      result.push({ type: "text", text: whole });
    }
    last = index + whole.length;
  }
  if (last < text.length) {
    result.push({ type: "text", text: text.slice(last) });
  }
  return result;
}

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.+)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of a `| a | b |` row; `\|` stays a literal bar inside a cell. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next) && next.includes("-")
    && splitTableRow(line).length === splitTableRow(next).length;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(FENCE);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (isTableStart(line, lines[index + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const align = splitTableRow(lines[index + 1]).map((cell): TableAlign =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"
      );
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const cells = splitTableRow(lines[index]);
        // Pad or trim so every row has the header's column count.
        rows.push(header.map((_, column) => parseInline(cells[column] ?? "")));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", align, header: header.map((cell) => parseInline(cell)), rows });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2].trim()) });
      continue;
    }
    const bullet = line.match(BULLET);
    const ordered = bullet ? null : line.match(ORDERED);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const item = parseInline((bullet ?? ordered)![1]);
      const previous = blocks[blocks.length - 1];
      if (previous?.type === "list" && previous.ordered === isOrdered) {
        previous.items.push(item);
      } else {
        blocks.push({ type: "list", ordered: isOrdered, items: [item] });
      }
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      const inline = parseInline(quote[1]);
      if (previous?.type === "quote") {
        previous.lines.push(inline);
      } else {
        blocks.push({ type: "quote", lines: [inline] });
      }
      continue;
    }
    paragraph.push(parseInline(line));
  }
  flushParagraph();
  return blocks;
}

export type MarkdownHandlers = {
  openLink(href: string): void;
  copy(text: string): Promise<void>;
};

function appendInline(parent: HTMLElement, inline: Inline[], handlers: MarkdownHandlers): void {
  for (const node of inline) {
    if (node.type === "text") {
      parent.append(document.createTextNode(node.text));
    } else if (node.type === "code") {
      const code = document.createElement("code");
      code.textContent = node.text;
      parent.append(code);
    } else if (node.type === "bold") {
      const strong = document.createElement("strong");
      appendInline(strong, node.children, handlers);
      parent.append(strong);
    } else {
      const link = document.createElement("a");
      link.href = node.href;
      link.textContent = node.text;
      link.title = node.href;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handlers.openLink(node.href);
      });
      parent.append(link);
    }
  }
}

function appendLines(parent: HTMLElement, lines: Inline[][], handlers: MarkdownHandlers): void {
  lines.forEach((line, index) => {
    if (index > 0) {
      parent.append(document.createElement("br"));
    }
    appendInline(parent, line, handlers);
  });
}

function codeBlock(block: Extract<Block, { type: "code" }>, handlers: MarkdownHandlers): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "md-code";
  const header = document.createElement("div");
  header.className = "md-code-header";
  const lang = document.createElement("span");
  lang.textContent = block.lang || "코드";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "md-code-copy";
  copy.textContent = "복사";
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void handlers.copy(block.text).then(() => {
      copy.textContent = "복사됨";
      window.setTimeout(() => {
        copy.textContent = "복사";
      }, 1000);
    });
  });
  header.append(lang, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.text;
  pre.append(code);
  wrapper.append(header, pre);
  return wrapper;
}

function tableBlock(block: Extract<Block, { type: "table" }>, handlers: MarkdownHandlers): HTMLElement {
  // Wrapped so a wide table scrolls sideways inside the narrow chat bubble.
  const wrapper = document.createElement("div");
  wrapper.className = "md-table-wrap";
  const table = document.createElement("table");
  table.className = "md-table";
  const cell = (tag: "th" | "td", inline: Inline[], column: number): HTMLElement => {
    const element = document.createElement(tag);
    element.style.textAlign = block.align[column] ?? "left";
    appendInline(element, inline, handlers);
    return element;
  };
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  block.header.forEach((inline, column) => headRow.append(cell("th", inline, column)));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    row.forEach((inline, column) => tr.append(cell("td", inline, column)));
    body.append(tr);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

/** Builds DOM nodes only (never innerHTML), so model output cannot inject markup. */
export function renderMarkdown(source: string, handlers: MarkdownHandlers): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    if (block.type === "paragraph") {
      const p = document.createElement("p");
      appendLines(p, block.lines, handlers);
      fragment.append(p);
    } else if (block.type === "code") {
      fragment.append(codeBlock(block, handlers));
    } else if (block.type === "heading") {
      const heading = document.createElement(`h${Math.min(6, block.level + 2)}`);
      appendInline(heading, block.inline, handlers);
      fragment.append(heading);
    } else if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        appendInline(li, item, handlers);
        list.append(li);
      }
      fragment.append(list);
    } else if (block.type === "table") {
      fragment.append(tableBlock(block, handlers));
    } else if (block.type === "rule") {
      fragment.append(document.createElement("hr"));
    } else {
      const quote = document.createElement("blockquote");
      appendLines(quote, block.lines, handlers);
      fragment.append(quote);
    }
  }
  return fragment;
}
