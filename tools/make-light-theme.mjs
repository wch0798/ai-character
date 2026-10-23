// Builds src/theme-light.css from the dark design in src/styles.css and src/chat-extras.css.
//
// The app was designed dark, with colors written into hundreds of rules. Instead of inverting
// the whole panel with a CSS filter (which also flips pictures and looks washed out), every
// color gets a light counterpart: neutral greys swap brightness (dark backgrounds become light,
// light text becomes dark) while hue is kept, and accent colors (the blue send button, red stop,
// green progress) stay as they are, together with the text drawn on them. Shadows stay dark.
//
// Run after changing colors in those files:  node tools/make-light-theme.mjs
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SOURCES = ["src/styles.css", "src/chat-extras.css"];
const OUT = "src/theme-light.css";
const LIGHT = ':root[data-theme="light"]';

const COLOR_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline",
  "outline-color",
  "caret-color",
  "fill",
  "stroke",
  "text-decoration-color",
  "scrollbar-color",
  "-webkit-text-fill-color",
]);

const COLOR_RE = /rgba?\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)|#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\bwhite\b|\bblack\b/g;

function parseColor(text) {
  const t = text.toLowerCase();
  if (t === "white") return [255, 255, 255, 1];
  if (t === "black") return [0, 0, 0, 1];
  if (t.startsWith("#")) {
    let hex = t.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  const parts = t.replace(/rgba?\(|\)/g, "").split(/[\s,/]+/).filter(Boolean);
  const channel = (v) => (v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
}

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]) {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
}

/** Saturated mid-tone colors are accents (buttons, highlights, progress) and keep their color. */
function isAccent(rgba) {
  const [, s, l] = toHsl(rgba);
  return s >= 0.35 && l >= 0.3 && l <= 0.75;
}

function lightCounterpart(rgba) {
  const [h, s, l] = toHsl(rgba);
  let next;
  if (l >= 0.6) next = 0.12 + (1 - l) * 0.55; // light text and lines → dark text
  else if (l <= 0.4) next = 0.985 - l * 0.4; // dark surfaces → light surfaces
  else next = 1 - l;
  // Keep a hint of the original tint without turning greys into pastels.
  const [r, g, b] = fromHsl([h, Math.min(s, 0.35), next]);
  const a = rgba[3];
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

function mapValue(value, keepAccents) {
  return value.replace(COLOR_RE, (match) => {
    const rgba = parseColor(match);
    if (rgba[3] === 0) return match;
    if (keepAccents && isAccent(rgba)) return match;
    return lightCounterpart(rgba);
  });
}

/** A solid accent fill (the blue send button, the user's own bubble), not a faint tint. */
function hasAccentBackground(rule) {
  let accent = false;
  rule.walkDecls(/^background/, (decl) => {
    for (const match of decl.value.match(COLOR_RE) ?? []) {
      const rgba = parseColor(match);
      if (isAccent(rgba) && rgba[3] >= 0.6) accent = true;
    }
  });
  return accent;
}

function lightSelector(selector) {
  const s = selector.trim();
  if (s.startsWith(":root")) return s.replace(/^:root/, LIGHT);
  if (/^html\b/.test(s)) return s.replace(/^html/, `html[data-theme="light"]`);
  return `${LIGHT} ${s}`;
}

const output = postcss.root();
for (const file of SOURCES) {
  const css = fs.readFileSync(path.join(root, file), "utf8");
  const source = postcss.parse(css, { from: file });
  source.walkRules((rule) => {
    // Animations keep their frames; at-rules other than @media are left alone.
    let parent = rule.parent;
    const mediaChain = [];
    while (parent && parent.type !== "root") {
      if (parent.type === "atrule") {
        if (parent.name !== "media") return;
        mediaChain.unshift(parent);
      }
      parent = parent.parent;
    }
    const accentBackground = hasAccentBackground(rule);
    const changed = [];
    rule.each((node) => {
      if (node.type !== "decl" || !COLOR_PROPS.has(node.prop.toLowerCase())) return;
      // Text on an accent background (white on the blue send button) stays as designed.
      const keep = node.prop === "color" && accentBackground;
      const next = keep ? node.value : mapValue(node.value, true);
      if (next !== node.value) changed.push(node.clone({ value: next }));
    });
    // Its text color may come from another rule (.message sets it, .message.user paints blue):
    // on a solid accent the text stays white in both themes.
    const hasColor = rule.nodes.some((node) => node.type === "decl" && node.prop === "color");
    if (accentBackground && !hasColor) {
      changed.push(postcss.decl({ prop: "color", value: "rgb(255, 255, 255)" }));
    }
    if (!changed.length) return;
    const lightRule = postcss.rule({ selectors: rule.selectors.map(lightSelector) });
    lightRule.append(...changed);
    let target = output;
    for (const media of mediaChain) {
      const copy = postcss.atRule({ name: "media", params: media.params });
      target.append(copy);
      target = copy;
    }
    target.append(lightRule);
  });
}

const header =
  "/* Generated by tools/make-light-theme.mjs from styles.css and chat-extras.css — do not edit.\n" +
  "   Light counterparts of the dark design, applied when <html data-theme=\"light\">. */\n";
fs.writeFileSync(path.join(root, OUT), header + output.toString() + "\n");
console.log(`wrote ${OUT}`);
