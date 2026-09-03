// 由 claude 模型名估算上下文 token 上限(与 electron/claude.cjs 保持一致):
// 普通模型按 200k(Claude Code 默认窗口),1M 长上下文模型按 1M
export function contextLimitOf(model) {
  const m = String(model || "").toLowerCase();
  return m.includes("1m") || m.includes("long") ? 1000000 : 200000;
}

// 千分位量级缩写:1234 -> 1.2k
export function fmtNum(n) {
  if (Number.isFinite(n) && n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (Number.isFinite(n) && n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
