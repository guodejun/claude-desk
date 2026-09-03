// 多会话 claude 进程管理:每个应用会话一条「消息 = 一次 spawn」的独立进程,
// Map<sessionId, job> 维护,互不干扰。事件通过注入的 emit 回调吐给主进程转发。
// 与 Electron 解耦:只依赖 child_process / readline / fs / persistence。
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const persistence = require("./persistence.cjs");

const jobs = new Map(); // sessionId -> { child, jobKey, claudeSessionId, killTimer }
let seq = 0;
let emitFn = () => {};

function setEmit(fn) {
  emitFn = fn;
}

// ---- 参数处理 ----

const RESERVED_FLAGS = new Set([
  "-p",
  "--print",
  "--resume",
  "--continue",
  "--output-format",
  "--verbose",
  "--dangerously-skip-permissions",
]);
// 这些保留 flag 后面会紧跟一个值(-p msg / --resume id / --output-format fmt),
// 剔除 flag 时要把它的值一并剔除,避免残留成垃圾位置参数
const RESERVED_WITH_VALUE = new Set(["-p", "--print", "--resume", "--continue", "--output-format"]);

// 用户填写的多行参数 -> argv 数组
// 逐行(空行/# 注释跳过);行内支持 "…" / '…' 引号,去掉首尾引号与 \" 转义
function tokenizeArgs(str) {
  const out = [];
  if (!str) return out;
  for (const line of str.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    for (const m of t.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)) {
      let tok = m[0];
      if (
        (tok.startsWith('"') && tok.endsWith('"')) ||
        (tok.startsWith("'") && tok.endsWith("'"))
      ) {
        tok = tok.slice(1, -1);
      }
      tok = tok.replace(/\\"/g, '"');
      if (tok) out.push(tok);
    }
  }
  return out;
}

// 剔掉保留 flag(及其值),防用户覆盖我们拼的必需参数;其余参数原样保留(如 --model xx 合法)
function sanitizeUserTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (RESERVED_FLAGS.has(t)) {
      if (RESERVED_WITH_VALUE.has(t) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++; // 连同值一起剔除
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

// 组装 spawn 参数。用户自定义参数先入放最前(合法,如 --model),再强制拼必需参数与开关;
// 保留 flag 一律从用户参数里剔掉,防覆盖我们拼的输出格式/会话延续参数。
function buildArgs({ argText, message, claudeSessionId, skipPermissions }) {
  const user = sanitizeUserTokens(tokenizeArgs(argText));
  const args = [...user];
  args.push("-p", message, "--output-format", "stream-json", "--verbose");
  if (claudeSessionId) args.push("--resume", claudeSessionId);
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  return args;
}

// ---- 流解析 ----

const TOOL_BLOCK_TYPES = new Set([
  "tool_use",
  "tool_use_group",
  "func",
  "hook_result",
  "wrapper",
]);

// 工具结果内容可能是 string / block 数组({type:'text'} 或 {type:'image'}) / 嵌套 tool_result,
// 统一展平成纯文本(图片块因当前模型不能识图,给占位说明)。
function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (!c || typeof c !== "object") return "";
        if (c.type === "text") return c.text ?? "";
        if (c.type === "image") return "🖼 [工具返回图片结果,当前界面暂不显示]";
        if (c.type === "tool_result" || c.type === "tool_use_id") return toolResultText(c.content ?? c.result);
        return c.text ?? "";
      })
      .filter((x) => x !== "")
      .join("\n");
  }
  if (typeof content === "object") return content.text ?? JSON.stringify(content, null, 2);
  return String(content);
}

// 并行工具会被 CLI 包进 wrapper(tool_use_group / tool_result_group)块,平铺成普通块流
function flattenBlocks(list, out = []) {
  for (const b of list || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "wrapper" && b.data && Array.isArray(b.data.blocks)) {
      flattenBlocks(b.data.blocks, out);
    } else if (b.type === "wrapper" && b.data && Array.isArray(b.data.results)) {
      // tool_result_group:每个 result 转成 tool_result
      for (const r of b.data.results || []) {
        if (r && r.type === "tool_result") {
          out.push({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content, is_error: r.is_error });
        }
      }
    } else {
      out.push(b);
    }
  }
  return out;
}

// 一行 JSON -> { messageId, block } | null
// 注意:CLI 把「工具执行结果」放在 type:"user" 事件里(assistant 里只有 tool_use 请求),
// 只扫 assistant 会丢结果,必须两类都处理。
function parseLine(v) {
  if (!v || typeof v !== "object") return null;
  if (v.type === "assistant") {
    const content = flattenBlocks(v.message?.content || []);
    for (const blk of content) {
      if (typeof blk !== "object") continue;
      if (blk.type === "thinking") {
        return { messageId: v.message?.id, block: { type: "thinking", text: blk.thinking || "" } };
      }
      if (blk.type === "text") {
        return { messageId: v.message?.id, block: { type: "text", text: blk.text } };
      }
      if (blk.type === "tool_use" || blk.type === "tool_use_group") {
        return {
          messageId: v.message?.id,
          block: { type: "tool", name: blk.name || blk.tool_name || "工具", input: blk.input ?? blk.input_params, toolUseId: blk.tool_use_id || blk.id || "" },
        };
      }
    }
    return null;
  }
  if (v.type === "user") {
    // 工具执行结果:独立成块(与落盘结构一致,渲染端把它画在工具卡下方)
    const content = flattenBlocks(v.message?.content || []);
    for (const blk of content) {
      if (blk && typeof blk === "object" && (blk.type === "tool_result" || blk.type === "tool_use_result" || blk.type === "tool_use_error")) {
        const text = toolResultText(blk.content ?? blk.result);
        return { messageId: v.message?.id, block: { type: "tool-result", text, isError: !!blk.is_error || blk.type === "tool_use_error", toolUseId: blk.tool_use_id || "" } };
      }
    }
    return null;
  }
  if (v.type === "result" && v.is_error) {
    return { messageId: v.message?.id, block: { type: "error", text: v.error || "调用出错" } };
  }
  return null;
}

// ---- 进程生命周期 ----

// ---- claude 可执行文件跨平台发现 ----
// Linux(Ubuntu) 与 Windows 的 PATH 分隔符、二进制名、常见安装位置都不同:
//   * Linux  : `claude` 常装于 ~/.npm-global/bin、~/.local/bin、/usr/local/bin、/snap/bin…
//   * Windows: `claude.cmd`(npm 全局,通常在 %APPDATA%\npm 或 %LOCALAPPDATA%\npm)
//             或原生安装的 `claude.exe`
// 显式配置了 claudePath 时直接使用;否则按候选目录+PATH 逐平台探测,找不到则兜底让 OS 解析。
function findClaudeBin() {
  const isWin = process.platform === "win32";
  const names = isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  const candidates = [];
  if (isWin) {
    for (const e of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)"]) {
      const base = process.env[e];
      if (!base) continue;
      candidates.push(path.join(base, "npm"), path.join(base, ".local", "bin"), path.join(base, ".claude"));
    }
  } else {
    candidates.push(
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/snap/bin",
      "/opt/homebrew/bin"
    );
  }
  const pathEnv = (process.env.PATH || "")
    .split(isWin ? ";" : ":")
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  for (const d of [...candidates, ...pathEnv]) {
    for (const n of names) {
      const p = path.join(d, n);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return isWin ? "claude.cmd" : "claude";
}

// ---- 进程树终止(Windows 兼容) ----
// Windows 上 .cmd 经 cmd.exe 执行,child.pid 是 cmd 的 pid,发 SIGTERM/SIGKILL 都杀不掉
// 它派生的 claude 子进程,必须用 taskkill /T /F 连整棵进程树一起强杀;
// Linux/macOS 直接对 pid 发 SIGKILL。
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

// 实际使用:配置了 claudePath 用它,否则自动发现
function claudeBin() {
  return persistence.loadSettings().claudePath || findClaudeBin();
}

// 由模型名估算上下文 token 上限(未识别/普通模型按 200k;1M 长上下文模型按 1M)
function contextLimitOf(model) {
  const m = String(model || "").toLowerCase();
  return m.includes("1m") || m.includes("long") ? 1000000 : 200000;
}

// ---- Windows 兼容 ----
// Windows 上全局 npm 安装的 claude 是 claude.cmd(无 .exe),
// Node 的 spawn 在 shell:false 时找不到它必须经 cmd 执行(shell:true)。
// 走 shell 后 Node 只对「未用引号包裹且含空白」的参数补一层引号,已用 "..." 包裹的
// 参数原样保留——所以这里只负责对含空白/特殊字符的参数做 cmd 转义:
// 双引号写成 ""(cmd 引号内转义);注意不要动 %——cmd 命令行层没有 %% 转义规则,
// 动它会污染含 % 的提示词(cross-spawn 同样不处理 %)。
function winQuoteArg(a) {
  const needs = /[\s"&|<>^]/.test(a);
  if (!needs) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

// 读取 ~/.claude/settings.json 的 env 块(鉴权 token / 网关地址 ANTHROPIC_AUTH_TOKEN 等),
// 注入 claude 子进程。claude -p 子进程不会自己加载 settings 的 env;
// 应用从桌面/打包 exe 启动时拿不到交互 shell 里 export 的 ANTHROPIC_* 变量,
// 不注入就会报 "Not logged in · Please run /login"。
function claudeEnv() {
  try {
    const f = path.join(os.homedir(), ".claude", "settings.json");
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (s.env && typeof s.env === "object") {
      const e = {};
      for (const [k, v] of Object.entries(s.env)) if (typeof v === "string") e[k] = v;
      return e;
    }
  } catch {}
  return {};
}

// 统一创建 claude 子进程(跨平台):.cmd/.bat 在 Windows 经 cmd 执行,其余直接 spawn
function spawnClaude(bin, args, opts = {}) {
  const isWin = process.platform === "win32";
  const viaShell = isWin && /\.(cmd|bat)$/i.test(bin);
  return spawn(bin, args, {
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "ignore"],
    // 注入 settings.json 的 env,保证任何启动方式下 claude 都有鉴权
    env: { ...process.env, ...(opts.env || {}), ...claudeEnv() },
    // windowsHide:true 打包后不闪 cmd 黑窗
    ...(viaShell ? { shell: true, windowsHide: true } : isWin ? { windowsHide: true } : {}),
  });
}

// 返回 { ok:true } 或 { error }
function runClaude(sessionId, message, opts = {}) {
  if (jobs.has(sessionId)) return { error: "该会话正在运行" };
  const cwd = opts.cwd || process.cwd();
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!isDir) {
    emitFn({ type: "error", id: sessionId, message: `工作目录不存在: ${cwd}` });
    return { error: `工作目录不存在: ${cwd}` };
  }
  const isWin = process.platform === "win32";
  let args = buildArgs({
    argText: opts.argText,
    message,
    claudeSessionId: opts.claudeSessionId,
    skipPermissions: opts.skipPermissions,
  });
  if (isWin) args = args.map(winQuoteArg);
  const jobKey = ++seq;
  const DEBUG = !!process.env.AUTOTEST_DEBUG;
  if (DEBUG) console.log(`[claude] spawn bin=${claudeBin()} args=${JSON.stringify(args)} cwd=${cwd}`);
  const child = spawnClaude(claudeBin(), args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  const job = { child, jobKey, claudeSessionId: opts.claudeSessionId, killTimer: null, model: null };
  jobs.set(sessionId, job);
  persistence.setRunning(sessionId, true);
  emitFn({ type: "start", id: sessionId, jobKey });

  child.on("spawn", () => DEBUG && console.log(`[claude] spawned pid=${child.pid}`));
  child.on("error", (err) => {
    // 启动失败(如二进制不存在):发错误并清理,不阻塞列表
    if (DEBUG) console.log(`[claude] error ${err.message}`);
    emitFn({ type: "error", id: sessionId, jobKey, message: `claude 启动失败: ${err.message}` });
    persistence.setRunning(sessionId, false);
    jobs.delete(sessionId);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (DEBUG) console.log(`[claude] line ${line.slice(0, 120)}`);
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      return;
    }
    // 会话初始化信息:记录模型(用于估算上下文上限,close 时落盘)
    if (v.type === "system" && v.subtype === "init" && v.model) job.model = v.model;
    // 会话延续 id:只要出现就更新(close 时落盘)
    if (v.session_id) job.claudeSessionId = v.session_id;
    const parsed = parseLine(v);
    if (parsed) emitFn({ type: "stream", id: sessionId, jobKey, messageId: parsed.messageId, block: parsed.block });
  });

  child.on("close", (code) => {
    try {
      if (job.killTimer) {
        clearTimeout(job.killTimer);
        job.killTimer = null;
      }
      persistence.recordDone(sessionId, job.claudeSessionId, job.model);
      jobs.delete(sessionId);
      emitFn({ type: "done", id: sessionId, jobKey, claudeSessionId: job.claudeSessionId });
      // 非零退出 + 非主动停止:提示(不打断)
      if (code && code !== 0 && !child.killed) {
        emitFn({ type: "error", id: sessionId, jobKey, message: `claude 进程退出码: ${code}` });
      }
    } catch (err) {
      // 防御:close 回调里的任何异常都不能拖垮主进程事件循环
      console.error("claude close 回调异常:", err);
      persistence.flush(sessionId);
    }
  });
  return { ok: true };
}

function stopSession(sessionId) {
  const job = jobs.get(sessionId);
  if (!job) return false;
  if (process.platform === "win32") {
    // Windows 的 cmd 上没有优雅 SIGTERM,直接强杀整棵进程树
    killTree(job.child.pid);
  } else {
    job.killTimer = setTimeout(() => killTree(job.child.pid), 2000);
    try {
      job.child.kill("SIGTERM");
    } catch {}
  }
  return true;
}

function killSession(sessionId) {
  const job = jobs.get(sessionId);
  if (!job) return false;
  if (job.killTimer) clearTimeout(job.killTimer);
  killTree(job.child.pid); // 强杀(Unix 上等价 SIGKILL;Windows 上连 claude 子进程一起)
  jobs.delete(sessionId);
  persistence.setRunning(sessionId, false);
  return true;
}

function isRunning(sessionId) {
  return jobs.has(sessionId);
}

function runningCount() {
  return jobs.size;
}

// 独立一次性调用:给一段提示,收集最终文本(用于 AI 深度总结/压缩上下文等,不落库不进 jobs)
// 提示词走【stdin】而非命令行参数:总结/压缩会把完整会话实录塞进 prompt,实录一大就触发
// spawn 的 E2BIG(单参数超 ~128KB/Linux MAX_ARG_STRLEN),stdin 无此上限。
function runSummary(prompt, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    // -p 后带空串作为 prompt 占位,具体内容经 stdin 流入(claude 检测 stdin 非 TTY 即读取)
    let args = ["-p", "", "--output-format", "text"];
    if (isWin) args = args.map(winQuoteArg);
    let child;
    try {
      child = spawnClaude(claudeBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message) });
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => killTree(child.pid), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // 管道写入被拒/提前关闭(子进程未读)时忽略,不能让 EPIPE 异常崩掉主进程
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, error: String(e.message) });
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, text: out.trim(), error: err.trim() });
    });
  });
}

module.exports = {
  setEmit,
  tokenizeArgs,
  sanitizeUserTokens,
  buildArgs,
  parseLine,
  findClaudeBin,
  claudeBin,
  contextLimitOf,
  claudeEnv,
  spawnClaude,
  runClaude,
  stopSession,
  killSession,
  killTree,
  isRunning,
  runningCount,
  runSummary,
};
