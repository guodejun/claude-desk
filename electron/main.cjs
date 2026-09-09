// Claude Desk —— Electron 主进程
// 职责:创建窗口 + 内置 HTTP 服务前端产物;把 IPC 接到 persistence / claude / configs;
//       转发「会话事件」总线(claude 的流式过程、完成、错误)给渲染进程,并在转发前先落库。
// 关键设计:底层就是真实 claude,hooks / slash commands / MCP / 配置全部原样生效,
//          这一层只负责"开进程 + 落库 + 转发 + 状态"。

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, nativeTheme, screen, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createServer } = require("http");
const sirv = require("sirv");
const persistence = require("./persistence.cjs");
const claude = require("./claude.cjs");
const pty = require("./pty.cjs");
const tunnel = require("./tunnel.cjs");
const contextmon = require("./contextmon.cjs");
const configs = require("./configs.cjs");
const bridge = require("./bridge.cjs"); // 云连接桥:电脑端外连中转服务,手机可远程操作
const log = require("./log.cjs");

// 去掉顶层原生菜单(File/Edit/View/Window/Help),保持纯 UI
Menu.setApplicationMenu(null);

// ---- 单实例锁 ----
// 防止双开:同 deviceId 的双实例会在云中转端互相「顶掉旧连接」,形成 online→off 循环(假死)。
// 拿不到锁说明已有实例在跑,直接退出,由既有实例的 second-instance 事件弹回主窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => showMainWindow());

// ---- GPU 兜底 ----
// 本应用是文本 UI + 终端,不需要硬件加速;禁用可规避「GPU process isn't usable. Goodbye.」
// 这类 GPU 崩溃导致的整个 electron 退出(9/2 曾触发 SIGTRAP),降低「桌面端掉线」概率。
app.disableHardwareAcceleration();

// 窗口图标:优先前端产物里的 static 图标(build/screenshot-20260903-084503.png),打包期改走 assets/icon.png
function windowIcon() {
  const inBuild = path.join(__dirname, "..", "build", "screenshot-20260903-084503.png");
  const inAssets = path.join(__dirname, "..", "assets", "icon.png");
  return fs.existsSync(inBuild) ? inBuild : inAssets;
}

// 系统托盘:设置「关闭=缩到托盘」时窗口藏到托盘,点图标/菜单恢复;「退出」走 app.quit 真正退出
let tray = null;
function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function ensureTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(windowIcon()).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip("Claude Desk");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Claude Desk", click: showMainWindow },
        { type: "separator" },
        { label: "退出", click: () => app.quit() }, // before-quit 里已置 quitting=true,close 直接放行
      ])
    );
    tray.on("click", showMainWindow); // 左键单击托盘图标也恢复窗口
  } catch (e) {
    log.log("warn", `托盘创建失败: ${(e && e.message) || e}`);
  }
}

function bootLogo() {
  try {
    // 启动阶段静态服务未就绪、data URL 页面再引 file:// 有跨源限制,直接内联 base64 最稳
    return "data:image/png;base64," + fs.readFileSync(windowIcon()).toString("base64");
  } catch {
    return "";
  }
}

// 内置启动页:窗口一出现就先显示这张(新 logo 居中 + 下方转圈),等静态服务就绪再切正式界面
function bootHTML() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0d1117;color:#e6edf3;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    .box{text-align:center}
    .logo-img{max-width:240px;max-height:96px;border-radius:12px;object-fit:contain;filter:drop-shadow(0 4px 18px rgba(0,0,0,.5))}
    .spin{width:22px;height:22px;margin:18px auto 0;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r 1s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
    .tip{margin-top:12px;color:#8b949e;font-size:13px}
  </style></head><body><div class="box">
    <img class="logo-img" src="${bootLogo()}" alt="Claude Desk"/>
    <div class="spin"></div>
    <div class="tip">正在加载…</div>
  </div></body></html>`;
}

let win = null;

// Windows 中文输入防「窗口左移」:部分 IME 组合候选窗出现时,系统/Chromium 偶发把窗口
// 整体往左挪几个像素(与应用逻辑无关,渲染层/主进程都没有任何搬动窗口的代码)。
// 改走「固定位置」方案:平时把窗口钉在最后稳定位置,仅当判定用户在拖拽(连续 move)时才
// 更新;除此之外任何非拖拽的位移(多半就是 IME 误移)一律回弹到固定位置。
// 【后续查明】用户反馈的「中文输入左移」实为渲染层文档被 Chromium IME 滚动(见 app.html
// overflow:clip 修复),OS 窗口从未移动;且 Linux/X11 拖窗常常松手才发一次 move,
// 按「连续事件=拖拽」判定会把正常拖拽误回弹。故本守卫仅作 win32 兜底保留,其它平台不启用。
let pinnedPos = null;      // 窗口应固定的位置 [x, y]
let dragUntil = 0;         // 拖拽判定到期:上次几何事件 +250ms,超时即视为已脱手
let reverting = false;     // 自己 setPosition 回弹中,忽略由此触发的 move/resize
let armed = false;         // 是否已进入稳态守卫(首 1.5s 放行,等系统完成初始摆位/居中再开始)
const PIN_GUARD_ON = process.platform === "win32"; // 窗口固定守卫仅 Windows 启用(见上方说明)

// 守卫挂起:全屏/最大化进出动画、显示器增减必然伴随窗口挪动(进全屏挪到 (0,0)、退出恢复原位、
// 最大化缩放、系统重排),期间若还按固定逻辑回弹会跟系统抢位置,导致卡顿甚至卡在半屏/半窗。
// 在这些过渡的触发点和完成事件处都挂起一段窗口,挂起期间所有 move 一律放行。
let suspendUntil = 0;      // 守卫挂起到此刻
function suspendGuard(ms) {
  suspendUntil = Date.now() + ms;
  dragUntil = 0;           // 清掉拖拽判定,避免过渡期残留状态带回稳态
}

// 退出确认:用户点 X / Alt+F4 关闭窗口时,若还有运行中的终端先弹确认框(避免误关把真实
// claude 会话杀掉);程序内退出(app.quit → before-quit)和已确认过的关闭直接放行。
// 确认框用应用自绘的 ConfirmDialog(与其它弹窗风格统一),主进程只负责拦截 close 并把
// 「要不要关」抛给渲染层,结果经 confirm-close / cancel-close IPC 回传驱动真正关闭。
let quitting = false;          // 已在退出流程中,关窗不再拦截
let confirmClose = false;      // 用户已在退出确认框点了「确定关闭」
let closePromptOpen = false;   // 退出确认框是否已展开(防连点 X 弹多个框)
let closePromptTimer = null;   // 确认请求兜底:渲染层长期无响应(如渲染进程异常)时自动复位,避免窗口永远关不掉

// 全屏切换:渲染层按钮与 F11 快捷键统一走这里,并把切换后的状态广播给渲染层(按钮图标同步)
function toggleFullscreen() {
  if (!win || win.isDestroyed()) return false;
  const next = !win.isFullScreen();
  suspendGuard(1500); // 进出全屏动画期间挂起守卫,避免与系统抢位置
  win.setFullScreen(next);
  win.webContents.send("fullscreen-event", next);
  return next;
}

// 事件总线:claude.cjs 吐出的事件 → (1) 落库 (2) push 给渲染进程
claude.setEmit(onSessionEvent);
// 终端事件:pty.cjs 的字节/打开/退出 → 直接转发给渲染层 xterm;
// 终端退出(Ctrl+C 等)同时停掉该会话的对话队列,避免对空终端续发
pty.setEmit((ev) => {
  if (win && !win.isDestroyed()) win.webContents.send("terminal-event", ev);
  if (ev && ev.type === "exit") tunnel.stop(ev.id);
  // 本地终端对话:claude 输出停止(静默)后,从 jsonl 增量同步上行到云端(按消息 id 去重)
  if (ev && ev.type === "data" && ev.id) armCloudSync(ev.id);
});
// 对话队列状态变化:同走 terminal-event 通道(渲染层按 type==="tunnel" 刷新弹窗状态)
tunnel.setEmit((ev) => {
  if (win && !win.isDestroyed()) win.webContents.send("terminal-event", ev);
});

// ---- 云历史上行:把结构化消息同步到服务器 DB(手机端离线也能看) ----
// upSeq 记录每个会话已上行到的序号;pendingAsst 记录「当前聚合中的 assistant 消息」,
// 待下一条 user / error / done 到来时才算完整并上行(与 persistence.appendBlock 同口径)。
const upSeq = new Map();       // sessionId -> 已上行到最后一条的 seq
const pendingAsst = new Map(); // sessionId -> { messageId, blocks:[] }
const cloudUuids = new Map();  // sessionId -> Set<消息id>:已由 jsonl 同步上行的消息(避免本地/手机同轮重复上行)
const choicePending = new Set(); // sessionId:当前回答已标 awaiting/choice 且尚未有新答案 → 防同轮重复标(见 markPendingChoice)

function pushUp(id, msg) {
  const seq = (upSeq.get(id) || 0) + 1;
  upSeq.set(id, seq);
  bridge.uploadMessage(id, seq, msg);
}

// 从 claude 会话 jsonl 提取真实对话消息(统一权威源)。jsonl 是 claude 自己每轮落盘的结构化记录:
//   - 真实用户行:message.content 为字符串、promptSource==="typed"、非系统注入(## Context Usage)、非 sidechain
//   - assistant 回答按 message.id 聚合多行 text 块;text 为空(纯 tool_use/thinking)跳过
// 返回按 jsonl 出现顺序的 [{messageId, role, text, ts}]
function extractJsonlMessages(session) {
  if (!session || !session.claudeSessionId) return [];
  const file = contextmon.findSessionJsonl(session.id, session);
  if (!file) return [];
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { log.log("warn", `读取会话 jsonl 提取消息失败: ${file} :: ${e && e.message}`); return []; }
  const out = [];
  const asstIdx = new Map(); // message.id -> out 索引(同一回答多行 jsonl 聚合)
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || !d.type) continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (d.type === "user") {
      const c = d.message && d.message.content;
      if (typeof c !== "string" || !c.trim()) continue; // 只取字符串 content(真实输入)
      if (d.isSidechain) continue;                      // 侧链/工具衍生不入库
      // 来源:typed(界面输入)/user(-p 等)/空,都视为真实输入;系统注入(## 标题等)靠下面过滤
      if (d.promptSource && d.promptSource !== "typed" && d.promptSource !== "user") continue;
      if (/^\s*##\s/.test(c)) continue;                 // 排除 ## Context Usage 等系统注入
      out.push({ messageId: String(d.uuid || ""), role: "user", text: c.trim(), ts });
    } else if (d.type === "assistant") {
      const id = d.message && d.message.id;
      if (!id) continue;
      let idx = asstIdx.get(id);
      if (idx === undefined) {
        idx = out.length;
        asstIdx.set(id, idx);
        out.push({ messageId: id, role: "assistant", text: "", ts });
      }
      const cc = d.message.content;
      if (Array.isArray(cc)) {
        for (const blk of cc) if (blk && blk.type === "text" && blk.text) out[idx].text += blk.text;
      } else if (typeof cc === "string") out[idx].text += cc;
    }
  }
  return out.filter((m) => !(m.role === "assistant" && !m.text.trim()));
}

// 剥离选项文字前导编号(「1 苹果」→「苹果」,序号由 key 提供)与装饰字符,
// 避免手机端按钮渲染出「1 1 苹果」这类重复序号。
function cleanLabelNum(x) {
  let t = String(x || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[#*([{]+/, "");
  t = t.replace(/^\d+\s*[.、)】\]]?\s*/, "");
  t = t.replace(/^[-–—·•]+\s*/, "");
  return t;
}

// 从 claude jsonl 提取最近一次 AskUserQuestion 的干净选择器(权威源)。
// bridge 从 pty 字节流猜的 options 会被 TUI 重绘/勾选标记污染(如「选苹果」「[]2 香蕉」),
// 而 jsonl 的 tool_use.input.questions[0] 是结构化的 question / multiSelect / options[{label,description}],
// 以此为准可让手机端复选框正确且干净。返回 null 表示 jsonl 里无可用选择器。
function extractChooserFromJsonl(session) {
  if (!session) return null;
  const file = contextmon.findSessionJsonl(session.id, session);
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { log.log("warn", `读取会话 jsonl 提取选择器失败: ${file} :: ${e && e.message}`); return null; }
  let found = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type !== "assistant") continue;
    const cc = d.message && d.message.content;
    if (!Array.isArray(cc)) continue;
    for (const blk of cc) {
      if (blk && blk.type === "tool_use" && blk.name === "AskUserQuestion") found = blk; // 取文件里最新一次
    }
  }
  const q = found && found.input && Array.isArray(found.input.questions) ? found.input.questions[0] : null;
  if (!q || !Array.isArray(q.options) || !q.options.length) return null;
  const options = q.options.map((o, i) => ({
    key: String(i + 1),
    label: cleanLabelNum(String(o.label || "选项 " + (i + 1))),
  }));
  return { question: String(q.question || ""), options, multiSelect: !!q.multiSelect };
}

// 统一 jsonl 权威源:把某会话在 claude jsonl 里的真实对话增量上行到云端(按消息 id 去重)。
// 本地终端输入 / 手机 exec / -p 结构化对话最终都落在 claude jsonl,这里统一提取上行,
// 保证 PC 端与手机端看到同一份内容,且同一条消息不会重复入库。
function syncToCloud(sessionId) {
  const id = String(sessionId);
  const s = persistence.getSession(id);
  if (!s) return;
  const msgs = extractJsonlMessages(s);
  if (!msgs.length) return;
  // 已上行集合:优先内存,首次从 session 的 cloudUuids 恢复(防重启重复)
  if (!cloudUuids.has(id)) {
    cloudUuids.set(id, new Set(Array.isArray(s.cloudUuids) ? s.cloudUuids : []));
  }
  // 恢复 seq 计数,避免重启后从 1 重数覆盖数据库已有消息。
  // cloudSeq 是精确起点;旧会话无该字段时用 cloudUuids 长度近似(纯 jsonl 对话 seq 与已上行数一致)。
  if (!upSeq.has(id)) {
    upSeq.set(id, Number(s.cloudSeq) || (Array.isArray(s.cloudUuids) ? s.cloudUuids.length : 0));
  }
  const done = cloudUuids.get(id);
  let changed = false;
  for (const m of msgs) {
    if (!m.messageId || done.has(m.messageId)) continue;
    const msg = { role: m.role, text: m.text, messageId: m.messageId, ts: m.ts || Date.now() };
    if (m.role === "assistant") {
      msg.blocks = [{ type: "text", text: m.text }];
      msg.status = "done";
      msg.type = "text";
      choicePending.delete(id); // 选择器已有新答案(done/text),下一轮新选择器才需重新标 awaiting/choice
    }
    pushUp(id, msg);
    done.add(m.messageId);
    changed = true;
  }
  if (changed) {
    persistence.saveCloudUuids(id, [...done], upSeq.get(id));
  }
}

// pty 本地终端输入后,claude 输出静默片刻即视为答完,触发一次 jsonl 增量同步
const cloudSyncTimers = new Map(); // sessionId -> timer
function armCloudSync(sessionId) {
  const id = String(sessionId);
  const t = cloudSyncTimers.get(id);
  if (t) clearTimeout(t);
  cloudSyncTimers.set(id, setTimeout(() => { cloudSyncTimers.delete(id); syncToCloud(id); }, 3000));
}
// 上行当前聚合中的 assistant 消息并清空(同一 messageId 的块在此合并成一条完整消息);
// extra 可附 status/type/options,用于把「停在选择器」的回答标成 awaiting/choice
function flushPendingAsst(id, extra) {
  const p = pendingAsst.get(id);
  if (!p || !p.blocks || !p.blocks.length) { pendingAsst.delete(id); return; }
  pushUp(id, { role: "assistant", blocks: p.blocks, messageId: p.messageId, ts: Date.now(), ...(extra || {}) });
  pendingAsst.delete(id);
}
// 回答停在 claude 原生选择器(bridge 的 onChooser 回调):把当前回答标为 awaiting/choice 并上行。
// 先同步一次 jsonl 把该轮 user 消息上行(顺序 user → choice),再补 choice 标记,
// 手机端从 DB 历史恢复时能还原成带选项按钮的选择卡。
// multiSelect(复选框)时 type 用 choice-checkbox,手机端据此渲染「勾多个+提交」而非单选按钮。
// 幂等:同一轮选择器会被 chooserFn(bridge.handleExec)与 cloudMsgFn 的 choice 字段**先后触发两次**,
// 若不拦会把同一轮标成两条 awaiting/choice(手机端历史出现两张重复选择卡)。故用 choicePending 标记,
// 该会话一旦标过 awaiting/choice,在出现新答案(active turn 完成)前不再重复标。
function markPendingChoice(id, options, text, multiSelect) {
  syncToCloud(id);
  // 以 jsonl 权威选择器为准:干净 options/multiSelect/question 覆盖 bridge 从 pty 字节流猜的脏值,
  // 否则手机端复选框会出现「选苹果」「[]2 香蕉」等 TUI 残留,且多选可能被误判成单选。
  const s = persistence.getSession(id);
  const jc = extractChooserFromJsonl(s);
  if (jc && jc.options && jc.options.length) {
    options = jc.options;
    multiSelect = jc.multiSelect;
    if (jc.question) text = jc.question;
  }
  if (!choicePending.has(id)) {
    const extra = { status: "awaiting", type: multiSelect ? "choice-checkbox" : "choice", options };
    const p = pendingAsst.get(id);
    if (p && p.blocks && p.blocks.length) {
      flushPendingAsst(id, extra);
    } else {
      pushUp(id, { role: "assistant", blocks: [{ type: "text", text: text || "（等待选择）" }], messageId: null, ts: Date.now(), ...extra });
    }
    choicePending.add(id);
  }
  return jc; // 返回 jsonl 干净选择器,供 bridge 即时回显保持一致(避免手机端先看到脏按钮)
}
// 手机端触发的对话(bridge 的 onCloudMessage 回调):统一走 jsonl 权威源增量入库。
// 手机发消息时 bridge 已把文本注入 PTY claude,claude 会把它写进 jsonl,
// 故这里只触发 syncToCloud 提取上行(user + assistant),不再单独构造消息,避免与 jsonl 重复。
function handleCloudMessage(ev) {
  if (!ev || !ev.sessionId) return;
  const id = String(ev.sessionId);
  syncToCloud(id);
  // 选择器场景:jsonl 里该 assistant 无正文(纯工具调用),syncToCloud 会跳过,
  // 这里单独把它标为 awaiting/choice 上行,让手机端历史能还原成选择卡
  if (ev.choice && ev.choice.length) markPendingChoice(id, ev.choice, ev.answerText, ev.choiceMulti);
}
// 断线重连后全量对账:对每个会话重传元信息 + 从 claude jsonl 增量同步消息(jsonl 幂等 + 按消息 id 去重,
// 补齐断线期间丢的消息,不重复)
function reconcileCloudHistory() {
  for (const meta of persistence.listSessions()) {
    const s = persistence.getSession(meta.id);
    if (!s) continue;
    bridge.uploadSession(s);
    syncToCloud(s.id);
  }
}

function onSessionEvent(ev) {
  // 落盘日志只在关键事件打点(stream 每块一行会刷屏,不记)
  if (ev.type !== "stream") {
    log.log("info", `[session] ${ev.type} id=${ev.id}${ev.jobKey ? " job=" + ev.jobKey : ""}${ev.message ? " msg=" + String(ev.message).slice(0, 300) : ""}`);
  }
  try {
    if (ev.type === "user-message") {
      // 本地落库 + 上屏;云上行统一交给 syncToCloud(jsonl 权威源),避免与 jsonl 重复上行
      persistence.appendMessage(ev.id, { role: "user", text: ev.text, ts: Date.now() });
      persistence.flush(ev.id);
    } else if (ev.type === "stream") {
      // assistant 流式块:本地按 messageId 聚合落库;pendingAsst 仅用于 choice 标记判断,不再用于上行
      persistence.appendBlock(ev.id, ev.messageId, ev.block);
      const p = pendingAsst.get(ev.id);
      if (!p || p.messageId !== ev.messageId) {
        pendingAsst.set(ev.id, { messageId: ev.messageId, blocks: [ev.block] });
      } else {
        p.blocks.push(ev.block);
      }
    } else if (ev.type === "error" && ev.message) {
      // 系统级错误(启动失败/目录不存在/异常退出):jsonl 无记录,保留本地落库 + 云上行
      persistence.appendMessage(ev.id, { role: "ui", blocks: [{ type: "error", text: ev.message }], ts: Date.now() });
      persistence.flush(ev.id);
      flushPendingAsst(ev.id, { status: "done", type: "text" });
      pushUp(ev.id, { role: "ui", blocks: [{ type: "error", text: ev.message }], ts: Date.now() });
    } else if (ev.type === "done") {
      // claudeSessionId 已在 claude.cjs 的 recordDone 中落盘;到此一条 assistant 回复完整,触发 jsonl 同步上行
      persistence.flush(ev.id);
      pendingAsst.delete(ev.id);
      choicePending.delete(ev.id); // 本轮说完,若之前停在选择器,现已有最终答案,后续新选择器重新标
      syncToCloud(ev.id);
    }
  } catch (err) {
    console.error("事件落库失败:", err);
  }
  if (win && !win.isDestroyed()) win.webContents.send("session-event", ev);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1260,
    height: 800,
    title: "Claude Desk",
    backgroundColor: "#0d1117",
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 窗口固定守卫:见文件头 pinnedPos 说明。最大化/全屏/最小化一律放行,不与系统抢位置。
  // 显示器增减/分辨率变化:系统会重新摆放窗口,直接认可新位置(并短暂挂起),避免守卫跟系统抢
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(ev, () => {
      if (!win || win.isDestroyed()) return;
      pinnedPos = win.getPosition();
      suspendGuard(800);
    });
  }
  // 窗口固定守卫(见文件头 pinnedPos 说明):move/resize 共用,另加 500ms 看门狗兜底。
  // 主要防护中文输入刚开始(IME 组合激活)时偶发的整体/边缘位移;任何非拖拽的偏离一律回弹。
  pinnedPos = win.getPosition();
  // 每个几何事件都基于最新状态重新判定是否拖拽/拉伸:<250ms 内有连续事件 = 用户操作(跟随
  // 更新固定位);否则视为输入法/系统误移,偏离固定位就回弹。注意每次都要重算 dragging,
  // 拖拽一旦松手即自动恢复守卫(否则拖过一次窗就永久失效,后续位移全被放行)。
  const geometryEvent = () => {
    if (!PIN_GUARD_ON) return; // 非 Windows:不启用(Linux 拖窗 move 不连续,会误判回弹)
    if (!armed || reverting || !win || win.isDestroyed()) return;
    if (Date.now() < suspendUntil) return; // 全屏/最大化过渡期:放行
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
    const now = Date.now();
    const cur = win.getPosition();
    const dragging = now < dragUntil;
    dragUntil = now + 250; // 拖/拉脱手窗口:250ms 内无新事件即恢复守卫
    if (dragging) { pinnedPos = cur; return; } // 用户操作:跟随并更新固定位
    if (pinnedPos && (cur[0] !== pinnedPos[0] || cur[1] !== pinnedPos[1])) {
      // 非拖拽却被移动 = 输入法/系统误移 → 回弹,并落盘日志便于 Win 端排查
      reverting = true;
      win.setPosition(pinnedPos[0], pinnedPos[1]);
      setTimeout(() => (reverting = false), 150);
      log.log("warn", `[window-pin] 检测到非拖拽位移,回弹 (${cur[0]},${cur[1]}) -> (${pinnedPos[0]},${pinnedPos[1]})`);
    }
  };
  win.on("move", geometryEvent);   // 整体位移
  win.on("resize", geometryEvent); // 左/上边缘被改导致的位移
  // 看门狗:不参与拖拽判定、不刷新 dragUntil,只盯住位置,兜住"事件漏网"的位移
  setInterval(() => {
    if (!PIN_GUARD_ON) return;
    if (!armed || reverting || !win || win.isDestroyed()) return;
    if (Date.now() < suspendUntil) return;
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
    const cur = win.getPosition();
    if (pinnedPos && (cur[0] !== pinnedPos[0] || cur[1] !== pinnedPos[1])) {
      reverting = true;
      win.setPosition(pinnedPos[0], pinnedPos[1]);
      setTimeout(() => (reverting = false), 150);
    }
  }, 500);
  // 全屏/最大化状态事件:覆盖非 toggleFullscreen 触发的过渡(Win+↑ 最大化、双击标题栏、Esc 退出等),
  // 在过渡完成附近也挂起守卫,兜住动画收尾阶段的残余 move
  win.on("maximize", () => suspendGuard(1200));
  win.on("unmaximize", () => suspendGuard(1200));
  win.on("enter-full-screen", () => suspendGuard(1200));
  win.on("leave-full-screen", () => suspendGuard(1200));
  win.on("enter-html-full-screen", () => suspendGuard(1200));
  win.on("leave-html-full-screen", () => suspendGuard(1200));
  // 首 1.5s 放行:等系统完成初始摆位/居中后再武装守卫,避免跟系统抢初始位置
  setTimeout(() => { armed = true; pinnedPos = win.getPosition(); }, 1500);
  // 关闭守卫:有运行中的终端时先弹确认框(应用自绘 ConfirmDialog,与其它弹窗风格统一),
  // 防误关把真实 claude 会话连带杀掉。原本用原生 dialog.showMessageBox,风格与自绘组件
  // 不统一,改为:拦截 close → send close-request 给渲染层 → 渲染层弹框 → 结果 IPC 回传。
  win.on("close", (e) => {
    if (confirmClose || quitting) return;         // 已确认 / 程序内退出:放行
    // 设置「关闭=缩到托盘」:点 X 只藏到系统托盘(进程、终端、后台任务全都不停),
    // 点托盘图标 / 托盘菜单「打开」再恢复;彻底退出走托盘菜单「退出」
    if ((persistence.loadSettings().closeAction || "exit") === "tray") {
      e.preventDefault();
      win.hide();
      return;
    }
    const n = pty.openCount();
    if (n === 0) return;                                 // 无运行中的终端:直接放行
    e.preventDefault();                                  // 有终端在跑:先拦截
    if (closePromptOpen) return;                         // 确认框已在弹,再点 X 忽略
    closePromptOpen = true;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) { closePromptOpen = false; return; }
    wc.send("close-request", { n });                     // 抛给渲染层弹应用风格确认框
    // 兜底:渲染层 30s 内既不确认也不取消(渲染进程异常等),复位拦截位,用户还能再点 X 重试
    closePromptTimer = setTimeout(() => { closePromptOpen = false; closePromptTimer = null; }, 30000);
  });
  // 拦截新窗口/外链:一律不开新 BrowserWindow,交给系统浏览器,防丢 preload 上下文
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  // F11 全屏/退出全屏(菜单已被移除,默认快捷键丢失,这里补回)
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      e.preventDefault();
      toggleFullscreen();
    }
  });
  win.webContents.on("will-navigate", (e, url) => {
    // 只允许应用自己的 http://127.0.0.1:* 页面内导航
    if (!url.startsWith("http://127.0.0.1:")) {
      e.preventDefault();
      if (url.startsWith("http")) shell.openExternal(url);
    }
  });

  // 渲染进程的 JS 报错/警告:统一转发到主进程 stdout 方便排查
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message}`);
  });

  // 立即先显示内置启动页(窗口出现即有内容,不等后面静态服务/前端产物),
  // 静态服务就绪后再 loadURL 切到正式界面 —— 先见窗口、内容随后加载,提升启动体感
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(bootHTML()));

  // 用内置 HTTP server 提供前端构建产物(sirv single:true 提供 SPA fallback)
  const serve = sirv(path.join(__dirname, "..", "build"), {
    dev: false,
    single: true,
  });
  const server = createServer((req, res) => serve(req, res));
  server.listen(0, "127.0.0.1", () => {
    global.__baseUrl = `http://127.0.0.1:${server.address().port}/`;
    // 调试/验收:设置 CD_SPLASH_MS=… 让启动页多停几秒,肉眼确认 logo+转圈效果
    // (本地源码启动时 boot 页通常一闪而过看不出;默认 0 = 不作停留,不影响启动速度)
    const hold = Number(process.env.CD_SPLASH_MS) || 0;
    const go = () => win.loadURL(global.__baseUrl);
    if (hold > 0) setTimeout(go, hold);
    else go();
  });

  // 自测模式:注入端到端步骤,最后输出 AUTOTEST_OK/FAIL(逻辑见 autotest.cjs)
  if (process.env.CD_AUTOTEST === "1") require("./autotest.cjs").runAutotest(win);
  // 终端自测(终端形态 A):建会话→进对话页→验证 xterm 渲染真实 claude→关闭→删除
  if (process.env.CD_TERM_AUTOTEST === "1") require("./autotest.cjs").runTermAutotest(win);
  // 云连接自测:起本地中转 → 设置页开云 → 手机角色全流程(见 autotest.cjs runCloudAutotest)
  if (process.env.CD_CLOUD_AUTOTEST === "1") require("./autotest.cjs").runCloudAutotest(win);
  // 上下文压测:持续喂消息观察统计增长/自动压缩(见 ctxdrive.cjs)
  if (process.env.CD_CTX_AUTOTEST === "1") require("./ctxdrive.cjs")(win);
}

ipcMain.handle("session-create", (_e, meta) => {
  const s = persistence.createSession(meta || {});
  bridge.uploadSession(s);
  return s;
});
ipcMain.handle("session-list", () => {
  return persistence.listSessions();
});
ipcMain.handle("session-get", (_e, id) => {
  if (typeof id !== "string") throw new Error("缺 id");
  return persistence.loadSession(id);
});
ipcMain.handle("session-update", (_e, id, patch) => {
  const s = persistence.updateSession(id, patch);
  if (s) bridge.uploadSession(s);
  return s;
});
ipcMain.handle("session-delete", (_e, id) => {
  pty.close(id); // 运行中删除会话:先关掉它的终端(实录已在 close 内落盘再多删)
  claude.killSession(id);
  persistence.deleteSession(id);
  return true;
});
ipcMain.handle("session-send", (_e, id, text) => {
  if (typeof text !== "string" || !text.trim()) return { error: "消息为空" };
  const s = persistence.getSession(id);
  if (!s) return { error: "会话不存在" };
  if (pty.isOpen(id)) return { error: "该会话已在终端打开,请在终端里操作" };
  if (claude.isRunning(id)) return { error: "该会话正在运行,请先停止" };
  const msg = text.trim();
  // 首条消息 → 自动生成标题(取前 20 字),无需用户手填
  const isDefaultTitle = !s.title || s.title === "未命名会话" || s.title.startsWith("会话");
  if (isDefaultTitle && (s.messages || []).length === 0) {
    persistence.updateSession(id, { title: msg.slice(0, 20) });
  }
  // 先落库用户消息(通过事件总线,渲染端也会经它上屏)
  onSessionEvent({ type: "user-message", id, text: msg });
  const r = claude.runClaude(id, msg, {
    cwd: s.cwd,
    argText: s.argText,
    claudeSessionId: s.claudeSessionId,
    skipPermissions: s.skipPermissions,
  });
  return r;
});
ipcMain.handle("session-stop", (_e, id) => {
  // 终端打开的会话:停止 = 关闭该终端;否则关掉 -p 进程
  if (pty.isOpen(id)) return { closed: pty.close(id), terminal: true };
  return claude.stopSession(id);
});
// 从 jsonl 头部提取首条用户提问(恢复对话列表的标题):只读前 128KB,跳过一次元信息/命令回显
function firstPromptOf(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(131072);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString("utf8").split("\n")) {
      if (!line || line.indexOf('"user"') < 0) continue;
      let o = null;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || o.type !== "user" || o.isMeta) continue;
      const c = o.message && o.message.content;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) {
        const tb = c.find((b) => b && b.type === "text");
        t = tb ? tb.text : "";
      }
      t = String(t || "").replace(/\s+/g, " ").trim();
      if (!t || t.startsWith("<command") || t.startsWith("<local-command") || t.startsWith("Caveat:")) continue;
      return t.length > 60 ? t.slice(0, 60) + "…" : t;
    }
  } catch {}
  return "";
}

// 恢复对话候选:进入会话时渲染层先查——终端活着(running)直接重附着;
// 否则列出历史 claude session(含占用/疑似外部运行标记),弹三选(继续上次/选历史/新对话)
ipcMain.handle("terminal-candidates", (_e, id) => {
  if (typeof id !== "string") return { error: "缺 id" };
  const s = persistence.getSession(id);
  if (!s) return { error: "会话不存在" };
  if (pty.isOpen(id)) return { running: true, sessions: [] };
  const busy = pty.busyClaudeIds(id); // 本应用其它终端正在占用的 claude session
  // 磁盘全量(按 jsonl 内 cwd 字段精确归属,跨平台):不再只列本应用捕获过的——
  // 首次使用/换机/旧版无捕获记录时,磁盘上已有的 claude 历史会话也能列出(否则 win 新版必然为空不弹窗)
  const files = contextmon.sessionFilesOf(s.cwd);
  const onDisk = new Set(files.map((f) => f.id));
  const list = [];
  for (const f of files) {
    if (list.length >= 10) break; // 与 claudeSessions 上限一致,弹窗只列最近 10 个
    const isBusy = busy.has(f.id);
    list.push({
      id: f.id,
      at: f.at, // 最后活跃 = jsonl mtime
      firstPrompt: firstPromptOf(f.file),
      busy: isBusy,
      // 最近 15s 还在被写但不归本应用任何终端 → 疑似外部 claude 正在跑(警告不禁止,用户定夺)
      hot: !isBusy && Date.now() - f.at < 15000,
    });
  }
  // 记录在案但磁盘已无(jsonl 被清理)→ 从会话历史剔除
  for (const item of Array.isArray(s.claudeSessions) ? s.claudeSessions : []) {
    if (item && item.id && !onDisk.has(item.id)) persistence.removeClaudeSession(id, item.id);
  }
  return { running: false, sessions: list };
});

// ---- 终端会话(PTY):打开/写入/缩放/关闭,渲染层 xterm 经此双向流 ----
ipcMain.handle("terminal-open", (_e, id, resumeId) => {
  if (typeof id !== "string") return { error: "缺 id" };
  const s = persistence.getSession(id);
  if (!s) return { error: "会话不存在" };
  if (claude.isRunning(id)) return { error: "该会话有 -p 任务在运行,请先停止" };
  return pty.open(id, { cwd: s.cwd, argText: s.argText, skipPermissions: !!s.skipPermissions, resumeId: typeof resumeId === "string" ? resumeId : "" });
});
ipcMain.handle("terminal-write", (_e, id, data) => {
  return pty.write(id, typeof data === "string" ? data : "");
});
ipcMain.handle("terminal-resize", (_e, id, cols, rows) => {
  return pty.resize(id, cols, rows);
});
ipcMain.handle("terminal-size-of", (_e, id) => {
  // 自测用:查询 node-pty 侧当前行列,断言 claude 实际渲染尺寸已同步(输入行贴底)
  return pty.sizeOf(id);
});
// 对话队列:保存(新建/修改/删除条目)、查询、开始/暂停/停止
ipcMain.handle("tunnel-save", (_e, id, items) => tunnel.save(id, items));
ipcMain.handle("tunnel-state", (_e, id) => tunnel.stateOf(id));
ipcMain.handle("tunnel-start", (_e, id) => tunnel.start(id));
ipcMain.handle("tunnel-pause", (_e, id) => tunnel.pause(id));
ipcMain.handle("tunnel-stop", (_e, id) => tunnel.stop(id));
ipcMain.handle("terminal-close", (_e, id) => {
  return pty.close(id);
});
// 监控面板:向当前终端发斜杠命令捕获输出(/context),以及一键压缩上下文(/compact 自动应答确认)
ipcMain.handle("terminal-command", (_e, id, cmd) => pty.command(id, cmd));
ipcMain.handle("terminal-compact", (_e, id) => pty.compact(id));
// 用户最近一次提交提问(回车)时刻,供纪要面板做「问完答完才总结」的触发判定
ipcMain.handle("terminal-last-input-at", (_e, id) => pty.lastUserAtOf(id));
// 上下文监控:工具面板底部实时显示「已用/窗口」,主进程读 jsonl 精确值或估算兜底
ipcMain.handle("context-state", (_e, id) => contextmon.contextState(id));
// 与 claude 原版对齐:向终端发 /context 并解析它报告的「已用/窗口」实数,供面板显示同款读数。
// window 上限仍按用户自定义 maxTokens 优先(自定义窗口覆盖 claude 的 Auto-compact window,百分比一致重算)。
// 解析多级兜底:① 主行 `19.4k/200k tokens (10%)` ② 窄终端主行被 TUI 裁剪时,用
// Auto-compact window(窗口)+ 分类明细(Systemprompt/Systemtools/… )求和(已用)。
// 终端未开 / 数值解析失败返回 {error} (+clue 视图片段),前端回退 jsonl 统计。
ipcMain.handle("context-cli", async (_e, id) => {
  // TUI 分帧绘制,短的 idle 判定可能只截到半屏 → 首次失败增加等待重试一次
  const attempt = async (idleMs) => {
    const r = await pty.command(id, "/context\r", { idleMs, minMs: 900, timeoutMs: 15000 }).catch(() => null);
    const t = (r && !r.error && r.text) || "";
    if (/Autocompact window|Auto-compact window|Context Usage|Estimated usage/i.test(t)) return t;
    return "";
  };
  const t = (await attempt(600)) || (await attempt(1400));
  if (!t) return { error: "终端未运行或 /context 无输出,请在终端查看" };

  const num = (s) => {
    if (!s) return 0;
    const u = String(s).slice(-1).toLowerCase();
    const v = parseFloat(s);
    if (u === "m") return Math.round(v * 1e6);
    if (u === "k") return Math.round(v * 1e3);
    return Number.isNaN(v) ? 0 : Math.round(v);
  };
  // 主行:`19.4k/200k tokens (10%)`(容忍 tokens 与括号间无空格)
  const M = /(\d+(?:\.\d+)?[kKmM]?)\s*\/\s*(\d+(?:\.\d+)?[kKmM]?)\s*tokens?\s*(?:\((\d+(?:\.\d+)?)\s*%\))?/i.exec(t);
  // 窗口行(各宽度均有):`Auto-compact window: 200k tokens`(auto-compact 带连字符)
  const W = /auto-?\s*compact\s*window\s*[:：]?\s*(\d+(?:\.\d+)?[kKmM]?)\s*tokens/i.exec(t);
  // 分类明细(System prompt 兼容 Systemprompt 紧凑写法):`Systemprompt:1.5k tokens` 等
  const CATS = /(system\s*prompt|system\s*tools|memory\s*files|skills|messages)\s*[:：]\s*(\d+(?:\.\d+)?[kKmM]?)\s*tokens?/gi;

  let used = M ? num(M[1]) : 0;
  let window = M ? num(M[2]) : 0;
  let cliPct = M && M[3] != null ? parseFloat(M[3]) / 100 : null;
  if (!window && W) window = num(W[1]);
  if (used <= 0) {
    // 主行被裁剪:分类求和 ≈ claude 的「已用」
    let acc = 0;
    let mm;
    CATS.lastIndex = 0;
    while ((mm = CATS.exec(t))) acc += num(mm[2]);
    if (acc > 0) { used = acc; cliPct = null; } // 求和口径,百分比由窗口重算
  }
  if (used <= 0 || window <= 0) {
    const clue = t.split("\n").map((s) => s.trim()).filter((s) => /\d/.test(s) && /token|window|context/i.test(s)).slice(0, 6).join(" ⏎ ");
    return { error: "未能从 /context 读到关键数值", clue };
  }
  const manual = Number((persistence.getSession(id) || {}).maxTokens) || 0;
  const effMax = manual > 0 ? manual : window; // 用户自定义上限优先
  const pct = manual > 0 ? used / (effMax || 1) : (cliPct != null ? cliPct : used / (effMax || 1));
  return {
    ok: true,
    used,
    max: window,
    pct: Math.min(1, pct),
    cliPct: Math.round((cliPct != null ? cliPct : pct) * 100),
    manual: manual > 0,
    usedText: contextmon.fmt(used),
    maxText: contextmon.fmt(effMax),
    cliMaxText: contextmon.fmt(window),
    raw: t.slice(-300),
  };
});
// 把会话 messages 摊平成「用户/Claude」对话文本,供总结/压缩使用
function transcriptOf(s) {
  const parts = [];
  for (const m of s.messages || []) {
    if (m.role === "user") parts.push(`用户: ${m.text || ""}`);
    else if (m.role === "assistant") {
      for (const b of m.blocks || []) if (b.type === "text") parts.push(`Claude: ${b.text}`);
    }
  }
  return parts.join("\n").slice(0, 60000);
}

// 纪要时间:格式化 Date 或符合「2026/9/2 18:30:45」的实录分隔头 → MM-DD HH:mm
function shortTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// 取文本里最后一个「[ --- 终端实录 2026/9/2 18:30:45 --- ]」分隔头的时间(转 MM-DD HH:mm)
function lastRunTime(segment) {
  const re = /\[ --- 终端实录 ([^\]]+) --- \]/g;
  let m, t = "";
  while ((m = re.exec(segment)) && m[1]) t = m[1];
  if (!t) return "";
  const s = t.match(/(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})[ T]?(\d{1,2}:\d{2})/);
  if (s) {
    const [, date, hm] = s;
    const mmdd = date.split(/[\/-]/).slice(1).join("-");
    return `${mmdd} ${hm}`;
  }
  return t;
}

// 取文本最后一段「[ --- 终端实录 … --- ]」分隔头的整行(含首尾换行),作为纪要增量锚:
// 实录落盘在头部会被 MAX_RAW 截断、运行中还会临时换 liveTranscript 尾段,按「字符长度偏移」
// 定位新增段必然整体错位(表现为每次从头重总结);分隔头只增不截、恒在尾部,以它定位才稳定。
function lastRunHead(body) {
  const re = /\n\n\[ --- 终端实录 [^\]]+ --- \]\n/g;
  let m, last = "";
  while ((m = re.exec(String(body || "")))) last = m[0];
  return last;
}

ipcMain.handle("ai-summary", async (_e, id, force) => {
  // 对话纪要(增量持久化):只把「上次总结后新增的实录」交给真实 claude 追加成条目,合并进
  // 该会话持久化的 session.summary。无新增直接返回已有纪要 —— 点开面板不再全量重新生成。
  // 时间由应用侧注入精确时刻,每条【MM-DD HH:mm】不依赖模型猜。
  const s = persistence.getSession(id);
  if (!s) return { ok: false, error: "会话不存在" };
  // 总结源统一用【落盘 transcript】:pty 每 6s 节流落盘、且是追加式(旧内容不变只尾部增长)。
  // 不用 liveTranscript 尾段(它是 raw 尾部切片,与落盘结构不同,混用会让长度锚整体错位
  // —— 正是「每次从头重新总结」的根因)。
  let body = (s.transcript || "").trim();
  if (!body.trim()) body = transcriptOf(s);
  if (!body.trim()) return { ok: false, error: "暂无可总结的对话内容" };

  const summary = (s.summary && s.summary.text) || "";
  const prevLen = (s.summary && s.summary.len) ?? null;
  const prevHead = (s.summary && s.summary.head) || "";
  // 新增段定位:
  //   主锚 = 上次总结时的全文长度(transcript 追加式,slice(prevLen) 就是精确新增 → 逐轮增量,
  //          不重复、不从头);
  //   兜底 = 全文被裁剪(超长会话头部被 MAX_RAW 截断,prevLen 错位)时,改用「最后一个实录
  //          分隔头」之后做全量续(head 在尾部只增不截,定位稳定)。
  // force 手动全量重提,忽略全部锚。
  let seg;
  if (force) seg = body;
  else if (prevLen != null && prevLen <= body.length) {
    seg = body.slice(prevLen);
  } else if (prevHead && body.includes(prevHead)) {
    const i = body.lastIndexOf(prevHead);
    seg = body.slice(i + prevHead.length);
  } else seg = body; // 无锚/首次 → 全量
  // 无新增且已有纪要 → 直接返回,不调 claude(点开面板秒出)
  if (!force && !seg.trim()) {
    return { ok: true, text: summary || "（本会话暂无新增对话）", cached: true };
  }
  // 参考时间:新增段里最后一个「终端实录 日期 时分秒」分隔头,没有就用当前时间
  const refTime = lastRunTime(seg) || shortTime(new Date());
  const prompt = (force || !summary)
    ? `请把下面这段「Claude Code 终端会话实录」整理成一份简短问答总结，用中文，要求：
- 逐条列出每次用户提问与 Claude 的回答要旨，格式：
【时:分】👤 用户问题
🤖 回答要旨（一两句话，提炼结论/关键点即可，不要复述过程）
- 分清「谁问的」：实录中以 ❯ 开头的行才是用户实际输入的问题；其余正文是 Claude/TUI 的输出（包括 Claude 主动发起的确认/追问，如是否继续、权限确认等）
- 只有 ❯ 开头对应的用户提问才生成 👤 条目；Claude 自己问的确认/追问【不算用户提问】，不要为它们单独列出 👤 条目，其内容并入最近的 🤖 回答要旨
- 每条都必须带时间（如 【13:44】），时间由应用注入：这段对话发生在 ${refTime} 前后，可据此推断每条先后时刻；不要省略时间
- 🤖 后面直接写回答要旨，不要加「回答要旨」「Claude 回答」之类的说明前缀
- 不要章节标题、不要 Markdown 语法符号、不要任何客套话，直接输出条目
- 若实录中没有真实的问答内容，只输出一行：（本会话暂无问答内容）

会话实录：
${body}`
    : `这是同一条会话【新增加】的一段对话实录（发生在 ${refTime} 前后）。请按既有纪要同样的格式，把这段新增对话逐条追加成新条目：
【时:分】👤 用户问题
🤖 回答要旨（一两句话，提炼结论/关键点即可）
- 新增实录中只有以 ❯ 开头的行才是用户提问；Claude 自己发起的确认/追问不算用户提问，不要列成 👤
- 每条都必须带时间（如 【13:44】），参考 ${refTime} 前后推断先后时刻；不要省略时间
- 只输出新增条目，不要重复或总结已有内容，不要章节标题，不要「以下是新增」之类说明

新增实录：
${seg}`;
  const r = await claude.runSummary(prompt);
  if (!r.ok) return { ok: false, error: r.error || "总结失败" };
  // 合并:追加模式接在旧纪要后;全量模式直接替换并清掉「暂无问答内容」占位
  const fresh = String(r.text || "").trim();
  const oldClean = summary.replace(/（本会话暂无问答内容）\s*/, "").trim();
  const text = (force || !summary) ? fresh : [oldClean, fresh].filter(Boolean).join("\n\n");
  // 留痕:纪要文本 + 进度锚(全文长度,transcript 追加式下即精确续写点) + 末尾分隔头(裁剪兜底)
  persistence.updateSession(id, { summary: { text, len: body.length, head: lastRunHead(body) || prevHead, updatedAt: Date.now() } });
  return { ok: true, text, incremental: !force && !!summary };
});

ipcMain.handle("session-compact", async (_e, id) => {
  // 压缩上下文:把会话历史交给真实 claude 提炼成要点摘要,替换本地消息(降低持久化上下文量)
  const s = persistence.getSession(id);
  if (!s) return { ok: false, error: "会话不存在" };
  if (claude.isRunning(id)) return { ok: false, error: "该会话正在运行，请先停止再压缩" };
  const body = transcriptOf(s);
  if (!body.trim()) return { ok: false, error: "暂无可压缩内容" };
  const prompt = `请把下面这段「Claude Code 对话记录」压缩成一份要点式摘要（中文 Markdown），保留所有关键结论、代码/命令要点、用到的工具、未解决问题与下一步建议，长度控制在原文的 1/4 以内：\n\n对话记录：\n${body}`;
  const r = await claude.runSummary(prompt);
  if (!r.ok) return { ok: false, error: r.error || "压缩失败" };
  const res = persistence.compactSession(id, r.text);
  return { ok: true, ...(res || {}) };
});

ipcMain.handle("settings-get", () => {
  return persistence.loadSettings();
});
ipcMain.handle("settings-set", (_e, patch) => {
  const r = persistence.saveSettings(patch || {});
  // 设置切到「缩到托盘」时确保托盘已就位(否则窗口藏了就回不来);切回「退出」不主动销毁,留着无妨
  if (r && r.closeAction === "tray") ensureTray();
  return r;
});
// 应用自身版本(读取 package.json / 打包产物 version),供设置页「关于」展示
ipcMain.handle("app-version", () => app.getVersion());

// ---- 云连接(手机远程) ----
// 查询:云端配置 + 连接状态(设置页初始化/刷新)
ipcMain.handle("cloud-get", () => {
  const cloud = persistence.loadSettings().cloud || {};
  return { config: { serverUrl: cloud.serverUrl, token: cloud.token, deviceName: cloud.deviceName, autoStart: cloud.autoStart }, status: bridge.status() };
});
// 保存云端配置并应用:patch={serverUrl?,token?,deviceName?,autoStart?}
// autoStart=true → 立即连接;false → 断开。状态变化经 cloud-event 回推渲染层
ipcMain.handle("cloud-set", (_e, patch) => {
  const cloud = persistence.loadSettings().cloud || {};
  const next = {
    serverUrl: patch.serverUrl !== undefined ? patch.serverUrl : cloud.serverUrl,
    token: patch.token !== undefined ? patch.token : cloud.token,
    deviceName: patch.deviceName !== undefined ? patch.deviceName : cloud.deviceName,
    autoStart: patch.autoStart !== undefined ? patch.autoStart : cloud.autoStart,
  };
  persistence.saveSettings({ cloud: next });
  bridge.applyConfig(next);
  return { config: next, status: bridge.status() };
});

ipcMain.handle("configs-list", () => {
  return configs.listConfigFiles();
});
ipcMain.handle("config-read", (_e, name) => {
  return configs.readConfig(name);
});
ipcMain.handle("config-write", (_e, name, content) => {
  return configs.writeConfig(name, content);
});
ipcMain.handle("config-delete", (_e, name) => {
  return configs.deleteConfig(name);
});
// 命名配置模板(存应用 userData/config-templates.json)
ipcMain.handle("config-templates-list", () => {
  return configs.listTemplates();
});
ipcMain.handle("config-templates-get", (_e, id) => {
  return configs.getTemplate(id);
});
ipcMain.handle("config-templates-save", (_e, input) => {
  try {
    return { ok: true, ...configs.saveTemplate(input || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
});
ipcMain.handle("config-templates-delete", (_e, id) => {
  return configs.deleteTemplate(id);
});
ipcMain.handle("config-templates-apply", (_e, id) => {
  try {
    return configs.applyTemplate(id);
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
});
ipcMain.handle("pick-directory", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
// 探测二进制版本(spawn --version);Windows 的 claude.cmd 由 spawnClaude 自动经 cmd 执行
function probeVersion(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = claude.spawnClaude(bin, ["--version"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message) });
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, error: String(e.message) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, version: (out || err).trim() });
      else resolve({ ok: false, error: `退出码 ${code}: ${(err || out).trim()}` });
    });
  });
}

ipcMain.handle("open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle("set-fullscreen", () => toggleFullscreen());

// 窗口级主题:渲染层切亮/暗主题时同步 Win 原生标题栏(nativeTheme.themeSource 会驱动
// DWM 沉浸式深色模式,把白色系统标题栏置成深色,不再有白条);非 light 一律按 dark 处理
ipcMain.handle("set-window-theme", (_e, t) => {
  nativeTheme.themeSource = t === "light" ? "light" : "dark";
});

// 退出确认结果回传:渲染层 ConfirmDialog 点「确定关闭」→ 置放行位并真正关闭窗口
// (再次 close 命中头行 confirmClose 条件直接放行);点「取消」→ 仅复位拦截位。
function resetClosePrompt() {
  if (closePromptTimer) { clearTimeout(closePromptTimer); closePromptTimer = null; }
  closePromptOpen = false;
}
ipcMain.handle("confirm-close", () => {
  resetClosePrompt();
  confirmClose = true;
  const w = BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.close();
});
ipcMain.handle("cancel-close", () => {
  resetClosePrompt();
});

// 剪贴板桥:终端复制/粘贴走主进程(渲染层 navigator.clipboard 需授权,主进程 clipboard 最稳且不限上下文)
ipcMain.handle("clipboard-read", () => {
  try { return clipboard.readText(); } catch { return ""; }
});
ipcMain.handle("clipboard-write", (_e, text) => {
  try { clipboard.writeText(String(text ?? "")); } catch {}
  return true;
});

ipcMain.handle("log-path", () => log.logPath);
ipcMain.handle("claude-resolve", async () => {
  // 返回实际使用的 claude 二进制路径 + 版本(供设置页动态显示)
  const bin = claude.claudeBin();
  const v = await probeVersion(bin);
  return {
    bin,
    explicit: !!persistence.loadSettings().claudePath,
    version: v.ok ? v.version : null,
    error: v.ok ? "" : v.error,
  };
});
ipcMain.handle("claude-version", async (_e, binPath) => {
  // 测试 claude 路径是否可用(--version)
  const bin = binPath && binPath.trim() ? binPath.trim() : claude.claudeBin();
  return probeVersion(bin);
});
ipcMain.handle("claude-update", async () => {
  // 更新 claude 到最新版(即 claude update),stdout/stderr 全量收集后统一返回
  // 增加超时保护:更新在 Windows 上偶发卡死,超时后整棵进程树强杀并明确报错,避免界面无限等待
  const bin = claude.claudeBin();
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
  log.log("info", `claude-update 开始 bin=${bin}`);
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.log("info", `claude-update 结束 ok=${r.ok}${r.code != null ? " code=" + r.code : ""}${r.error ? " err=" + r.error : ""}`);
      resolve(r);
    };
    try {
      child = claude.spawnClaude(bin, ["update"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, error: String(e.message) });
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ ok: false, error: String(e.message) }));
    child.on("close", (code) => finish({ ok: code === 0, code, output: (out + err).trim() }));
    const timer = setTimeout(() => {
      claude.killTree(child && child.pid); // 卡死保护:强杀更新进程(含 Windows 子进程)
      finish({ ok: false, error: `更新超时(${TIMEOUT_MS / 60000} 分钟),已终止。请检查网络后重试;日志见 userData/claude-desk.log` });
    }, TIMEOUT_MS);
  });
});

app.whenReady().then(() => {
  // 自测隔离:CD_USERDATA 指定独立数据目录,避免自动测试污染真实会话/设置(默认走系统 userData)
  if (process.env.CD_USERDATA) app.setPath("userData", process.env.CD_USERDATA);
  // 落盘日志:打包后 stdout 不可见,问题排查全靠 userData/claude-desk.log
  log.init(app.getPath("userData"));
  log.teeConsole(); // 主进程 console.* 一并写入,渲染进程转发的 warn/error 也会落到这里
  log.log("info", "主进程就绪,窗口创建中");
  persistence.init(app);
  configs.init(app.getPath("userData"));
  bridge.init({ userData: app.getPath("userData") });
  // 云连接状态 → 渲染层(设置页实时展示;不依赖哪个窗口在,这里统一转发)
  let wasCloudOnline = false;
  bridge.onStatus((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("cloud-event", st);
    }
    // 断线重连成功(off→online)后全量对账:把本地所有会话历史补齐到服务器,保证手机端离线也能看完整
    if (st.state === "online" && !wasCloudOnline) reconcileCloudHistory();
    wasCloudOnline = st.state === "online";
  });
  // 回答停在 claude 原生选择器:把该回答标为 awaiting/choice 并入库(手机端历史还原成选择卡)
  bridge.onChooser(({ sessionId, options, text, multiSelect }) => markPendingChoice(sessionId, options, text, multiSelect));
  // 手机端触发的对话:把「用户消息 + 回答」走统一上行入库,确保 PC 端与手机端看到同一对话
  bridge.onCloudMessage((ev) => handleCloudMessage(ev));
  createWindow();
  // 若设置了「开机自动连接云」,窗口就绪后直接连
  const cloud = persistence.loadSettings().cloud || {};
  if (cloud.autoStart) bridge.applyConfig({ serverUrl: cloud.serverUrl, token: cloud.token, deviceName: cloud.deviceName, autoStart: true });
  // 若设置是「关闭=缩到托盘」,启动即常驻托盘(设置项存于用户环境,随时可改)
  if ((persistence.loadSettings().closeAction || "exit") === "tray") ensureTray();
});

// ---- 崩溃事件:记录 + 标记,供窗口自愈(渲染/子进程异常不再让应用静默退出) ----
let winCrashed = false; // 渲染进程崩溃标记:window-all-closed 据此重建窗口而非退出
app.on("render-process-gone", (_e, _wc, details) => {
  winCrashed = true;
  log.log("warn", `渲染进程异常退出: reason=${details.reason} code=${details.exitCode}`);
});
app.on("child-process-gone", (_e, details) => {
  log.log("warn", `子进程异常退出: type=${details.type} reason=${details.reason} code=${details.exitCode}`);
  if (details.type === "GPU") log.log("warn", "GPU 进程崩溃(已记录);若反复出现说明禁 GPU 开关未生效");
});

// 退出前把内存里的所有会话一次性落盘(防丢最后几秒的 debounce 缓冲)
app.on("before-quit", () => {
  quitting = true; // 程序内退出:关窗事件无需再确认
  persistence.flushAll();
  pty.closeAll(); // 先关所有终端(PTY 的 claude 真实进程)
  for (const id of listAllRunning()) claude.killSession(id);
});
// before-quit 里不能遍历 jobs(未导出),改为在 window-all-closed 前兜底
app.on("window-all-closed", () => {
  // 崩溃等异常导致窗口全关:重建窗口自愈,而不是退出(仅用户主动退出才真正退出)
  if (winCrashed) {
    winCrashed = false;
    log.log("warn", "窗口因异常全部关闭,重建窗口自愈");
    createWindow();
    return;
  }
  if (process.platform !== "darwin") app.quit();
});

function listAllRunning() {
  // persistence 内部维护 runningSet,但未导出遍历能力;这里直接遍历 jobs 已知会话集合
  return persistence
    .listSessions()
    .filter((s) => s.running)
    .map((s) => s.id);
}

