// 持久化层:会话文件(userData/sessions/<id>.json) + 应用设置(userData/app-settings.json)
// 设计:每条消息 stream 逐行由主进程解析后走 appendMessage 进内存缓存,
//      debounce(300ms) 整写落盘;done/error/before-quit 即时 flush,防崩溃丢消息。
// 写文件采用「临时文件 + rename」原子替换,避免多会话并发写互相污染。
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let base = null; // sessions 目录
let settingsPath = null;
let settingsCache = { claudePath: "", terminalFontSize: 13, closeAction: "exit" };

const cache = new Map(); // id -> session 对象(内存权威副本)
const flushTimers = new Map(); // id -> timer
const runningSet = new Set(); // 正在跑 claude 的会话 id(claude.cjs 调用 setRunning 维护)

function init(app) {
  base = path.join(app.getPath("userData"), "sessions");
  settingsPath = path.join(app.getPath("userData"), "app-settings.json");
  fs.mkdirSync(base, { recursive: true });
  settingsCache = loadSettingsFile();
}

function fileOf(id) {
  return path.join(base, `${id}.json`);
}

// 原子写:先写 <file>.tmp 再 rename,避免断电/崩溃留下半截文件
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function writeSession(s) {
  if (!base) return;
  atomicWrite(fileOf(s.id), JSON.stringify(s, null, 2));
}

function readSessionFile(id) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
  } catch {
    return null;
  }
}

// ---- 会话 CRUD ----

function createSession(meta = {}) {
  const now = Date.now();
  const s = {
    id: crypto.randomUUID(),
    title: (meta.title || "").trim() || "未命名会话",
    cwd: meta.cwd && meta.cwd.trim() ? meta.cwd.trim() : os.homedir(),
    argText: meta.argText || "",
    skipPermissions: !!meta.skipPermissions,
    claudeSessionId: null,
    model: null, // 最近一次运行捕获到的 claude 模型名(用于估算上下文上限)
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  cache.set(s.id, s);
  writeSession(s);
  return s;
}

function getSession(id) {
  return cache.get(id) || readSessionFile(id);
}

function updateSession(id, patch = {}) {
  const s = getSession(id);
  if (!s) return null;
  if (patch.title !== undefined) s.title = (patch.title + "").trim() || "未命名会话";
  if (patch.cwd !== undefined) s.cwd = (patch.cwd + "").trim() || os.homedir();
  if (patch.argText !== undefined) s.argText = patch.argText;
  if (patch.skipPermissions !== undefined) s.skipPermissions = !!patch.skipPermissions;
  if (patch.tunnel !== undefined) s.tunnel = patch.tunnel;
  // 对话纪要(增量持久化):{ text, lastLen, updatedAt } —— lastLen 是增量锚,记录已总结到的实录长度
  if (patch.summary !== undefined) s.summary = patch.summary;
  // 手动指定的上下文窗口上限(工具面板可改);空/0 表示恢复自动(按模型解析),删除该字段
  if (patch.maxTokens !== undefined) {
    const n = Number(patch.maxTokens) || 0;
    if (n > 0) s.maxTokens = n;
    else delete s.maxTokens;
  }
  s.updatedAt = Date.now();
  cache.set(id, s);
  flush(id);
  return s;
}

function deleteSession(id) {
  cache.delete(id);
  const t = flushTimers.get(id);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(id);
  }
  try {
    fs.rmSync(fileOf(id));
  } catch {}
}

function listSessions() {
  const arr = [];
  const seen = new Set();
  // 先列磁盘文件,再补内存中有但未落盘的尾部
  let files = [];
  try {
    files = fs.readdirSync(base).filter((f) => f.endsWith(".json"));
  } catch {}
  for (const f of files) {
    const id = f.slice(0, -5);
    const s = getSession(id);
    if (!s) continue;
    seen.add(id);
    arr.push(metaOf(s));
  }
  for (const [id, s] of cache) {
    if (!seen.has(id)) arr.push(metaOf(s));
  }
  arr.sort((a, b) => b.updatedAt - a.updatedAt);
  return arr;
}

// 统计会话上下文:消息条数 / 字符数 / 估算 token(字符≈1 tok 相近量,粗估)
function countCtx(s) {
  let n = 0;
  let ch = 0;
  for (const m of s.messages || []) {
    if (m.role === "user") {
      n++;
      ch += (m.text || "").length;
    } else if (m.role === "assistant") {
      n++;
      for (const b of m.blocks || []) {
        if (b.type === "text") ch += (b.text || "").length;
        else if (b.type === "thinking") ch += ((b.text || "").length / 2) | 0;
      }
    }
  }
  return { n, ch, tok: Math.round(ch / 4) };
}

// 终端形态(Form A)下无结构化消息,改用实录估算上下文(剥装饰字符,取尾段)
function ctxOf(s) {
  const m = countCtx(s);
  if (m.n > 0) return m;
  const tr = (s.transcript || "").replace(/\s+/g, "").slice(-200_000);
  return { n: 0, ch: tr.length, tok: Math.round(tr.length / 4) };
}

function metaOf(s) {
  const ctx = ctxOf(s);
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    argText: s.argText,
    skipPermissions: s.skipPermissions,
    claudeSessionId: s.claudeSessionId,
    model: s.model || null,
    ctxChars: ctx.ch,
    ctxTok: ctx.tok,
    ctxN: ctx.n,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    running: runningSet.has(s.id),
  };
}

function loadSession(id) {
  return getSession(id);
}

// ---- 消息增量落盘 ----

function appendMessage(id, msg) {
  const s = getSession(id);
  if (!s) return;
  s.messages = s.messages || [];
  s.messages.push(msg);
  s.updatedAt = Date.now();
  cache.set(id, s);
  scheduleFlush(id);
}

// 流式块聚合:同一 assistant 消息(相同 messageId)的多个块追加进同一条消息;
// 无 messageId / 换了消息则另起一条。避免每条 thinking/text 都成为独立消息。
function appendBlock(id, messageId, block) {
  const s = getSession(id);
  if (!s) return;
  s.messages = s.messages || [];
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === "assistant" && (!messageId || last.messageId === messageId)) {
    last.blocks.push(block);
  } else {
    s.messages.push({ role: "assistant", blocks: [block], messageId: messageId || null });
  }
  s.updatedAt = Date.now();
  cache.set(id, s);
  scheduleFlush(id);
}

function recordDone(id, claudeSessionId, model) {
  const s = getSession(id);
  if (!s) return;
  if (claudeSessionId) s.claudeSessionId = claudeSessionId;
  if (model) s.model = model;
  s.updatedAt = Date.now();
  runningSet.delete(id);
  cache.set(id, s);
  flush(id); // 完成时立即落盘
}

// 压缩上下文:用一段摘要替换会话消息(降低本地持久化/显示的上下文量)
function compactSession(id, summaryText) {
  const s = getSession(id);
  if (!s) return null;
  const before = countCtx(s).tok;
  s.messages = [
    { role: "user", text: "（原对话已压缩为下方摘要，细节可参考右侧纪要）", ts: Date.now() },
    { role: "assistant", blocks: [{ type: "text", text: summaryText }], ts: Date.now() },
  ];
  s.updatedAt = Date.now();
  cache.set(id, s);
  flush(id);
  const after = countCtx(s).tok;
  return { tok: after, saved: before - after };
}

// 未命名会话:实录里第一次出现用户输入(❯ 行)时,自动以其内容生成标题(只自动一次,防覆盖手动改名)
// 注意:TUI 输入行占位符是裸「❯」(无内容),必须跳过;且匹配用 [ \t]* 而非 \s* —— \s 含换行,
// 会被「裸 ❯ + 换行」吃掉,把下一行状态文案误当标题。
function autoTitleOf(text) {
  const re = /^[ \t]*❯[ \t]*([^\n]+)/gm;
  let m;
  while ((m = re.exec(String(text || "")))) {
    let t = m[1].replace(/\s+/g, " ").trim();
    t = t.replace(/[“”"'"`]/g, "").trim(); // 去掉常见引号/反引号装饰
    if (!t || t.length > 120) continue; // 空/纯空白占位行跳过,继续找下一条输入
    if (t.startsWith("/")) continue; // 斜杠命令(如工具面板自动发的 /context)不算提问,跳过
    return t.length > 24 ? t.slice(0, 24) + "…" : t;
  }
  return "";
}

// 终端实录:由 pty.cjs 节流调用,把剥掉 ANSI 的字节文本落盘(供纪要面板/AI 总结回顾)
function setTranscript(id, text) {
  const s = getSession(id);
  if (!s) return;
  s.transcript = (text || "").slice(-600_000);
  // 未命名会话 → 首次出现提问内容时自动定标题
  if (s.title === "未命名会话" && !s.autoTitle) {
    const t = autoTitleOf(s.transcript);
    if (t) {
      s.title = t;
      s.autoTitle = true;
      s.updatedAt = Date.now();
    }
  }
  cache.set(id, s);
  flush(id);
}

function setRunning(id, r) {
  if (r) runningSet.add(id);
  else runningSet.delete(id);
}

function isRunning(id) {
  return runningSet.has(id);
}

function scheduleFlush(id) {
  const t = flushTimers.get(id);
  if (t) clearTimeout(t);
  flushTimers.set(
    id,
    setTimeout(() => flush(id), 300)
  );
}

function flush(id) {
  const t = flushTimers.get(id);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(id);
  }
  const s = cache.get(id);
  if (s) writeSession(s);
}

function flushAll() {
  for (const id of flushTimers.keys()) clearTimeout(flushTimers.get(id));
  flushTimers.clear();
  for (const [id, s] of cache) writeSession(s);
}

// ---- 应用设置 ----

function loadSettingsFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      claudePath: raw.claudePath || "",
      terminalFontSize: Number(raw.terminalFontSize) || 13,
      closeAction: raw.closeAction === "tray" ? "tray" : "exit", // 关闭按钮行为:exit 退出 / tray 缩到托盘
    };
  } catch {
    return { claudePath: "", terminalFontSize: 13, closeAction: "exit" };
  }
}

function loadSettings() {
  return { ...settingsCache };
}

function saveSettings(patch = {}) {
  if (patch.claudePath !== undefined) settingsCache.claudePath = patch.claudePath;
  if (patch.terminalFontSize !== undefined) settingsCache.terminalFontSize = Number(patch.terminalFontSize) || 13;
  if (patch.closeAction !== undefined) settingsCache.closeAction = patch.closeAction === "tray" ? "tray" : "exit";
  atomicWrite(settingsPath, JSON.stringify(settingsCache, null, 2));
  return loadSettings();
}

module.exports = {
  init,
  createSession,
  updateSession,
  deleteSession,
  listSessions,
  loadSession,
  getSession,
  appendMessage,
  appendBlock,
  recordDone,
  compactSession,
  setTranscript,
  setRunning,
  isRunning,
  flush,
  flushAll,
  loadSettings,
  saveSettings,
};
