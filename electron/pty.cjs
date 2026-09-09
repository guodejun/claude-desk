// 终端会话层:为每个应用会话起一个【真实交互式 claude】终端(node-pty + TTY)
// 与 claude.cjs 的 `-p` headless 模式互补:
//   claude.cjs = 一条消息一次进程,结构化 stream-json(无权限确认,近似渲染)
//   本层       = 带 TTY 的交互 TUI,权限确认 / /retry /rewind / 状态栏 100% 原版一致
// 设计:
//   - Map<sessionId, { term, raw, ... }>;PTY 输出字节经注入的 emit 转发给渲染层 xterm 直接画
//   - 终端【常驻事故】:open 幂等(已开则返回本轮原始字节 rawo replay 供视图重放),
//     关闭只由「结束终端」按钮 / 删除会话 / 应用退出触发,切换页面不杀进程(多会话并行)
//   - 实录捕获:累计原始字节(封顶),节流落盘为会话的 transcript(剥 ANSI),
//     供右侧纪要面板回顾与 AI 深度总结使用
const fs = require("fs");
const os = require("os");
const path = require("path");
const pty = require("node-pty");
const persistence = require("./persistence.cjs");
const claude = require("./claude.cjs"); // 复用 tokenizeArgs / sanitizeUserTokens / claudeBin
const contextmon = require("./contextmon.cjs"); // projectDirsOf:claude jsonl 落盘目录(含父级 git 根)
const { cleanTranscript } = require("./transcript.cjs"); // TUI 装饰行清洗

const sessions = new Map(); // sessionId -> { term, cwd, bin, args, raw, dirty, base }
let emitFn = () => {};

// 实录封顶:原始字节保留最近 ~400KB(兼顾 replay 重放长度与落盘体积)
const MAX_RAW = 400_000;
// 总结时截取的尾段长度(够喂给 claude 的上下文即可)
const SUMMARY_MAX = 60_000;
// 实录节流落盘间隔(ms):运行中也不至于弄丢太多(poweroff 兜底以 close/exit 为准)
const FLUSH_MS = 6_000;

function setEmit(fn) {
  emitFn = fn;
}

// 去掉 ANSI 控制序列(对整个缓冲做,避免跨 chunk 的半截序列问题),保留可读文本
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
function stripAnsi(text) {
  // 先删思考过程(dim 2 + italic 3 标记),再剥 ANSI。
  // 思考内容(内心独白)用斜体+暗淡 SGR 包裹,与最终回答不同色,是唯一可靠的区分标记。
  return stripThinking(String(text || ""))
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// 删除 dim(2)/italic(3) 状态下的文本 —— Claude Code 用这套 SGR 标记思考过程,
// 思考内容剥 ANSI 后会混进最终回答造成乱码,须在剥 ANSI 前按状态剔除。
function stripThinking(raw) {
  let out = "";
  let dim = false, italic = false, last = 0;
  const re = /\[([0-9;]*)m/g;
  let m;
  while ((m = re.exec(raw))) {
    if (!dim && !italic) out += raw.slice(last, m.index);
    const params = (m[1] || "0").split(";").map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 38 || p === 48) {
        // 前景/背景色设置:38/48 后跟 5;N(256色) 或 2;R;G;B(RGB),整体跳过
        if (params[i + 1] === 5) i += 3;
        else if (params[i + 1] === 2) i += 5;
        else i += 1;
      } else {
        if (p === 0) { dim = false; italic = false; }
        else if (p === 2) dim = true;
        else if (p === 3) italic = true;
        else if (p === 22) dim = false;
        else if (p === 23) italic = false;
        i += 1;
      }
    }
    last = re.lastIndex;
  }
  if (!dim && !italic) out += raw.slice(last);
  return out;
}

// Windows 上 .cmd/.bat 不能直接 CreateProcess,需经 cmd /c 执行(claude.cmd 同理)
function execTarget(bin) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { file: process.env.ComSpec || "cmd.exe", prefix: ["/c", bin] };
  }
  return { file: bin, prefix: [] };
}

// 把当前会话实录落盘:base(历次运行实录) + 本轮启动标记 + 本轮剥好 ANSI 的字节尾段,经 TUI 行清洗
function doFlush(id, entry) {
  if (!entry) return;
  try {
    const body = stripAnsi(entry.raw).slice(-SUMMARY_MAX);
    const head = `${body ? "\n\n[ --- 终端实录 " + new Date().toLocaleString("zh-CN", { hour12: false }) + " --- ]\n" : ""}`;
    const text = cleanTranscript((entry.base || "").slice(-MAX_RAW * 2) + head + body);
    persistence.setTranscript(id, text);
  } catch {}
}

// 后台节流:运行中的终端每 FLUSH_MS 落盘一次实录(有新增才写);顺带兜底捕获 session id
setInterval(() => {
  for (const [id, entry] of sessions) {
    if (entry && !entry.claudeId) captureClaudeId(id, entry);
    if (entry && entry.dirty) {
      entry.dirty = false;
      doFlush(id, entry);
    }
  }
}, FLUSH_MS);

// ---- claude session id 捕获(「恢复对话」的数据源) ----
// 新终端启动后,claude 会在项目 slug 目录创建 <sessionId>.jsonl。用「启动前快照 + 之后新出现的
// 文件」锁定本会话的 jsonl(文件名即 session id),落盘到会话记录的 claudeSessions 列表。
// 只在【未锁定】时捕获:同目录可能有其它 claude(外部终端/别的应用会话)并发写 jsonl,
// 锁定后不再跟随新文件,避免把外部会话误记到自己名下(/clear 换新文件的场景接受遗漏)。
const claudeIds = new Map(); // appSessionId -> 当前锁定的 claude session id(占用映射,防重复 resume)

function snapshotJsonls(cwd) {
  // 本项目现有 jsonl 集合:按 jsonl 内 cwd 字段精确归属,Win(slug 规则不同)/父级 git 根落盘都覆盖
  return new Set(contextmon.sessionFilesOf(cwd).map((f) => f.file));
}

function lockClaude(id, entry, file) {
  const cid = path.basename(file, ".jsonl");
  if (!cid || entry.claudeId === cid) return;
  entry.claudeId = cid;
  claudeIds.set(id, cid);
  persistence.addClaudeSession(id, cid);
}

// 未锁定时轮询:快照之后新出现且 mtime 不早于启动时刻的 .jsonl 即本会话。
// 扫描范围是 projects 全目录(Win 上算不出 claude 实际落盘的 slug 目录,只能全扫),
// 故锁定前必须按 jsonl 内 cwd 字段确认是本项目会话——同机其它项目的 claude 恰好
// 同刻新起会话时防误锁;多个候选取 mtime 最新且归属本项目的第一个。
function captureClaudeId(id, entry) {
  if (entry.claudeId || !entry.known) return;
  const fresh = [];
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {}
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
      if (entry.known.has(p)) continue;
      let mt = 0;
      try {
        mt = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mt < entry.bornAt - 3000) continue; // 启动前就在写的旧文件(快照竞态),不是本会话
      fresh.push({ p, mt });
    }
  }
  for (const f of fresh) entry.known.add(f.p); // 无论归属与否都进快照,避免反复校验
  if (!fresh.length) return;
  fresh.sort((a, b) => b.mt - a.mt);
  const target = contextmon.normPath(path.resolve(entry.cwd));
  for (const f of fresh) {
    if (contextmon.normPath(contextmon.cwdOfJsonl(f.p, f.mt)) !== target) continue;
    lockClaude(id, entry, f.p);
    return;
  }
}

// 交互模式参数清洗:sanitizeUserTokens 会把 --resume <id> 连同其值一起剥掉(headless 需要
// 防止覆盖它自己拼的必需参数)。但交互模式没有"必需参数"需保护,且 --resume <id> 是恢复
// 指定 claude 会话的合理入口(压测驱动/用户都靠它把 claude 会话锚定到已知 id)。
// 故此处放宽:仅剥 headless 专属/危险冲突类,放行 --permission-mode / --resume 等。
function ptySanitize(tokens) {
  const out = [];
  // --output-format 后带一个值,整对剔除;其余变体单 flag 剔除
  const withVal = new Set(["--output-format"]);
  const bare = new Set(["-p", "--print", "--verbose", "--dangerously-skip-permissions"]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (withVal.has(t)) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i++;
      continue;
    }
    if (bare.has(t)) continue;
    out.push(t);
  }
  return out;
}

// 打开终端:在该会话目录、套用会话参数,起真实交互 claude
// 幂等:已打开则直接返回 { ok, replay: 本轮原始字节 } 供新挂载的视图重放历史
function open(sessionId, opts = {}) {
  if (sessions.has(sessionId)) {
    const ex = sessions.get(sessionId);
    return { ok: true, replay: ex.raw || "", running: true, args: ex.args, fresh: false };
  }
  const cwd = (opts.cwd || "").trim() || os.homedir();
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!isDir) {
    emitFn({ type: "exit", id: sessionId, exitCode: null, reason: `工作目录不存在: ${cwd}` });
    return { error: `工作目录不存在: ${cwd}` };
  }
  const bin = claude.claudeBin();
  // 交互模式不使用 -p / --output-format 等保留 flag,剔除避免干扰
  const args = ptySanitize(claude.tokenizeArgs(opts.argText || ""));
  // 会话创建时勾选「跳过权限确认」→ 显式补上该 flag(终端形态同样生效)
  if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
  // 恢复对话:三选弹窗选定 --resume <id>。启动前校验 jsonl 还在(claude 对不存在的 id 直接报错
  // 退出);失效则从会话历史剔除、按全新对话起。显式 resume 优先,剔除用户 argText 里手写的 --resume 防冲突
  let resumeId = String(opts.resumeId || "").trim();
  let resumeFile = "";
  if (resumeId) {
    // 按 jsonl 内 cwd 字段全量找(跨平台;slug 目录猜法在 Win 上不适用)
    const found = contextmon.sessionFilesOf(cwd).find((f) => f.id === resumeId);
    if (found) resumeFile = found.file;
    if (!resumeFile) {
      persistence.removeClaudeSession(sessionId, resumeId);
      resumeId = "";
    }
  }
  if (resumeId) {
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i] === "--resume") args.splice(i, args[i + 1] && !args[i + 1].startsWith("-") ? 2 : 1);
    }
    args.push("--resume", resumeId);
  }
  const { file, prefix } = execTarget(bin);
  const bornAt = Date.now();
  // 恢复已知 id 无需捕获;全新对话先快照现存 jsonl,之后新出现的文件即本会话
  const known = resumeId ? null : snapshotJsonls(cwd);

  let term;
  try {
    // 注入 ~/.claude/settings.json 的 env(鉴权 token 等),保证桌面启动也能通过认证
    const penv = { ...process.env, ...claude.claudeEnv() };
    // 剔除宿主 Claude Code 会话传染变量:桌面 app 常被从 Claude Code 会话里启动,
    // process.env 会带 CLAUDE_CODE_CHILD_SESSION / CLAUDE_CODE_SESSION_ID 等,
    // attach 的 claude 继承后会误判自己是子会话/进 manual mode,输入不提交或行为异常。
    // (鉴权类 ANTHROPIC_AUTH_TOKEN / 网关地址等来自 claudeEnv,不受影响)
    for (const k of Object.keys(penv)) {
      if (/^(CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_MESSAGING_SOCKET|AI_AGENT|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|CLAUDE_CODE_ATTRIBUTION_HEADER|CLAUDE_CODE_RUN_AGENT)$/.test(k)) delete penv[k];
    }
    term = pty.spawn(file, [...prefix, ...args], {
      name: "xterm-256color",
      cols: opts.cols || 100,
      rows: opts.rows || 30,
      cwd,
      env: penv,
    });
  } catch (e) {
    emitFn({ type: "exit", id: sessionId, exitCode: null, reason: String((e && e.message) || e) });
    return { error: `终端启动失败: ${(e && e.message) || e}` };
  }

  const entry = {
    term,
    cwd,
    bin,
    args,
    raw: "",
    dirty: false,
    base: (persistence.getSession(sessionId)?.transcript) || "",
    bornAt,
    known,
    claudeId: "",
  };
  sessions.set(sessionId, entry);
  if (resumeFile) lockClaude(sessionId, entry, resumeFile); // 恢复对话:直接锁定已知 id
  // 全新对话:jsonl 通常在启动 1~2s 内出现,早期密集捕几轮,之后由 FLUSH 间隔兜底
  if (!resumeId) [1500, 4000, 9000, 20000].forEach((ms) => setTimeout(() => { if (sessions.has(sessionId)) captureClaudeId(sessionId, entry); }, ms));
  lastUserAt.delete(sessionId); // 新开终端,清掉历史提交标记

  term.onData((d) => {
    entry.raw = (entry.raw + d).slice(-MAX_RAW);
    entry.dirty = true;
    emitFn({ type: "data", id: sessionId, data: d });
  });
  term.onExit(({ exitCode }) => {
    doFlush(sessionId, sessions.get(sessionId));
    sessions.delete(sessionId);
    claudeIds.delete(sessionId);
    lastUserAt.delete(sessionId);
    persistence.setRunning(sessionId, false);
    emitFn({ type: "exit", id: sessionId, exitCode });
  });

  persistence.setRunning(sessionId, true);
  emitFn({ type: "open", id: sessionId });
  return { ok: true, replay: "", running: true, cwd, bin, args, fresh: true };
}

// 用户最近一次提交(回车)时刻,供纪要面板触发判定;会话开/关时同步清理,避免陈旧值误触发
const lastUserAt = new Map();
function write(sessionId, data) {
  const s = sessions.get(sessionId);
  if (s) {
    // 用户提交:输入里带换行(回车)即视为「用户问了一个问题」,记时刻供纪要触发判定
    // (见 SummaryPanel:有新提问 + 输出停滞 = 问完答完,才总结;而不是定时/任意输出停滞)
    if (/\r|\n/.test(data)) lastUserAt.set(sessionId, Date.now());
    s.term.write(data);
  }
  return !!s;
}

function lastUserAtOf(sessionId) {
  return lastUserAt.get(sessionId) || 0;
}

function resize(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try {
    s.term.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
  } catch {}
  return true;
}

// 关闭(仅关终端,不删会话记录):实录先落盘,再杀进程
function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  doFlush(sessionId, s);
  try {
    s.term.kill();
  } catch {}
  sessions.delete(sessionId);
  claudeIds.delete(sessionId);
  persistence.setRunning(sessionId, false);
  return true;
}

function isOpen(sessionId) {
  return sessions.has(sessionId);
}

// 查询当前终端真实行列(node-pty 侧,供自测断言 claude 实际渲染尺寸已同步)
function sizeOf(sessionId) {
  const s = sessions.get(sessionId);
  return s ? { cols: s.term.cols, rows: s.term.rows } : null;
}

// 给 AI 总结用:运行中直接取实时字节尾段(比落盘 transcript 更新),同样做 TUI 行清洗
function liveTranscript(sessionId, max = SUMMARY_MAX) {
  const s = sessions.get(sessionId);
  if (!s) return "";
  return cleanTranscript(stripAnsi(s.raw).slice(-max));
}

// 会话内执行斜杠命令(如 /context)并捕获输出:向 PTY 写命令,从写入点起的原始字节收集,
// 连续 idle 判定输出结束。只 stripAnsi 不跑 cleanTranscript——保留 /context 的盒线排版直读。
function command(sessionId, cmd, opts = {}) {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve({ error: "终端未运行，请先打开会话终端" });
  const { idleMs = 450, minMs = 600, timeoutMs = 15000 } = opts;
  const mark = s.raw.length;
  try {
    s.term.write(cmd);
  } catch {
    return Promise.resolve({ error: "终端写入失败" });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let last = s.raw.length;
    let idleSince = started;
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      // 去掉命令回显行前的空输出/尾随空白(会带提示符/光标残留,展示层再 trim)
      resolve({ ok: true, text: stripAnsi(s.raw.slice(mark)).replace(/\s+$/g, "").trim() });
    };
    const tick = () => {
      const len = s.raw.length;
      const now = Date.now();
      if (len !== last) {
        last = len;
        idleSince = now;
      }
      // 已收到输出且新字节停滞 idleMs → 视为命令执行完毕(夹住半途中止的连续输出最快结束)
      if (len > mark && now - idleSince >= idleMs && now - started >= minMs) return finish();
      if (now - started > timeoutMs) return finish();
      timer = setTimeout(tick, 150);
    };
    tick();
  });
}

// 压缩上下文:发 /compact 并自动应答确认(找 (y/N) 类提示即回 y)。
// 各版本确认文案不同,抓不到确认提示就留给用户在终端里自己回车,不破坏会话。
function compact(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve({ error: "终端未运行，请先打开会话终端" });
  const mark = s.raw.length;
  try {
    s.term.write("/compact\r");
  } catch {
    return Promise.resolve({ error: "终端写入失败" });
  }
  return new Promise((resolve) => {
    // 确认提示特征:y/N·Y/n·yes/no·继续·确认(转小写匹配)
    const CONFIRM = /\(y\/?n\)|\(y\/n\)|y\/n|yes\/no|continue|继续|确认|complete/i;
    const done = Date.now() + 12000;
    const poll = () => {
      const text = stripAnsi(s.raw.slice(mark)).toLowerCase();
      const alive = sessions.has(sessionId);
      if (!alive) return resolve({ ok: true, submitted: false, ended: true });
      if (CONFIRM.test(text)) {
        try {
          s.term.write("y\r");
        } catch {}
        return resolve({ ok: true, submitted: true, auto: true });
      }
      if (Date.now() > done) return resolve({ ok: true, submitted: false });
      setTimeout(poll, 200);
    };
    poll();
  });
}

// 对话队列接力:向终端写一条用户输入,等「claude 回答完」再 resolve。判定与 command() 同思路
// ——以输出停滞为准(TUI 空闲即答完),不解析内容:持续有新字节就等,停顿 idleMs 视为答完。
// 局限:claude 长时间无输出的思考期可能被超前判"答完"(下一条会排队等它),权衡后接受。
function interact(sessionId, text, opts = {}) {
  const s = sessions.get(sessionId);
  if (!s) return Promise.resolve({ error: "终端未运行，请先打开会话终端" });
  const { idleMs = 3000, minMs = 1000, timeoutMs = 120000 } = opts;
  const mark = s.raw.length;
  try {
    s.term.write(text);
  } catch {
    return Promise.resolve({ error: "终端写入失败" });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let last = s.raw.length;
    let idleSince = started;
    let even = false; // 是否已出现过头一轮输出(预防把发送前的垫底字节当回答)
    let timer = null;
    let killT = null;
    const finish = (timeout) => {
      if (timer) clearTimeout(timer);
      if (killT) clearTimeout(killT);
      resolve({ ok: true, text: stripAnsi(s.raw.slice(mark)).replace(/\s+$/g, "").trim(), timeout: !!timeout });
    };
    // 绝对超时兜底:若 claude 卡在思考/IO 等待,写入后始终无新输出(even 不置真),
    // 不靠 idle 判定会永久挂起 → 超时强制返回,由调用方(waitDone)再判是否真答完
    killT = setTimeout(() => finish(true), timeoutMs);
    const tick = () => {
      const len = s.raw.length;
      const now = Date.now();
      if (len !== last) {
        last = len;
        idleSince = now;
        even = true;
      }
      // 已开始输出且最近 idle 满 idleMs、总体至少观察 minMs → 答完
      if (even && now - idleSince >= idleMs && now - started >= minMs) return finish(false);
      // 终端中途被关闭 → 立即结束,队列引擎会感知到停止
      if (!sessions.has(sessionId)) return finish(false);
      timer = setTimeout(tick, 200);
    };
    tick();
  });
}

// 查询终端原始字节长度(供队列/其他状态轮询:是否发送成功、是否有新输出);未开终端返回 -1
function rawOf(sessionId) {
  const s = sessions.get(sessionId);
  return s ? s.raw.length : -1;
}


function closeAll() {
  for (const id of [...sessions.keys()]) close(id);
}

function openCount() {
  return sessions.size;
}

// 某 claude session 是否正被本应用【其它】终端占用:两个终端同时 resume 同一 id 会互写
// 同一 jsonl(对话记录互串),恢复对话的候选列表据此禁选
function busyClaudeIds(exceptId) {
  const out = new Set();
  for (const [sid, cid] of claudeIds) {
    if (sid !== exceptId && cid) out.add(cid);
  }
  return out;
}

module.exports = { setEmit, open, write, resize, close, isOpen, sizeOf, liveTranscript, command, rawOf, interact, compact, closeAll, openCount, lastUserAtOf, busyClaudeIds };
