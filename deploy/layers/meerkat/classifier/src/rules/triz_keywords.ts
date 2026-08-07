const TRIZ_KEYWORDS = [
  "矛盾矩阵", "技术矛盾", "物理矛盾", "技术进化", "技术系统进化",
  "物场模型", "物场分析", "发明原理", "分离原理", "理想解",
  "最终理想解", "IFR", "技术进化趋势", "进化法则", "S曲线",
  "TRIZ", "triz", "ARIZ", "功能分析", "裁剪", "trimming",
  "九屏幕法", "九窗口", "小人法", "金鱼法", "STC算子",
  "资源分析", "系统算子", "功能模型", "因果分析", "根本原因分析",
];

export function detectTrizKeywords(text: string): { level: "L3"; domain: "triz"; reason: string } | null {
  const lower = text.toLowerCase();
  for (const kw of TRIZ_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return { level: "L3", domain: "triz", reason: `triz_kw:${kw}` };
  }
  return null;
}
