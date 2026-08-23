import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWLIST = ["MeerkatAI", "MAPID", "API", "Webhook", "Harness", "token", "GitHub", "Markdown", "PDF", "DOCX", "PPTX", "Excel", "web UI", "Gmail unread digest", "GitLab CI watch", "path: value1, value2"];

const AGENT_BOUND_WRAPPERS = ["prompt"];

const CODE_VALUE_PAIRS = new Set(["true", "false", "enable", "disable", "on", "off", "yes", "no", "get", "post", "put", "patch", "delete", "manage", "view"]);

const ENGLISH_RUN = /[A-Za-z][A-Za-z'&.-]*(?:\s+[A-Za-z][A-Za-z'&.-]*)+/;
const ENGLISH_WORD = /[A-Za-z]{2,}/;

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "locale") continue;
      out.push(...collectFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripWrapped(src, wrappers) {
  let out = src;
  for (const w of wrappers) {
    const re = new RegExp(`\\b${w}\\(\\s*("[^"]*"|'[^']*'|\`[^\`]*\`)`, "g");
    out = out.replace(re, "");
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
}

function stripNoise(s) {
  let out = s.replace(/\$\{[^}]*/g, " ");
  for (const term of ALLOWLIST) out = out.split(term).join(" ");
  return out;
}

function looksEnglish(s, needRun) {
  const cleaned = stripNoise(s).trim();
  if (!cleaned) return false;
  return needRun ? ENGLISH_RUN.test(cleaned) : ENGLISH_WORD.test(cleaned);
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
  return line;
}

function findTemplateEnd(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") i += 2;
    else if (ch === "`") return i;
    else if (ch === "$" && src[i + 1] === "{") {
      i = findInterpolationEnd(src, i + 2);
    } else i++;
  }
  return src.length;
}

function findInterpolationEnd(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "\\") i += 2;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "`") i = findTemplateEnd(src, i + 1);
    else if (ch === '"' || ch === "'") i = findStringEnd(src, i + 1, ch);
    else if (ch === "/" && regexAllowedAt(src, i)) i = findRegexEnd(src, i + 1);
    i++;
  }
  return i - 1;
}

function findStringEnd(src, start, quote) {
  let i = start;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === quote) return i;
    else i++;
  }
  return src.length;
}

function regexAllowedAt(src, index) {
  let j = index - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--;
  if (j < 0) return true;
  return "(=,:!&|?{}[];+-*%<>~^".includes(src[j]);
}

function findRegexEnd(src, start) {
  let i = start;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") i += 2;
    else if (ch === "[") {
      inClass = true;
      i++;
    } else if (ch === "]") {
      inClass = false;
      i++;
    } else if (ch === "/" && !inClass) return i;
    else if (ch === "\n") return i;
    else i++;
  }
  return i;
}

function* templateRegions(src) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = findStringEnd(src, i + 1, ch) + 1;
    } else if (ch === "`") {
      yield* templateBody(src, i);
      i = findTemplateEnd(src, i + 1) + 1;
    } else if (ch === "/" && regexAllowedAt(src, i)) {
      i = findRegexEnd(src, i + 1) + 1;
    } else i++;
  }
}

function* templateBody(src, backtick) {
  let segStart = backtick + 1;
  let i = segStart;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") i += 2;
    else if (ch === "`") {
      yield { start: segStart, end: i };
      return;
    } else if (ch === "$" && src[i + 1] === "{") {
      yield { start: segStart, end: i };
      const bodyStart = i + 2;
      const bodyEnd = findInterpolationEnd(src, bodyStart);
      yield* interpolationRegions(src, bodyStart, bodyEnd);
      i = bodyEnd + 1;
      segStart = i;
    } else i++;
  }
}

function* interpolationRegions(src, start, end) {
  yield { start, end, interp: true };
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = findStringEnd(src, i + 1, ch) + 1;
    } else if (ch === "`") {
      yield* templateBody(src, i);
      i = findTemplateEnd(src, i + 1) + 1;
    } else if (ch === "/" && regexAllowedAt(src, i)) {
      i = findRegexEnd(src, i + 1) + 1;
    } else i++;
  }
}

function* snippetsOf(src) {
  for (const region of templateRegions(src)) {
    const raw = src.slice(region.start, region.end);
    if (region.interp) {
      for (const m of raw.matchAll(/\?\s*"([A-Za-z][A-Za-z'&.-]*)"\s*:\s*"([A-Za-z][A-Za-z'&.-]*)"/g)) {
        if (CODE_VALUE_PAIRS.has(m[1].toLowerCase()) && CODE_VALUE_PAIRS.has(m[2].toLowerCase())) continue;
        yield { index: region.start + m.index, snippet: m[0].slice(0, 80) };
      }
      continue;
    }
    const text = raw.replace(/<[^>]*>/g, " ").replace(/^[^<]*>/, " ").replace(/<[^>]*$/, " ");
    if (looksEnglish(text, true)) {
      yield { index: region.start, snippet: text.trim().replace(/\s+/g, " ").slice(0, 80) };
    }
    for (const m of raw.matchAll(/(?:title|placeholder|aria-label|label)="([^"]*)"/g)) {
      if (looksEnglish(m[1], false)) {
        yield { index: region.start + m.index, snippet: m[0].slice(0, 80) };
      }
    }
  }
  for (const m of src.matchAll(/(?:confirm|alert)\(\s*"([^"]*)"/g)) {
    if (looksEnglish(m[1], false)) yield { index: m.index, snippet: m[0].slice(0, 80) };
  }
  for (const m of src.matchAll(/throw\s+new\s+Error\(\s*("([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (looksEnglish(value, false)) yield { index: m.index, snippet: m[0].slice(0, 80) };
  }
}

function scanFile(file, wrappers, baseDir) {
  const src = stripComments(stripWrapped(readFileSync(file, "utf8"), [...wrappers, ...AGENT_BOUND_WRAPPERS]));
  const hits = [];
  for (const { index, snippet } of snippetsOf(src)) {
    hits.push(`${relative(baseDir, file)}:${lineOf(src, index)}: ${snippet}`);
  }
  return hits;
}

const arg = process.argv[2];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webUiRoot = join(scriptDir, "..");

let files;
let wrappers;
let baseDir;
if (arg) {
  files = [resolve(process.cwd(), arg)];
  wrappers = ["t"];
  baseDir = process.cwd();
} else {
  const srcDir = join(webUiRoot, "src");
  files = collectFiles(srcDir);
  wrappers = ["i18n", "tr"];
  baseDir = webUiRoot;
}

const hits = files.flatMap((f) => scanFile(f, wrappers, baseDir));
for (const hit of hits) console.log(hit);
console.log(`check-untranslated: ${hits.length} suspect string(s) in ${files.length} file(s)`);
process.exit(hits.length > 0 ? 1 : 0);
