import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isValidSkillName } from "../src/skill-name.ts";

const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("accepts Claude-style skill names", () => {
  for (const name of ["a", "x".repeat(64), "watch-pipeline", "triz-40-principles", "skill2", "a-b-c"]) {
    assert.equal(isValidSkillName(name), true, name);
  }
});

test("rejects names outside the strict ASCII rule", () => {
  const rejected = [
    "",
    "x".repeat(65),
    "中文技能",
    "Watch-Pipeline",
    "watch_pipeline",
    "watch.pipeline",
    "watch pipeline",
    "-watch",
    "watch-",
    "watch--pipeline",
    "-",
  ];
  for (const name of rejected) {
    assert.equal(isValidSkillName(name), false, name);
  }
});

test("create form gates the submit on the strict name rule and explains it inline", () => {
  const pane = bodyOf("creatorPane");
  assert.match(pane, /const nameInvalid = name !== "" && !isValidSkillName\(name\);/);
  assert.match(pane, /const ready = !nameInvalid && name !== "" && c\.description\.trim\(\) !== "" && c\.body\.trim\(\) !== "";/);
  assert.match(
    pane,
    /nameInvalid \? html`<small class="card-meta skill-name-hint">\$\{i18n\("1-64 lowercase letters, digits, and hyphens; no leading, trailing, or consecutive hyphens\."\)\}<\/small>` : nothing/,
  );
  assert.match(
    bodyOf("saveCreate"),
    /if \(!isValidSkillName\(name\) \|\| !description \|\| !body\) \{/,
  );
});
