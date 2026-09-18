import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("src/styles.css", "utf8");

function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

check(!css.includes("\\n"), "CSS has no literal escaped newlines");

const toolbar = html.match(
  /<div id="chat-history-toolbar">([\s\S]*?)<\/div>/
)?.[1] ?? "";
check(toolbar.includes('id="chat-history-button"'), "toolbar has conversation button");
check(toolbar.includes('id="new-chat-button"'), "toolbar has new-chat button");
check(!toolbar.includes('id="chat-active-title"'), "toolbar stays clean without active title clutter");
check(html.includes('class="chat-toolbar-start"'), "toolbar groups conversation actions");
check(html.includes('class="chat-toolbar-end"'), "toolbar groups settings and close");
check(html.includes('id="chat-history-drawer-title"'), "drawer has a clear title");
check(html.includes('id="chat-history-search"'), "drawer has search");
check(html.includes('id="chat-history-list"'), "drawer has conversation list");
check(html.includes('id="chat-history-delete-all"'), "drawer has delete-all control");

if (process.exitCode) process.exit(process.exitCode);
