import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWLIST = ["MeerkatAI", "MAPID", "API", "Webhook", "Harness", "token", "GitHub", "Markdown", "PDF", "DOCX", "PPTX", "Excel"];

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

function stripWrapped(line, wrappers) {
  let out = line;
  for (const w of wrappers) {
    const re = new RegExp(`\\b${w}\\(\\s*("[^"]*"|'[^']*'|\`[^\`]*\`)`, "g");
    out = out.replace(re, "");
  }
  return out;
}

function stripNoise(s) {
  let out = s.replace(/\$\{[^}]*\}/g, " ");
  for (const term of ALLOWLIST) out = out.split(term).join(" ");
  return out;
}

function looksEnglish(s, needRun) {
  const cleaned = stripNoise(s).trim();
  if (!cleaned) return false;
  return needRun ? ENGLISH_RUN.test(cleaned) : ENGLISH_WORD.test(cleaned);
}

function* snippetsOf(line) {
  for (const m of line.matchAll(/>([^<>]+)</g)) {
    if (looksEnglish(m[1], true)) yield m[1].trim().replace(/\s+/g, " ").slice(0, 80);
  }
  for (const m of line.matchAll(/(?:title|placeholder|aria-label|label)="([^"]*)"/g)) {
    if (looksEnglish(m[1], false)) yield `${m[0].slice(0, 80)}`;
  }
  for (const m of line.matchAll(/(?:confirm|alert)\(\s*"([^"]*)"/g)) {
    if (looksEnglish(m[1], false)) yield m[0].slice(0, 80);
  }
  for (const m of line.matchAll(/throw\s+new\s+Error\(\s*("([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (looksEnglish(value, false)) yield m[0].slice(0, 80);
  }
}

function scanFile(file, wrappers, baseDir) {
  const hits = [];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const line = stripWrapped(raw, wrappers);
    for (const snippet of snippetsOf(line)) {
      hits.push(`${relative(baseDir, file)}:${i + 1}: ${snippet}`);
    }
  });
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
