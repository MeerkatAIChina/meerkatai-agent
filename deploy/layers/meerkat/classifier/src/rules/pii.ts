const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{15}(?:\d{2}[\dxX])?\b/, label: "cn_id_card" },
  { pattern: /\b1[3-9]\d{9}\b/, label: "cn_phone" },
  { pattern: /\b\d{16,19}\b/, label: "bank_card" },
  { pattern: /[\w.-]+@[\w.-]+\.\w{2,}/, label: "email" },
  { pattern: /[路街巷]\s*\d{1,6}号/, label: "cn_address" },
];

export function detectPii(text: string): { level: "L1"; reason: string } | null {
  for (const { pattern, label } of PII_PATTERNS) {
    if (pattern.test(text)) return { level: "L1", reason: `pii:${label}` };
  }
  return null;
}
