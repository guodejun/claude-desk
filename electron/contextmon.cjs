// 上下文监控:给会话算「已用 token / 窗口上限」,供工具面板底部常显。
// 数据源：
//   1. 精确优先 —— 读 Claude Code 的会话 jsonl(~/.claude/projects/<cwd-slug>/<sessionId>.jsonl)
//      usage(input/output/cache)。但实测:桌面应用 attach 的 claude CLI 会话 usage 要么不写、
//      要么全程恒定(占位假值,如 19013/266 永远不变),只有 SDK 会话写真实值。
//      → usage 只有「历史出现过变化」(varying)才信;恒定即假值,改走估算。
//   2. 估算兜底 —— 统计该 jsonl 里最后一个压缩标记之后的**真实消息文本字符量**
//      (user/assistant/thinking/tool),按「约 1/3 token 每字符 + 系统开销约 35K」折算。
//      校准依据:同一 SDK 会话真实 input=93.5K 时 jsonl 文本 174K 字符
//      (0.54 token/字符,中文英文混合),且真实光标处系统开销≈35K,故取 ch/3+35K。
//      文本量来自 claude 自己的会话记录,随对话真实增长;compact 之后只统计压缩标记
//      之后的消息,估算随摘要自然回落 —— 能真实反映 claude 的自动压缩。
// 窗口上限按最近捕获的模型名映射,默认 200k。
const fs = require("fs");
const path = require("path");
const os = require("os");
const persistence = require("./persistence.cjs");
const log = require("./log.cjs");

// 估算:约 1/3 token/字符(中英混合) + 系统提示/工具预置开销
const CH_TOK = 3;
const SYS_TOK = 35000;

// cwd -> ~/.claude/projects/<slug>:Claude Code 的项目目录名 = 绝对路径去掉前导 / 后把
// / 换成 -,前面再补一个 -(验证:/media/wanji/... → -media-wanji-...)
function projectDirOf(cwd) {
  let s = String(cwd || "").replace(/^\/+/, "");
  if (!s) s = os.homedir().replace(/^\/+/, "");
  return path.join(os.homedir(), ".claude", "projects", "-" + s.replace(/\//g, "-"));
}

// 某 cwd 的「可能落 jsonl 的 slug 目录」列表:cwd 自身 slug + 向上各级 git 根的 slug。
// 实测 attach 的 claude 会把项目 jsonl 写在非 cwd slug 的目录(如父级 git 根),
// 捕获 session id / 列候选 session 时须一并扫描,但又不做全盘扫(会命中其它项目会话)。
function projectDirsOf(cwd) {
  const dirs = [];
  const seen = new Set();
  const push = (d) => {
    const p = projectDirOf(d);
    if (!seen.has(p)) { seen.add(p); dirs.push(p); }
  };
  let cur = path.resolve(String(cwd || "") || os.homedir());
  push(cur);
  const home = path.resolve(os.homedir());
  // 向上找含 .git 的祖先目录(含 cwd 本身),最多走到 home,每层都补一个 slug
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".git"))) push(cur);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur || cur === home || parent.length < home.length) break;
    cur = parent;
  }
  return dirs;
}

// 路径比较规范化:统一 / 分隔、去尾斜杠(Win 上 claude 记的 cwd 可能是 \ 分隔)
function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// 从 jsonl 头部提取 claude 记录的启动目录(除 summary 行外各行基本都带 cwd 字段)。
// 这是判断「文件属于哪个项目」的最可靠依据,胜过猜 slug 目录名:
// Win 上 slug 规则不同(盘符/反斜杠),且 attach 会话会把 jsonl 落父级 git 根 slug。
const cwdCache = new Map(); // file -> { at, cwd }:mtime 不变直接复用,避免列候选时反复读盘
function cwdOfJsonl(file, at) {
  const c = cwdCache.get(file);
  if (c && c.at === at) return c.cwd;
  let cwd = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString("utf8").split("\n")) {
      if (!line || line.indexOf('"cwd"') < 0) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === "string" && o.cwd) {
          cwd = o.cwd;
          break;
        }
      } catch {}
    }
  } catch {}
  cwdCache.set(file, { at, cwd });
  if (cwdCache.size > 3000) cwdCache.delete(cwdCache.keys().next().value); // 简易 LRU 防胀
  return cwd;
}

// 某 cwd 的 claude 会话文件全量列表:[{ id, file, at }] 按 mtime 倒序。
// 查找范围:slug 目录快路径(projectDirsOf);全部不存在时(如 Win slug 规则不符)回退为
// 扫 projects 下所有目录、用目录内最新 jsonl 的 cwd 字段认领整目录。所有文件最终逐个按
// cwd 字段校验 == 本 cwd —— git 根 slug 目录会混同根下其它子项目的会话,必须过滤。
function sessionFilesOf(cwd) {
  const target = normPath(path.resolve(String(cwd || "") || os.homedir()));
  const dirs = [];
  for (const d of projectDirsOf(cwd)) {
    try {
      if (fs.existsSync(d)) dirs.push(d);
    } catch {}
  }
  if (!dirs.length) {
    const root = path.join(os.homedir(), ".claude", "projects");
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      // 目录归属判定:取最新一个 jsonl 读 cwd(同 slug 目录的会话同属一个项目路径)
      let newest = "";
      let newestAt = -1;
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        let at = 0;
        try {
          at = fs.statSync(path.join(dir, n)).mtimeMs;
        } catch {
          continue;
        }
        if (at > newestAt) {
          newestAt = at;
          newest = n;
        }
      }
      if (newest && normPath(cwdOfJsonl(path.join(dir, newest), newestAt)) === target) dirs.push(dir);
    }
  }
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = path.join(dir, n);
      let at = 0;
      try {
        at = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (normPath(cwdOfJsonl(p, at)) !== target) continue; // 同 slug 目录里其它子项目的会话,剔除
      out.push({ id: n.slice(0, -".jsonl".length), file: p, at });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// 找某会话的 jsonl:
//   1) cwd slug 目录内 <claudeSessionId>.jsonl(精确)
//   2) 全盘精确找 <claudeSessionId>.jsonl —— 实测 attach 会话的 claude 可能把项目
//      jsonl 写在非 cwd slug 的目录(如父级 git 根),只要知道 id 就能从全盘定位
//   3) cwd slug 目录内最近修改的 jsonl(运行中的当前会话,尚无 id)
//   4) 兜底:全 ~/.claude/projects/*/ 里最近修改的 jsonl
function findSessionJsonl(id, s) {
  const dir = projectDirOf(s.cwd);
  if (s.claudeSessionId) {
    const p = path.join(dir, s.claudeSessionId + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  if (s.claudeSessionId) {
    const hit = findJsonlById(s.claudeSessionId);
    if (hit) return hit;
  }
  const inDir = latestJsonl(dir);
  if (inDir) return inDir;
  return findNewestAnywhere();
}

// 全盘精确找 <id>.jsonl
function findJsonlById(id) {
  try {
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith(".")) continue;
      const p = path.join(base, d, id + ".jsonl");
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {
    // 找不到 jsonl 会让消息提取/云上行静默跳过,故非目录不存在(ENOENT)的异常要记日志
    if (e && e.code !== "ENOENT") log.log("warn", `contextmon 查找 jsonl 失败: ${id} :: ${e.message}`);
  }
  return null;
}

// 全盘最近修改的 jsonl(多会话并存时优先不是它,兜底用)
function findNewestAnywhere() {
  let best = null, bt = 0;
  try {
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith(".")) continue;
      const p = latestJsonl(path.join(base, d));
      if (p && p.mt > bt) { best = p.f; bt = p.mt; }
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") log.log("warn", `contextmon 全盘扫描 jsonl 失败 :: ${e.message}`);
  }
  return best;
}

function latestJsonl(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: path.join(dir, f), mt: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    return files[0] || null;
  } catch (e) {
    // 目录不存在(ENOENT)是常态,静默;其余(权限等)才记日志
    if (e && e.code !== "ENOENT") log.log("warn", `contextmon 读取 jsonl 目录失败: ${dir} :: ${e.message}`);
    return null;
  }
}

// 模型名 -> 上下文窗口上限。优先解析模型名里方括号带的窗口标记(Claude Code 模型名形如
// glm-5.2-cc[1m] / model[240k] / model[200000],方括号内即上下文窗口),读不到再按
// 已知大窗口系列名称(4-6 等)推测,缺省 200k
function maxOf(model) {
  const m = String(model || "").toLowerCase();
  const t = /\[(\d+(?:\.\d+)?)([kmg]?)\]/.exec(m);
  if (t) {
    const n = parseFloat(t[1]);
    const u = (t[2] || "").toLowerCase();
    if (u === "m") return Math.round(n * 1_000_000);
    if (u === "g") return Math.round(n * 1_000_000_000);
    if (u === "k") return Math.round(n * 1000);
    return Math.round(n); // 无单位:方括号内是裸 token 数
  }
  // 兼容已知大窗口系列名称(opus-4-6 / sonnet-4-6 等 1M 档)
  if (/opus-4-6|sonnet-4-6|4-6/.test(m)) return 1_000_000;
  return 200_000;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

// 消息 content -> 文本字符数(兼容字符串与数组两种形态;array 里 text/thinking/tool 分别计)
function textLen(d, m) {
  const c = m && m.content;
  if (!c) return 0;
  if (typeof c === "string") {
    return d === "assistant" ? c.length : c.length;
  }
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) {
    if (!b) continue;
    if (b.type === "text") n += String(b.text || "").length;
    else if (b.type === "thinking") n += String(b.text || "").length;
    else if (b.type === "tool_result") n += String(b.content || "").length;
  }
  return n;
}

// 扫 jsonl:返回 usage 可信度 + 「最后一个压缩标记之后」的消息文本字符量。
// usage 口径 = 每轮请求输入的实际 token(快照,真实会话会随上下文增长)。
// varying = 历史中出现过 ≥2 个不同 input(真值);全程恒定 = 占位假值,上层转估算。
// chars 供估算用:压缩(auto compact)后从压缩标记起重新累计 —— 文本和/或摘要回落,
// 估算随之回落,能真实反映 claude 自动压缩的动作。
function scanJsonl(id, s) {
  const file = findSessionJsonl(id, s);
  if (!file) return { found: false, varying: false, compacted: false, chars: 0, in: 0, cache: 0, out: 0, prevIn: null, prevOut: null, prevCache: null, file: null };
  let lastIn = null, lastCache = null, lastOut = null, found = false;
  let prevIn = null, prevOut = null, prevCache = null;
  const inVals = new Set();
  let chars = 0, compacted = false;
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const u = (d && (d.message && d.message.usage)) || d.usage;
      if (u && typeof u === "object") {
        if (lastIn !== null) { prevIn = lastIn; prevOut = lastOut; prevCache = lastCache; }
        found = true;
        const n = Number(u.input_tokens) || 0;
        const c = Number(u.cache_read_input_tokens) || 0;
        const o = Number(u.output_tokens) || 0;
        if (n > 0) { lastIn = n; inVals.add(n); }
        if (c > 0) lastCache = c;
        if (o > 0) lastOut = o;
      }
      // 压缩标记(auto compact 落一条 type=summary 记录):其后的文本重新累计,
      // 估算随之回落。注意别把 attachment(附件/user 注入)误当压缩。
      if (/compaction|"isCompact"|"compact_previous"/.test(line) ||
          /"type"\s*:\s*"summary"/.test(line)) {
        compacted = true;
        chars = 0;
        continue;
      }
      const m = d && d.message;
      if (!m || !m.role) continue;
      if (m.role === "user" || m.role === "assistant" || m.role === "tool") {
        chars += textLen(m.role, m);
      }
    }
  } catch {}
  return {
    found, varying: inVals.size > 1, compacted, chars,
    in: lastIn || 0, cache: lastCache || 0, out: lastOut || 0,
    prevIn, prevOut, prevCache, file,
  };
}

// 旧版估算兜底(无 jsonl 可读时):结构消息按文本估;Form B 用实录逐行去重估
function estimateFallback(s) {
  let ch = 0;
  if (s.messages && s.messages.length) {
    for (const m of s.messages) {
      if (m.role === "user") ch += (m.text || "").length;
      else if (m.role === "assistant") {
        for (const b of m.blocks || []) {
          if (b.type === "text") ch += (b.text || "").length;
          else if (b.type === "thinking") ch += (b.text || "").length / 2;
        }
      }
    }
  } else {
    const seen = new Set();
    for (const raw of (s.transcript || "").split("\n")) {
      let l = (raw || "").replace(/\s+/g, "").trim();
      if (!l || seen.has(l)) continue;
      seen.add(l);
      if (l.startsWith("❯")) l = l.slice(1);
      ch += l.length;
    }
  }
  return Math.round(ch / CH_TOK) + SYS_TOK;
}

// 对外:查询某会话当前上下文状态(口径 = 当前上下文占用,对齐 claude 的 /context)
// 窗口上限:会话手动指定的 maxTokens 优先,否则按模型解析(自动)
function contextState(id) {
  const s = persistence.getSession(id);
  if (!s) return { error: "会话不存在", used: 0, max: 200_000, pct: 0, source: "none" };
  const manual = Number(s.maxTokens) || 0;
  const max = manual > 0 ? manual : maxOf(s.model || "");
  const r = scanJsonl(id, s);

  // usage 可信:历史出现过变化的 input —— 直接用最后一次真值(精确)
  if (r.found && r.varying) {
    const used = r.in + r.cache;
    return {
      used, max, pct: used / max, manual: manual > 0,
      hitRate: r.in > 0 && r.cache > 0 ? r.cache / (r.in + r.cache) : 0,
      source: "jsonl", usedText: fmt(used), maxText: fmt(max), file: r.file,
    };
  }

  // 估算:优选用 jsonl 里真实消息文本(r.chars),无 jsonl 才退回 transcript/结构消息。
  // chars 只在最后一个压缩标记之后累计,所以 compact 后估算会自动回落。
  let src, used2;
  if (r.file && r.chars > 0) {
    src = "estimate";
    used2 = Math.round(r.chars / CH_TOK) + SYS_TOK;
    return {
      used: used2, max, pct: used2 / max, manual: manual > 0,
      hitRate: 0, source: src, estimated: true,
      note: "估算（按会话实录文本≈" + fmt(Math.round(r.chars / CH_TOK)) + "＋系统" + Math.round(SYS_TOK / 1000) + "K）",
      usedText: fmt(used2), maxText: fmt(max), file: r.file,
    };
  }
  const used = estimateFallback(s);
  return {
    used, max, pct: used / max, manual: manual > 0,
    hitRate: 0, source: "estimate", estimated: true,
    note: "估算（含系统约" + Math.round(SYS_TOK / 1000) + "K，按实录文本估）",
    usedText: fmt(used), maxText: fmt(max),
  };
}

module.exports = { contextState, projectDirOf, projectDirsOf, maxOf, fmt, findSessionJsonl, scanJsonl, normPath, cwdOfJsonl, sessionFilesOf };
