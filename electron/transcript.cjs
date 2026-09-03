// 终端实录清洗:把 claude TUI 的装饰性行(欢迎横幅/状态栏/分隔线/纯装饰符号)滤掉,
// 保留可读的对话正文。由 pty.cjs 落盘时与 ai-summary 前调用,纯函数。
//
// 清洗规则(保守,宁可多留不可误删真实内容):
//  1. 去行尾空白、跳过空行
//  2. 保留时间分隔头("[ --- 终端实录 ... --- ]")
//  3. 丢弃 TUI 横幅/状态栏特征行(版本号、API/effort/permission/manual/快捷键提示等)
//  4. 丢弃纯分隔线 / 装饰符号占多数的行
//  5. 合并连续空行为单个空行,压缩空白

// 状态栏/横幅特征关键字(整行命中任一即丢弃)
const BANNER_RE =
  /Claude Code\s*v?\d|API Usage|Cost:\s*\$|effort|manual mode|for shortcuts|Ctrl\+R|for\s+tools|·\s*\/|## Session|agent|Model:\s*|Input:\s*|Output:\s*/i;
// 纯装饰符号集合(盒线/方块画/状态图标)
const DECO = /[────━━━–—│┃┌┐└┘├┤┬┴┼║╔╗╚╝▐▛▝▜▀▁▂▃▄▅▆▇█░▒▓◉⏸✳✻✱⭘⟩]/;

module.exports = { cleanTranscript };

function cleanTranscript(text) {
  const out = [];
  let lastBlank = false;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/g, "");
    const t = line.trim();
    if (!t) {
      if (!lastBlank && out.length) {
        out.push("");
        lastBlank = true;
      }
      continue;
    }
    // 时间分隔头保留
    if (t.startsWith("[ --- 终端实录")) {
      out.push(t);
      lastBlank = false;
      continue;
    }
    // 横幅/状态栏特征行丢弃
    if (BANNER_RE.test(t)) {
      lastBlank = false;
      continue;
    }
    // 纯分隔线丢弃
    if (/^[─━=－–—•·\s]+$/.test(t)) continue;
    // 装饰符号占多数的行丢弃(保留 ❯ 提示行:去掉提示符后看剩余内容)
    const decoCount = (t.match(DECO) || []).length;
    if (decoCount > Math.max(3, t.length * 0.4)) continue;
    out.push(t);
    lastBlank = false;
  }
  // 头尾去空行,合并的连续空行控制在一行
  let s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // 行首 ❯ 提示符统一为「❯ 」,方便展示层识别用户输入
  return s;
}
