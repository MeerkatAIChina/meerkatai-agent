import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPii } from "./pii.ts";

test("detects phone number", () => {
  assert.strictEqual(detectPii("请联系 13800138000")?.reason, "pii:cn_phone");
});
test("detects ID card", () => {
  assert.strictEqual(detectPii("身份证 320102199001011234")?.reason, "pii:cn_id_card");
});
test("detects bank card", () => {
  assert.strictEqual(detectPii("卡号 6222021234567890123")?.reason, "pii:bank_card");
});
test("detects email", () => {
  assert.strictEqual(detectPii("test@example.com")?.reason, "pii:email");
});
test("detects address with street number", () => {
  assert.strictEqual(detectPii("中山路 100号")?.reason, "pii:cn_address");
});
test("does not match common words", () => {
  assert.strictEqual(detectPii("市区重建计划"), null);
});
test("returns null for clean text", () => {
  assert.strictEqual(detectPii("今天天气很好"), null);
});
