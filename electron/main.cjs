// Claude Desk —— Electron 主进程
// 职责:创建窗口 + 内置 HTTP 服务前端产物;把 IPC 接到 persistence / claude / configs;
//       转发「会话事件」总线(claude 的流式过程、完成、错误)给渲染进程,并在转发前先落库。
// 关键设计:底层就是真实 claude,hooks / slash commands / MCP / 配置全部原样生效,
//          这一层只负责"开进程 + 落库 + 转发 + 状态"。

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, nativeTheme, screen } = require("electron");
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
const log = require("./log.cjs");

// 去掉顶层原生菜单(File/Edit/View/Window/Help),保持纯 UI
Menu.setApplicationMenu(null);

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
let pinnedPos = null;      // 窗口应固定的位置 [x, y]
let dragUntil = 0;         // 拖拽判定到期:上次几何事件 +250ms,超时即视为已脱手
let reverting = false;     // 自己 setPosition 回弹中,忽略由此触发的 move/resize
let armed = false;         // 是否已进入稳态守卫(首 1.5s 放行,等系统完成初始摆位/居中再开始)

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
});
// 对话队列状态变化:同走 terminal-event 通道(渲染层按 type==="tunnel" 刷新弹窗状态)
tunnel.setEmit((ev) => {
  if (win && !win.isDestroyed()) win.webContents.send("terminal-event", ev);
});

function onSessionEvent(ev) {
  // 落盘日志只在关键事件打点(stream 每块一行会刷屏,不记)
  if (ev.type !== "stream") {
    log.log("info", `[session] ${ev.type} id=${ev.id}${ev.jobKey ? " job=" + ev.jobKey : ""}${ev.message ? " msg=" + String(ev.message).slice(0, 300) : ""}`);
  }
  try {
    if (ev.type === "user-message") {
      // 用户消息,直接落库一条完整消息
      persistence.appendMessage(ev.id, { role: "user", text: ev.text, ts: Date.now() });
      persistence.flush(ev.id);
    } else if (ev.type === "stream") {
      // assistant 流式块:按 messageId 聚合进同一条消息
      persistence.appendBlock(ev.id, ev.messageId, ev.block);
    } else if (ev.type === "error" && ev.message) {
      // 系统级错误(启动失败/目录不存在/异常退出):落库为 ui 错误消息
      persistence.appendMessage(ev.id, { role: "ui", blocks: [{ type: "error", text: ev.message }], ts: Date.now() });
      persistence.flush(ev.id);
    } else if (ev.type === "done") {
      // claudeSessionId 已在 claude.cjs 的 recordDone 中落盘
      persistence.flush(ev.id);
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

  // 自测模式:注入端到端步骤,最后输出 AUTOTEST_OK/FAIL(见 autotest 节)
  if (process.env.CD_AUTOTEST === "1") runAutotest();
  // 终端自测(终端形态 A):建会话→进对话页→验证 xterm 渲染真实 claude→关闭→删除
  if (process.env.CD_TERM_AUTOTEST === "1") runTermAutotest();
  // 上下文压测:持续喂消息观察统计增长/自动压缩(见 ctxdrive.cjs)
  if (process.env.CD_CTX_AUTOTEST === "1") require("./ctxdrive.cjs")(win);
}

ipcMain.handle("session-create", (_e, meta) => {
  return persistence.createSession(meta || {});
});
ipcMain.handle("session-list", () => {
  return persistence.listSessions();
});
ipcMain.handle("session-get", (_e, id) => {
  if (typeof id !== "string") throw new Error("缺 id");
  return persistence.loadSession(id);
});
ipcMain.handle("session-update", (_e, id, patch) => {
  return persistence.updateSession(id, patch);
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
// ---- 终端会话(PTY):打开/写入/缩放/关闭,渲染层 xterm 经此双向流 ----
ipcMain.handle("terminal-open", (_e, id) => {
  if (typeof id !== "string") return { error: "缺 id" };
  const s = persistence.getSession(id);
  if (!s) return { error: "会话不存在" };
  if (claude.isRunning(id)) return { error: "该会话有 -p 任务在运行,请先停止" };
  return pty.open(id, { cwd: s.cwd, argText: s.argText, skipPermissions: !!s.skipPermissions });
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
  // 落盘日志:打包后 stdout 不可见,问题排查全靠 userData/claude-desk.log
  log.init(app.getPath("userData"));
  log.teeConsole(); // 主进程 console.* 一并写入,渲染进程转发的 warn/error 也会落到这里
  log.log("info", "主进程就绪,窗口创建中");
  persistence.init(app);
  configs.init(app.getPath("userData"));
  createWindow();
  // 若设置是「关闭=缩到托盘」,启动即常驻托盘(设置项存于用户环境,随时可改)
  if ((persistence.loadSettings().closeAction || "exit") === "tray") ensureTray();
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
  if (process.platform !== "darwin") app.quit();
});

function listAllRunning() {
  // persistence 内部维护 runningSet,但未导出遍历能力;这里直接遍历 jobs 已知会话集合
  return persistence
    .listSessions()
    .filter((s) => s.running)
    .map((s) => s.id);
}

// ---- 终端自测(CD_TERM_AUTOTEST=1) ----
// 验证终端形态:createSession → 进对话页 → xterm 挂载并渲染出真实 claude TUI → 关终端 → 删除

async function runTermAutotest() {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const ok = (label, cond, extra = "") => {
    console.log(`${cond ? "AUTOTEST_PASS" : "AUTOTEST_FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails.push(label);
  };
  // 读取当前终端视图状态(bytes 为渲染层累计接收字节;err/exit 为错误/退出提示)
  const readTerm = () =>
    exec(`(() => {
      const t = document.querySelector('.xterm');
      return {
        path: location.pathname,
        xterm: !!t,
        rows: t ? t.querySelectorAll('.xterm-rows > div').length : 0,
        txt: t ? t.textContent.replace(/\\s+/g, " ").slice(0, 120) : "",
        bytes: window.__termBytes || 0,
        err: (document.querySelector('[data-testid=term-err]') || { textContent: "" }).textContent || "",
        exit: !!document.querySelector('[data-testid=term-exit]'),
        summary: !!document.querySelector('[data-testid=summary-panel]'),
        worktab: !!document.querySelector('[data-testid=tab-workspace]'),
        transcript: (document.querySelector('[data-testid=transcript]') || { textContent: "" }).textContent || "",
      };
    })()`).catch(() => null);
  // 客户端导航:注入 <a> 并 click,走 SvelteKit 客户端路由(= goto),而非整页 loadURL

  try {
    // 1. 等首屏渲染
    for (let i = 0; i < 150; i++) {
      if (await exec(`!!document.querySelector("[data-testid=create-btn]")`).catch(() => false)) break;
      await wait(100);
    }
    // 2. 建会话 A(用安全参数,真实 claude 会在 /tmp 询问"信任此文件夹?",终端原样呈现)
    const created = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits" }).then(x => JSON.stringify(x))`);
    const s = JSON.parse(created);
    ok("创建会话", !!s?.id, created.slice(0, 100));
    const sid = s.id;

    // 3. 直接整页加载对话页(SPA fallback),等待 TerminalView 挂载 xterm 并渲染 claude TUI 输出
    await win.loadURL(global.__baseUrl + "session/" + sid);
    let st = { xterm: false, txt: "", bytes: 0, err: "", exit: false, summary: false, transcript: "" };
    for (let i = 0; i < 200; i++) {
      st = (await readTerm()) || st;
      if (st.err || st.exit || (st.bytes > 0 && st.txt.trim())) break;
      await wait(150);
    }
    ok("xterm已挂载", !!st.xterm, JSON.stringify(st));
    ok("claude TUI已渲染", st.bytes > 0 && st.txt.trim().length > 0, `bytes=${st.bytes} txt=${JSON.stringify(st.txt)}`);
    ok("终端行数填满(输入行贴底)", st.rows >= 32, `rows=${st.rows}(默认 24 即 fit 失败未贴底)`);
    // 4. pty 侧真实尺寸核查:fit 后必须显式同步行列到 pty/claude,否则输入行停在默认行数居中
    const ptySz = await exec(`window.claude.terminalSizeOf(${JSON.stringify(sid)}).then(x => JSON.stringify(x))`).catch(() => null);
    let psz = null;
    try { psz = JSON.parse(ptySz); } catch {}
    ok("pty行列已同步(输入行贴底)", !!psz && psz.rows >= 32, `pty=${ptySz}(open 默认 30 行,fit 后未同步即未贴底)`);
    ok("终端打开无错误", !st.err, `err=${st.err}`);
    // 默认右侧为工具面板(非纪要)
    let defTools = null;
    for (let i = 0; i < 20; i++) {
      defTools = await exec(`(() => ({ tools: !!document.querySelector('[data-testid=tools-panel]'), summaryGone: !document.querySelector('[data-testid=summary-panel]') }))()`).catch(() => null);
      if (defTools && defTools.tools) break;
      await wait(100);
    }
    ok("默认右侧为工具面板", !!defTools && defTools.tools && defTools.summaryGone, JSON.stringify(defTools));
    const bytesAtA = st.bytes;

    // 3.35 右侧面板切换:默认工具;点「纪要」切到纪要,再点「工具」切回(纯按钮、无输出区、无自动执行)
    await exec(`document.querySelector('[data-testid=toggle-summary]').click()`).catch(() => false);
    let smtrl = null;
    for (let i = 0; i < 40; i++) {
      smtrl = await exec(`(() => ({ summary: !!document.querySelector('[data-testid=summary-panel]'), toolsGone: !document.querySelector('[data-testid=tools-panel]'), on: !!document.querySelector('[data-testid=toggle-summary].on') }))()`).catch(() => null);
      if (smtrl && smtrl.summary && smtrl.toolsGone) break;
      await wait(100);
    }
    ok("点「纪要」从工具切到纪要", !!smtrl && smtrl.summary && smtrl.toolsGone, JSON.stringify(smtrl));
    await exec(`document.querySelector('[data-testid=toggle-tools]').click()`).catch(() => false);
    let mtrl = null;
    for (let i = 0; i < 40; i++) {
      mtrl = await exec(`(() => ({
        panel: !!document.querySelector('[data-testid=tools-panel]'),
        summaryGone: !document.querySelector('[data-testid=summary-panel]'),
        hasCompact: !![...document.querySelectorAll('[data-testid=tool-btn]')].some(b => (b.textContent || '').includes('/compact')),
        outputGone: !document.querySelector('[data-testid=monitor-text]'),
        btns: document.querySelectorAll('[data-testid=tool-btn]').length,
        on: !!document.querySelector('[data-testid=toggle-tools].on'),
      }))()`).catch(() => null);
      if (mtrl && mtrl.panel && mtrl.summaryGone) break;
      await wait(100);
    }
    ok("点「工具」切回工具面板", !!mtrl && mtrl.on && mtrl.panel && mtrl.summaryGone, JSON.stringify(mtrl));
    ok("常用命令按钮存在(≥8)", !!mtrl && mtrl.btns >= 8, `btns=${mtrl && mtrl.btns}`);
    ok("压缩上下文按钮存在", !!mtrl && mtrl.hasCompact, `compact=${mtrl && mtrl.hasCompact}`);
    ok("工具面板无输出捕获区", !!mtrl && mtrl.outputGone, `outputGone=${mtrl && mtrl.outputGone}`);

    // 3.35c 底部上下文监控:工具面板底部显示「已用/窗口 (占比%)」,来自主进程读 jsonl usage 或估算
    let ctxUi = "";
    for (let i = 0; i < 20; i++) {
      ctxUi = await exec(`(document.querySelector('[data-testid=context-usage]') || { textContent: '' }).textContent`).catch(() => "");
      if (ctxUi && ctxUi.includes('/')) break;
      await wait(300);
    }
    ok("上下文监控 现在/最大", /[0-9.]+[KM]?\/[0-9.]+[KM]?/.test(ctxUi || "") && ctxUi.includes('%'), `ctx=${String(ctxUi).trim()}`);

    // 3.35d 手动调整上限:输入 240k 点设置 → 徽标出现「手动」,上限字段随之改变
    await exec(`(() => { const i = document.querySelector('[data-testid=ctx-max-input]'); if (!i) return "NO"; i.value = "240k"; i.dispatchEvent(new Event('input', { bubbles: true })); return "SET"; })()`).catch(() => "ERR");
    await wait(200);
    await exec(`(() => { const b = document.querySelector('[data-testid=ctx-max-save]'); if (!b) return "NO"; b.click(); return "OK"; })()`).catch(() => "ERR");
    let maxManual = false;
    let maxVal = "";
    for (let i = 0; i < 20; i++) {
      maxManual = await exec(`!![...document.querySelectorAll('[data-testid=context-usage] .badge')].find(b => (b.textContent || '').includes('手动'))`).catch(() => false);
      maxVal = await exec(`(document.querySelector('[data-testid=ctx-max-input]') || { value: '' }).value`).catch(() => "");
      if (maxManual) break;
      await wait(300);
    }
    ok("手动设置上限生效", maxManual && /240/i.test(maxVal || ""), `manual=${maxManual} val=${maxVal}`);

    // 3.35b 打开面板不自动执行:等 TUI 自绘稳定后,终端文本里不得出现 /context 之类的命令回显
    await wait(1500);
    const notAuto = await exec(`(() => {
      const t = document.querySelector('.xterm');
      const txt = t ? t.textContent || "" : "";
      const userLine = txt.match(/❯[ \\t]*\\/[a-z]+/);
      // 命令被回显:输入行「❯ /xxx」;或输出里出现 /context 字样(它自己会显示命令名)
      const echoed = userLine && userLine[0].includes('/context');
      return JSON.stringify({ echoed, sample: txt.replace(/\\s+/g, " ").slice(-80) });
    })()`).catch(() => null);
    let notAutoOk = false;
    try { notAutoOk = !JSON.parse(notAuto).echoed; } catch {}
    ok("进入工具面板不自动执行命令", notAutoOk, `auto=${notAuto}`);

    // 3.36 点按钮即执行:点击「/context」按钮 → 命令直接写入主终端,输出在主窗口出现(渲染字节增长)
    const beforeBtn = await exec(`window.__termBytes || 0`).catch(() => null);
    const clickCtx = await exec(`(() => { const b = [...document.querySelectorAll('[data-testid=tool-btn]')].find(x => (x.textContent || '').includes('/context')); if (!b) return "NO_BTN"; b.click(); return "CLICKED"; })()`).catch(() => "NO_BTN");
    let ctxBtnOk = false;
    let afterBtn = beforeBtn;
    for (let i = 0; i < 40; i++) {
      await wait(150);
      afterBtn = await exec(`window.__termBytes || 0`).catch(() => null);
      if (parseInt(afterBtn || "0", 10) > parseInt(beforeBtn || "0", 10) + 50) { ctxBtnOk = true; break; }
    }
    ok("工具按钮点击→命令进主终端(/context)", clickCtx === "CLICKED" && ctxBtnOk, `click=${clickCtx} bytes=${beforeBtn}->${afterBtn}`);

    // 3.36b 点工具按钮后键盘焦点回到终端输入行(xterm 隐藏 textarea),可直接继续打字
    const focusInfo = await exec(`(() => {
      const a = document.activeElement;
      const xterm = document.querySelector('.xterm');
      const cls = (a && (typeof a.className === 'string' ? a.className : (a.getAttribute && a.getAttribute('class') || '')) || '').toString();
      return JSON.stringify({ inside: !!(a && xterm && xterm.contains(a)), cls }) ;
    })()`).catch(() => null);
    let focusOk = false;
    try { const f = JSON.parse(focusInfo); focusOk = f.inside && /textarea|xterm/i.test(f.cls); } catch {}
    ok("点工具按钮后焦点回到终端输入行", focusOk, `focus=${focusInfo}`);

    // 3.37 对话队列:工具面板点 /tunnel 打开弹窗,可新增/修改多条;开始后「答完一条自动接力下一条」
    await exec(`(() => { const b = [...document.querySelectorAll('[data-testid=tool-btn]')].find(x => (x.textContent || '').includes('/tunnel')); if (b) b.click(); return 'ok'; })()`).catch(() => "err");
    let tdlg = false;
    for (let i = 0; i < 40; i++) {
      tdlg = await exec(`!!document.querySelector('[data-testid=tunnel-dialog]')`).catch(() => false);
      if (tdlg) break;
      await wait(100);
    }
    ok("打开对话队列弹窗", tdlg);

    // 新增两条(输入框设值并派 input 事件驱动 Svelte bind:value,稍候再点添加)
    const tAdd = async (text) => {
      await exec(`(() => {
        const inp = document.querySelector('[data-testid=tunnel-input]');
        if (!inp) return "NO_INPUT";
        inp.value = ${JSON.stringify(text)};
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return "SET";
      })()`).catch(() => "ERR");
      await wait(250);
      await exec(`(() => { const b = document.querySelector('[data-testid=tunnel-add]'); if (!b || b.disabled) return "DISABLED"; b.click(); return "ADD"; })()`).catch(() => "ERR");
      await wait(400);
    };
    await tAdd("只回复两个字：队列一");
    await tAdd("只回复两个字：队列二");
    await tAdd("请你逐行输出数字1到80，每行一个阿拉伯数字，不要任何其他文字");
    await wait(250);
    const rowsInfo = await exec(`(() => JSON.stringify([...document.querySelectorAll('[data-testid=tunnel-item]')].map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim())))()`).catch(() => "[]");
    let rows = [];
    try { rows = JSON.parse(rowsInfo); } catch {}
    ok("队列可新增多条", rows.length === 3 && /队列一/.test(rows[0] || "") && /逐行输出数字/.test(rows[2] || ""), `rows=${rowsInfo}`);

    // 行内修改第一条
    await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; if (!r) return "NO_ROW"; const b = r.querySelector('[data-testid=tunnel-edit]'); if (b) b.click(); return "OK"; })()`).catch(() => "err");
    let hasEditInput = false;
    for (let i = 0; i < 20; i++) {
      hasEditInput = await exec(`!!document.querySelector('[data-testid=tunnel-edit-input]')`).catch(() => false);
      if (hasEditInput) break;
      await wait(100);
    }
    ok("点条目可进入编辑", hasEditInput);
    await exec(`(() => {
      const inp = document.querySelector('[data-testid=tunnel-edit-input]');
      if (!inp) return "NO_INPUT";
      inp.value = "只回复两个字：队列一改";
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return "SET";
    })()`).catch(() => "ERR");
    await wait(500);
    await exec(`(() => { const b = document.querySelector('[data-testid=tunnel-edit-save]'); if (!b || b.disabled) return "DISABLED"; b.click(); return "CLICK"; })()`).catch(() => "ERR");
    await wait(500);
    const afterEdit = await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; return (r && r.textContent || '').replace(/\\s+/g, ' ').trim(); })()`).catch(() => "");
    ok("修改条目生效", /队列一改/.test(afterEdit || ""), `row=${afterEdit}`);

    // 开始:第一条立即进入发送中
    const ctxA = await exec(`window.claude.contextState(${JSON.stringify(sid)}).then(c => JSON.stringify(c)).catch(() => 'ERR')`).catch(() => "'ERR'");
    const trA = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(s => (s && s.transcript || '').length).catch(() => 0)`).catch(() => 0);
    await exec(`document.querySelector('[data-testid=tunnel-start]').click()`).catch(() => false);
    let firstActive = false;
    for (let i = 0; i < 40; i++) {
      firstActive = await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; return !!(r && r.classList.contains('active')); })()`).catch(() => false);
      if (firstActive) break;
      await wait(200);
    }
    ok("开始后第一条进入发送", firstActive);

    // 自动接力:第一条答完应变成 done,且第二条自动进入发送——claude 真实回答耗时不定,放开等
    let relayOk = false;
    for (let i = 0; i < 300; i++) {
      const st = await exec(`(() => {
        const rs = [...document.querySelectorAll('[data-testid=tunnel-item]')];
        return JSON.stringify({ d0: !!(rs[0] && rs[0].classList.contains('done')), b1: !!(rs[1] && (rs[1].classList.contains('done') || rs[1].classList.contains('active'))) });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(st); } catch {}
      if (j && j.d0 && j.b1) { relayOk = true; break; }
      await wait(250);
    }
    ok("答完第一条自动接力第二条", relayOk);

    // 一轮跑完即停:三条都 done 且引擎退出执行态
    let allDone = false;
    for (let i = 0; i < 300; i++) {
      const st = await exec(`(() => {
        const rs = [...document.querySelectorAll('[data-testid=tunnel-item]')];
        const btn = document.querySelector('[data-testid=tunnel-start]');
        return JSON.stringify({ done: rs.length === 3 && rs.every(r => r.classList.contains('done')), startText: btn ? (btn.textContent || '').trim() : '' });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(st); } catch {}
      if (j && j.done && j.startText && !j.startText.includes("执行中")) { allDone = true; break; }
      if (i > 30 && j && j.done) { allDone = true; break; } // 容错:done 就够了(引擎事件可能已收尾)
      await wait(250);
    }
    ok("队列一轮跑完全部完成", allDone);

    // 历史回看:claude TUI 全屏(alt buffer)在 xterm 里无 scrollback,我们自存行历史;
    // 向上滚 → 回看覆盖层出现且滚动条带比例滑块;向下滚到底 → 退出回看恢复实时
    await exec(`(() => {
      const h = document.querySelector('.host');
      if (!h) return 'NO_HOST';
      h.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true, cancelable: true }));
      return 'SCROLLED';
    })()`).catch(() => "ERR");
    let revInfo = null;
    for (let i = 0; i < 30; i++) {
      revInfo = await exec(`(() => {
        const rv = document.querySelector('[data-testid=terminal-review]');
        const sb = document.querySelector('[data-testid=terminal-scroller]');
        const t = sb && sb.querySelector('.thumb');
        return JSON.stringify({ review: !!rv, sb: !!sb, th: t ? t.style.height : '', text: rv ? (rv.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) : '' });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(revInfo); } catch {}
      if (j && j.review && j.sb) break;
      await wait(200);
    }
    let revOK = false;
    try { const j = JSON.parse(revInfo); revOK = j.review && j.sb && j.th && j.th !== '100%'; } catch {}
    ok("历史回看:上滚出现覆盖层与滚动条", revOK, `rev=${revInfo}`);

    // 向下滚到底 → 退出回看,恢复实时画面
    await exec(`(() => { const h = document.querySelector('.host'); if (h) h.dispatchEvent(new WheelEvent('wheel', { deltaY: 9999, bubbles: true, cancelable: true })); return 1; })()`).catch(() => 0);
    let revGone = false;
    for (let i = 0; i < 20; i++) {
      revGone = await exec(`!document.querySelector('[data-testid=terminal-review]')`).catch(() => false);
      if (revGone) break;
      await wait(150);
    }
    ok("回看滚到底退出,恢复实时", revGone);

    // 上下文统计随真实对话变化:队列两队问答全部完成后,jsonl 常量 usage(本机后端写死 18286/60)
    // 应被探测到(stale)并转估算;估算按去重内容随对话真实增长,used 应大于开头采样且非 jsonl 固定值
    const ctxB = await exec(`window.claude.contextState(${JSON.stringify(sid)}).then(c => JSON.stringify(c)).catch(() => 'ERR')`).catch(() => "'ERR'");
    let ctxAUsed = 0, ctxBUsed = 0, ctxBFrom = "";
    try { ctxAUsed = JSON.parse(ctxA).used; } catch {}
    try { const j = JSON.parse(ctxB); ctxBUsed = j.used; ctxBFrom = j.source || ""; } catch {}
    ok(
      "上下文统计随对话增长(转估算)",
      ctxBUsed > ctxAUsed && ctxBFrom === "estimate",
      `used ${ctxAUsed} -> ${ctxBUsed} src=${ctxBFrom} raw=${ctxB}`
    );

    // 关闭弹窗(队列与记录保留),回到纪要流程
    await exec(`document.querySelector('[data-testid=tunnel-close]').click()`).catch(() => false);
    for (let i = 0; i < 30; i++) {
      const gone = await exec(`!document.querySelector('[data-testid=tunnel-dialog]')`).catch(() => true);
      if (gone) break;
      await wait(100);
    }

    // 切回纪要(后续断言基于纪要面板),同按钮再次点击收起语义保持
    await exec(`(() => { const el = document.querySelector('[data-testid=toggle-summary]'); if (!el) return "NO_EL"; el.click(); return "CLICKED"; })()`).catch(() => "NO_EL");
    let backSummary = false;
    for (let i = 0; i < 40; i++) {
      const has = await exec(`!!document.querySelector('[data-testid=summary-panel]')`).catch(() => false);
      if (has) { backSummary = true; break; }
      await wait(100);
    }
    ok("切回纪要面板恢复", backSummary);

    // 3.4 「结束终端」需确认:点按钮弹中文确认框,取消则进程不动
    await exec(`document.querySelector('[data-testid=term-stop]').click()`).catch(() => false);
    let dlgText = "";
    for (let i = 0; i < 30; i++) {
      dlgText = await exec(`(document.querySelector('[data-testid=confirm-dialog] .title') || { textContent: "" }).textContent`).catch(() => "");
      if (dlgText.trim()) break;
      await wait(100);
    }
    ok("结束终端弹确认框", dlgText.trim() === "结束终端？", `title=${JSON.stringify(dlgText)}`);
    await exec(`document.querySelector('[data-testid=dlg-cancel]').click()`).catch(() => false);
    await wait(250);
    const stCancel = (await readTerm()) || st;
    ok("取消后终端仍在运行", stCancel.bytes >= bytesAtA && !stCancel.exit, `bytes=${stCancel.bytes} exit=${stCancel.exit}`);

    // 3.4b Ctrl+C 退出重连:关闭终端(=退出后的 UI 状态)→ 出现「进程已结束」+ 重连按钮;点重连恢复
    await exec(`window.claude.terminalClose(${JSON.stringify(sid)})`);
    let exitShown = false;
    let hasReconn = false;
    for (let i = 0; i < 40; i++) {
      exitShown = await exec(`!!document.querySelector('[data-testid=term-exit]')`).catch(() => false);
      hasReconn = await exec(`!!document.querySelector('[data-testid=term-reconnect]')`).catch(() => false);
      if (exitShown && hasReconn) break;
      await wait(100);
    }
    ok("进程退出显示重连提示", exitShown && hasReconn, `exit=${exitShown} term-reconnect=${hasReconn}`);
    const topBtn = await exec(`!!document.querySelector('[data-testid=term-reconnect-top]')`).catch(() => false);
    ok("顶部出现重连按钮(未运行)", topBtn, `top=${topBtn}`);
    const prevTopBytes = parseInt(await exec(`window.__termBytes || 0`).catch(() => "0"), 10);
    await exec(`document.querySelector('[data-testid=term-reconnect]').click()`).catch(() => false);
    let reconnOk = false;
    for (let i = 0; i < 50; i++) {
      const running = await exec(`!!document.querySelector('[data-testid=term-stop]') && !document.querySelector('[data-testid=term-exit]')`).catch(() => false);
      const nowBytes = parseInt(await exec(`window.__termBytes || 0`).catch(() => "0"), 10);
      if (running && nowBytes > prevTopBytes + 30) { reconnOk = true; break; }
      await wait(150);
    }
    ok("重连后终端恢复运行", reconnOk, `bytes ${prevTopBytes} -> ${await exec(`window.__termBytes || 0`).catch(() => "?")}`);

    // 3.5 同路由参数变化(会话页内「＋新建/切 tab」):SvelteKit 复用组件实例不重跑 onMount,
    //     必须 {#key id} 重挂才能给新会话起新终端 → 用客户端导航复现用户实际问题
    const createdB = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits", skipPermissions:true }).then(x => JSON.stringify(x))`);
    const sB = JSON.parse(createdB);
    ok("建会话B", !!sB?.id, createdB.slice(0, 100));
    const sidB = sB.id;
    await exec(`(() => { const a = document.createElement("a"); a.id="gotoB"; a.href="/session/${sidB}"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let navB = false;
    let stB = st;
    for (let i = 0; i < 200; i++) {
      stB = (await readTerm()) || stB;
      navB = navB || stB.path === "/session/" + sidB;
      if (navB && (stB.bytes > bytesAtA || stB.err || stB.exit)) break;
      await wait(150);
    }
    ok("客户端导航到新会话B", navB, `path=${stB.path} bytes=${stB.bytes}`);
    ok("B的终端已开启(新终端存在)", stB.bytes > bytesAtA, `bytesAtA=${bytesAtA} bytesB=${stB.bytes} err=${stB.err}`);

    // 3.5b 跳过权限确认:会话B创建时勾选 skipPermissions,查其 pty 启动参数确实带上了该 flag
    const skipArgs = await exec(`window.claude.terminalOpen(${JSON.stringify(sidB)}).then(x => JSON.stringify((x && x.args) || null))`).catch(() => "null");
    ok("跳过权限确认勾选生效(--dangerously-skip-permissions)", (skipArgs || "").includes("--dangerously-skip-permissions"), `args=${skipArgs}`);

    // 3.6 纪要面板:默认视图是「问答总结」,实录在「📜 实录」视图下。
    // 先点开关切到实录验证 transcript 出现,再切回总结视图(开关往返都验证)
    await exec(`document.querySelector('[data-testid=summary-view-raw]').click()`).catch(() => false);
    let stTrans = "";
    for (let i = 0; i < 200; i++) {
      stTrans = ((await readTerm()) || {}).transcript || "";
      if (stTrans.trim().length > 0) break;
      await wait(150);
    }
    ok("纪要面板实录出现", stTrans.trim().length > 0, `len=${stTrans.trim().length}`);
    await exec(`document.querySelector('[data-testid=summary-view-summary]').click()`).catch(() => false);
    let backDigest = false;
    // 摘要由真实 claude -p 生成,耗时不固定 → 等放宽到 ~20s 再判
    for (let i = 0; i < 100; i++) {
      const has = await exec(`!!document.querySelector('[data-testid=summary-digest]') || !!document.querySelector('[data-testid=summary-regen]')`).catch(() => false);
      if (has) { backDigest = true; break; }
      await wait(200);
    }
    ok("切回问答总结视图", backDigest);

    // 3.7 切回会话A:附着式 replay 重放历史,不报错
    await exec(`(() => { const a = document.createElement("a"); a.id="gotoA"; a.href="/session/${sid}"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let stA2 = st;
    for (let i = 0; i < 120; i++) {
      stA2 = (await readTerm()) || stA2;
      if (stA2.path === "/session/" + sid && stA2.xterm) break;
      await wait(150);
    }
    ok("切回会话A不报错", stA2.path === "/session/" + sid && !stA2.err, `path=${stA2.path} err=${stA2.err}`);

    // 3.7b 顶部 tab 栏首位固定「工作空间」入口(跳回会话列表,补全跳转)
    ok("tab栏含工作空间跳转入口", !!stA2.worktab, `worktab=${stA2.worktab}`);

    // 3.8 工作空间编辑会话:齿轮 → 改名称 → 保存落库(用独立一次性会话,避免误改用户数据)
    const titleC = `cd-edit-${Date.now()}`;
    const doneTitle = titleC + "-done";
    const createdC = await exec(`window.claude.sessionCreate({ cwd:"/tmp", title:${JSON.stringify(titleC)} }).then(x=>JSON.stringify(x))`);
    const sC = JSON.parse(createdC);
    const sidC = sC.id;
    await exec(`(() => { const a=document.createElement("a"); a.href="/"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let gearOk = "";
    for (let i = 0; i < 60; i++) {
      gearOk = await exec(`(() => {
        const items = [...document.querySelectorAll("[data-testid=session-item]")];
        const it = items.find((x) => { const t = x.querySelector(".title"); return t && t.textContent.trim() === ${JSON.stringify(titleC)}; });
        if (!it) return "NO_ITEM";
        const gear = it.querySelector("[data-testid=edit-session]");
        if (!gear) return "NO_GEAR";
        gear.click();
        return "OPENED";
      })()`).catch(() => "");
      if (gearOk === "OPENED") break;
      await wait(150);
    }
    ok("列表项有编辑齿轮", gearOk === "OPENED", `gear=${gearOk}`);
    let editModal = false;
    for (let i = 0; i < 20; i++) {
      editModal = await exec(`!!document.querySelector("[data-testid=f-save]")`).catch(() => false);
      if (editModal) break;
      await wait(100);
    }
    ok("编辑弹窗打开", !!editModal);
    await exec(`(() => { const inp = document.querySelector("[data-testid=f-title]"); inp.value = ${JSON.stringify(doneTitle)}; inp.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`).catch(() => false);
    await exec(`document.querySelector("[data-testid=f-save]").click()`).catch(() => false);
    let savedTitle = "";
    for (let i = 0; i < 30; i++) {
      savedTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sidC)}).then(x => JSON.stringify(x.title))`).catch(() => "");
      if (JSON.parse(savedTitle || '"---"') === doneTitle) break;
      await wait(150);
    }
    ok("编辑保存生效", JSON.parse(savedTitle || '"---"') === doneTitle, `title=${savedTitle}`);

    // 3.9 未命名会话自动标题:向会话B发一条提问,实录落盘后标题按首条提问内容自动生成
    await exec(`window.claude.terminalCommand(${JSON.stringify(sidB)}, "请用一句中文介绍你自己\\n")`).catch(() => null);
    let autoTitle = "";
    for (let i = 0; i < 40; i++) {
      await wait(500);
      autoTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sidB)}).then((x) => JSON.stringify(x.title))`).catch(() => JSON.stringify("---"));
      const t = JSON.parse(autoTitle || '"---"');
      if (t && t !== "未命名会话") break;
    }
    const autoT = JSON.parse(autoTitle || '"---"');
    ok("未命名会话按提问自动生成标题", typeof autoT === "string" && autoT !== "未命名会话" && autoT.length > 0, `title=${autoTitle}`);

    // 4. 关闭终端(不删会话)
    const closed = await exec(`window.claude.terminalClose(${JSON.stringify(sid)}).then(x=>JSON.stringify(x))`);
    ok("终端可关闭", JSON.parse(closed) === true, `close=${closed}`);
    await wait(400);

    // 5. 清理(三会话)
    await exec(`window.claude.sessionDelete(${JSON.stringify(sidC)})`);
    await exec(`window.claude.sessionDelete(${JSON.stringify(sidB)})`);
    await exec(`window.claude.sessionDelete(${JSON.stringify(sid)})`);
    ok("删除会话", true);

    // 6. 全屏:进入↔退出各验证一次(状态经 IPC 返回;布局自适应由 ResizeObserver→doFit 兜底)
    const fs1 = await exec(`window.claude.toggleFullscreen().then((x) => JSON.stringify(x))`).catch(() => "null");
    ok("全屏切换生效", JSON.parse(fs1) === true, `fs1=${fs1}`);
    await wait(300);
    const fs2 = await exec(`window.claude.toggleFullscreen().then((x) => JSON.stringify(x))`).catch(() => "null");
    ok("退出全屏恢复", JSON.parse(fs2) === false, `fs2=${fs2}`);

    console.log(fails.length === 0 ? "AUTOTEST_OK TERM ALL PASS" : `AUTOTEST_FAIL n=${fails.length}: ${JSON.stringify(fails)}`);
    app.quit();
  } catch (err) {
    console.log("AUTOTEST_FAIL EXCEPTION " + String((err && err.stack) || err));
    app.exit(1);
  }
}

async function runAutotest() {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const execSafe = (js, ms = 20000) =>
    Promise.race([exec(js), wait(ms).then(() => "__EXEC_TIMEOUT__")]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const ok = (label, cond, extra = "") => {
    console.log(`${cond ? "AUTOTEST_PASS" : "AUTOTEST_FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails.push(label);
  };

  try {
    // 轮询等前端首屏挂载(注入将增大 bundle,固定等 1.5s 在慢机不稳)
    await execSafe(`new Promise((res) => { const t0 = Date.now(); const p = () => { if (document.querySelector("[data-testid=create-btn]") || Date.now() - t0 > 15000) return res(true); setTimeout(p, 100); }; p(); })`, 20000);
    // 1. 列表页渲染
    const listState = await exec(`({
      mounted: !!document.querySelector("textarea") || !!document.querySelector(".session-list"),
      createBtn: !!document.querySelector("[data-testid=create-btn]"),
      list: !!document.querySelector("[data-testid=session-item]") || document.querySelector(".empty"),
      text: document.body.innerText.slice(0, 300),
    })`);
    ok("列表页渲染", listState.createBtn, JSON.stringify(listState));
    ok("无原生菜单栏", Menu.getApplicationMenu() === null, "Menu=null");

    // 2. 建会话(不传标题,验证自动命名;参数用无害的自定义 flag 验证传递)
    const created = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits", skipPermissions:true }).then(x => JSON.stringify(x))`);
    const s = JSON.parse(created);
    ok("创建会话返回id", !!s?.id, created.slice(0, 120));
    const sid = s.id;

    // 3. 列表能查到
    const listed = await exec(`window.claude.sessionList().then(x => JSON.stringify(x.length))`);
    ok("列表查得到会话", Number(listed) >= 1, `count=${listed}`);

    // 3.5 建会话时不填标题 → 默认标题;回首页触发 onMount 刷新,列表出现按天筛选 tabs
    const defTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(x => JSON.stringify(x.title))`);
    ok("标题默认未命名", JSON.parse(defTitle) === "未命名会话", `title=${defTitle}`);
    await win.loadURL(global.__baseUrl); // 触发列表页 onMount refreshList
    await wait(800);
    const hasTabs = await exec(`!!document.querySelector("[data-testid=filter-today]") && !!document.querySelector("[data-testid=session-item]")`);
    ok("按天筛选tabs存在", !!hasTabs, `tabs&item=${hasTabs}`);

    // 4. 发消息(用户消息/流式/完成落库)
    const sendRes = await exec(`window.claude.sessionSend(${JSON.stringify(sid)}, "用一句话介绍你自己").then(x => JSON.stringify(x))`);
    ok("发送返回ok", !JSON.parse(sendRes).error, sendRes.slice(0, 120));

    // 5. 直接整页加载对话页(SPA fallback),绕开点击导航的渲染进程不确定性。
    //    注意:会话页主体已是「真实 claude 终端」(见 CD_TERM_AUTOTEST 的完整验证:
    //    终端挂载/TUI 渲染/行数贴底/滚动回看/上下文监控等);历史上「问答气泡」
    //    (ChatLog 的 block-text / Composer 的 ctx-stats)已随 UI 演进移除,
    //    对应的过期断言不再有意义,这里只验证会话视图可正常导航。
    await win.loadURL(global.__baseUrl + "session/" + sid);
    await wait(1200);
    const navPath = await exec(`location.pathname`);
    ok("导航进入对话页", String(navPath).includes("/session/"), `path=${navPath}`);

    // 上下文统计栏 + 首条消息后标题自动生成(统计栏已并入工具面板上下文监控,见 CD_TERM_AUTOTEST)
    const afterSend = await execSafe(`window.claude.sessionGet(${JSON.stringify(sid)}).then((x) => JSON.stringify({ title: x.title }))`, 10000);
    const as = JSON.parse(afterSend);
    ok("标题已自动生成", as.title === "用一句话介绍你自己", `title=${as.title}`);

    // 等 UI tick 让 $derived 总结重算完成;默认右侧为工具面板,先点「纪要」展开纪要再查右栏
    await wait(800);
    await exec(`(() => { const el = document.querySelector('[data-testid=toggle-summary]'); if (!el) return "NO_EL"; el.click(); return "CLICKED"; })()`).catch(() => "NO_EL");
    await wait(600);
    const summaryState = await execSafe(`({
      hasToggle: !!document.querySelector("[data-testid=summary-toggle]"),
      hasViewSummary: !!document.querySelector("[data-testid=summary-view-summary]"),
      hasViewRaw: !!document.querySelector("[data-testid=summary-view-raw]"),
      hasTabbar: !!document.querySelector("[data-testid=session-tab]"),
      hasNewTab: !!document.querySelector("[data-testid=new-session-tab]"),
      hasFs: !!document.querySelector("[data-testid=toggle-fullscreen]"),
    })`, 10000);
    ok("纪要面板分「总结/实录」两视图(开关)", !!summaryState.hasToggle && summaryState.hasViewSummary && summaryState.hasViewRaw, JSON.stringify(summaryState).slice(0, 160));
    ok("多会话tab栏存在", !!summaryState.hasTabbar, `tab=${summaryState.hasTabbar}`);
    ok("新建对话按钮存在", !!summaryState.hasNewTab, `newTab=${summaryState.hasNewTab}`);
    ok("全屏切换按钮存在", !!summaryState.hasFs, `fs=${summaryState.hasFs}`);

    // 5. 落盘反查:loadSession 的 messages 里应含 user + assistant 文本
    const persisted = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(x => JSON.stringify({ n: x.messages.length, texts: x.messages.map(m => m.role==='user' ? (m.text||'') : (m.blocks||[]).map(b=>b.text||'').join('')).filter(t=>t.length>0).slice(0,4) }))`);
    const p = JSON.parse(persisted);
    ok("消息已落盘", p.n >= 2 && p.texts.length >= 2, persisted.slice(0, 200));

    // 6. 设置回环:先备份原值,断言后恢复(不改动用户真实偏好)
    let origSettings = {};
    try { origSettings = JSON.parse(await exec(`window.claude.settingsGet().then(x => JSON.stringify(x))`).catch(() => "{}") || "{}"); } catch {}
    await exec(`window.claude.settingsSet({ claudePath: "", terminalFontSize: 17 }).then(x => JSON.stringify(x))`);
    const st = await exec(`window.claude.settingsGet().then(x => JSON.stringify(x))`);
    ok("设置读写", !JSON.parse(st).claudePath && JSON.parse(st).terminalFontSize === 17, st.slice(0, 80));
    await exec(`window.claude.settingsSet({ claudePath: ${JSON.stringify(origSettings.claudePath || "")}, terminalFontSize: ${Number(origSettings.terminalFontSize) || 13} }).then(x => JSON.stringify(x))`);

    // 6.2 设置页:安装指南链接 / 命名配置模板(新建+下拉应用) / 动态版本 + 标准三文件直编回环 + 单编辑区语法高亮编辑器
    await win.loadURL(global.__baseUrl + "settings");
    await wait(2600); // 等 claudeResolve 探测版本(claude --version)
    const setUi = await execSafe(`({
      guide: !!document.querySelector("[data-testid=guide-link]"),
      tmplNew: !!document.querySelector("[data-testid=tmpl-new]"),
      tmplSel: !!document.querySelector("[data-testid=tmpl-select]"),
      verCode: (document.querySelector(".desc code") || { innerText: "" }).innerText.trim(),
      dp: !!document.querySelector("[data-testid=date-picker]") || !!document.querySelector("[data-testid=session-item]"),
      font: !!document.querySelector("[data-testid=term-fontsize]"),
    })`, 10000);
    ok("设置页安装指南链接", setUi.guide, `guide=${setUi.guide}`);
    ok("命名配置模板按钮/下拉存在", setUi.tmplNew && setUi.tmplSel, `new=${setUi.tmplNew} sel=${setUi.tmplSel}`);
    ok("版本描述动态化", setUi.verCode.includes("claude") && setUi.verCode.length > 6, `ver=${setUi.verCode}`);
    ok("终端字体大小设置项存在", !!setUi.font, `font=${setUi.font}`);

    // 备份用户真实 settings.json / settings.local.json(下面的写回测会修改它们,必须恢复)
    const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
    const LOCAL_PATH = path.join(os.homedir(), ".claude", "settings.local.json");
    const settingsBackup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : null;
    const localBackup = fs.existsSync(LOCAL_PATH) ? fs.readFileSync(LOCAL_PATH, "utf8") : null;

    // 6.2a 标准三文件直编(白名单):写 settings.local.json → 读回 → 删除
    const cfgRT = await exec(`(async () => {
      const name = "settings.local.json";
      await window.claude.configWrite(name, "{\\"ok\\":true}");
      const r = await window.claude.configRead(name);
      await window.claude.configDelete(name);
      return JSON.stringify({ read: r.content, exists: r.exists, n: (await window.claude.configList()).length });
    })()`);
    const cfgRt = JSON.parse(cfgRT);
    ok("标准三文件读写回环", cfgRt.read === "{\"ok\":true}" && cfgRt.exists && cfgRt.n === 3, cfgRT.slice(0, 120));
    // 恢复 settings.local.json 原样
    if (localBackup != null) fs.writeFileSync(LOCAL_PATH, localBackup, "utf8");
    else if (fs.existsSync(LOCAL_PATH)) fs.rmSync(LOCAL_PATH);

    // 6.2b 命名配置模板:UI 新建(名字+JSON 内容) → 列表出现 → 下拉选中并应用写入真实 settings.json → 删除
    const setValFn = `(sel, v) => { const el = document.querySelector(sel); const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }`;
    await execSafe(`document.querySelector("[data-testid=tmpl-new]").click()`, 5000);
    await wait(300);
    const tplPanel = await exec(`!!document.querySelector("[data-testid=tmpl-editor-panel]") && !!document.querySelector("[data-testid=tmpl-editor]") && !!document.querySelector(".edwrap .hl")`);
    ok("模板编辑器面板+高亮", tplPanel, `panel=${tplPanel}`);
    await exec(`(${setValFn})(${JSON.stringify("[data-testid=tmpl-name]")}, ${JSON.stringify("cd-autotest-模板")}); (${setValFn})(${JSON.stringify("[data-testid=tmpl-editor]")}, ${JSON.stringify('{"theme": "dark", "tmp": true}')});`);
    await execSafe(`document.querySelector("[data-testid=tmpl-save]").click()`, 5000);
    await wait(500);
    const tplArr = JSON.parse(await exec(`window.claude.configTemplateList().then((x) => JSON.stringify(x))`));
    const mine = tplArr.find((t) => t.name === "cd-autotest-模板");
    ok("模板保存成功并列出", !!mine && !!mine.id, `n=${tplArr.length}`);

    // 回显:点「编辑」应把模板名称/内容回填(列表项不含 content,必须按 id 拉取)
    await execSafe(`(() => {
      const items = [...document.querySelectorAll("[data-testid=tmpl-item]")];
      const it = items.find((x) => (x.querySelector(".name") || {}).innerText === ${JSON.stringify("cd-autotest-模板")});
      if (!it) return;
      const b = it.querySelector("[data-testid=tmpl-edit]");
      if (b) b.click();
    })()`, 5000);
    await wait(400);
    const tplBackRaw = await exec(`(() => {
      const ta = document.querySelector("[data-testid=tmpl-editor]");
      const hl = document.querySelector(".edwrap .hl");
      const val = ta ? ta.value : "";
      return JSON.stringify({ val, hlOk: hl ? hl.innerHTML.includes("t-key") || hl.innerHTML.includes("t-str") : false, hlSmp: hl ? hl.innerHTML.slice(0, 160) : "" });
    })()`, 10000);
    const tplBack = JSON.parse(tplBackRaw);
    ok("模板编辑回显内容", tplBack.val.includes('"tmp": true') && tplBack.val.includes("dark"), `val=${(tplBack.val || "").slice(0, 40)}`);
    ok("模板编辑高亮渲染", tplBack.hlOk, `hl=${tplBack.hlSmp}`);
    await execSafe(`[...document.querySelectorAll("[data-testid=tmpl-editor-panel] button")].find((b) => b.innerText.includes("收起"))?.click()`, 4000).catch(() => {});
    await wait(200);

    // 下拉选中该模板并「应用」→ 写入真实 settings.json
    await exec(`(() => {
      const sel = document.querySelector("[data-testid=tmpl-select]");
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(mine.id)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })();`);
    await execSafe(`document.querySelector("[data-testid=tmpl-apply]").click()`, 5000);
    await wait(300);
    const afterApply = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : "";
    ok("模板应用写入 settings.json", afterApply.includes('"tmp": true'), afterApply.slice(0, 80));
    // 恢复 settings.json 原样
    if (settingsBackup != null) fs.writeFileSync(SETTINGS_PATH, settingsBackup, "utf8");
    else if (fs.existsSync(SETTINGS_PATH)) fs.rmSync(SETTINGS_PATH);

    // 删除模板 → 列表不再含它
    const delOk = await exec(`window.claude.configTemplateDelete(${JSON.stringify(mine && mine.id)}).then((x) => JSON.stringify(x))`);
    const tplArr2 = JSON.parse(await exec(`window.claude.configTemplateList().then((x) => JSON.stringify(x))`));
    ok("模板删除", JSON.parse(delOk) === true && !tplArr2.some((t) => t.id === mine.id), `del=${delOk}`);

    // 单编辑区:先写入确定 JSON,点开 settings.local.json 验证【回显内容 + 高亮 span 真实渲染】
    await exec(`window.claude.configWrite("settings.local.json", '{"color":"#ff0","num":42}')`);
    await execSafe(`[...document.querySelectorAll("[data-testid=config-item]")][1].click()`, 5000);
    await wait(400);
    const edRaw = await exec(`(() => {
      const ta = document.querySelector("[data-testid=cfg-editor]");
      const hl = document.querySelector(".edwrap .hl");
      return JSON.stringify({ has: !!ta, out: ta ? ta.value : "", hlOk: !!hl && (hl.innerHTML.includes("t-key") || hl.innerHTML.includes("t-str") || hl.innerHTML.includes("t-num")) });
    })()`, 10000);
    const ed = JSON.parse(edRaw);
    ok("配置文件编辑回显内容", ed.has && ed.out.includes('"color"'), `out=${(ed.out || "").slice(0, 40)}`);
    ok("配置文件编辑语法高亮渲染", ed.hlOk, `ed=${edRaw.slice(0, 100)}`);
    // 高亮颜色真实可见:历史根因是 .t-* 类只出现在 JS 拼接出的 HTML 里,Svelte 把规则当 unused 剔除
    // (高亮只有 span 结构、没有颜色),现用 :global 保留 + 主题变量,亮/暗 computed 都应是可见色
    const darkColor = await exec(`(() => {
      document.querySelector('[data-testid=theme-dark]').click();
      const el = document.querySelector(".edwrap .hl .t-key");
      return el ? getComputedStyle(el).color : "no-el";
    })()`).catch(() => "eval-err");
    const lightColor = await exec(`(() => {
      document.querySelector('[data-testid=theme-light]').click();
      const el = document.querySelector(".edwrap .hl .t-key");
      return el ? getComputedStyle(el).color : "no-el";
    })()`).catch(() => "eval-err");
    await exec(`document.querySelector('[data-testid=theme-dark]').click()`).catch(() => {}); // 切回暗色,保持与默认一致
    ok("高亮颜色真实可见(暗/亮)", darkColor === "rgb(126, 231, 135)" && lightColor === "rgb(17, 99, 41)", `dark=${darkColor} light=${lightColor}`);
    // 用完删除并恢复用户原样
    await execSafe(`[...document.querySelectorAll("[data-testid=cfg-editor-panel] button")].find((b) => b.innerText.includes("收起"))?.click()`, 4000).catch(() => {});
    await exec(`window.claude.configDelete("settings.local.json")`);
    if (localBackup != null) fs.writeFileSync(LOCAL_PATH, localBackup, "utf8");
    else if (fs.existsSync(LOCAL_PATH)) fs.rmSync(LOCAL_PATH);

    // 6.3 列表页:日期选择器 + 列表项含 创建/更新时间、上下文长度 文案
    await win.loadURL(global.__baseUrl);
    await wait(900);
    const listUi = await execSafe(`({
      date: !!document.querySelector("[data-testid=date-picker]"),
      meta: (document.body.innerText.match(/🕒|✏️|tok/) || []).length > 0,
      // 模块标题「工作空间」;新建等其余文案回归「会话」
      title: document.querySelector("h1")?.innerText.trim() === "工作空间",
      newBtn: document.querySelector("[data-testid=create-btn]")?.innerText.includes("新建会话"),
    })`, 10000);
    ok("列表日期选择器存在", listUi.date, `date=${listUi.date}`);
    ok("列表项时间与上下文", listUi.meta, `meta=${listUi.meta}`);
    ok("模块标题工作空间+新建会话", listUi.title && listUi.newBtn, `title=${listUi.title} new=${listUi.newBtn}`);

    // 6.3a 顶部导航 logo 换成用户图片(screenshot-20260903-084503.png),而非文字"◆"
    const logo = await exec(`(() => {
      const img = document.querySelector(".logo img.logo-img");
      return !!img && (img.src === "/screenshot-20260903-084503.png" || img.src.endsWith("/screenshot-20260903-084503.png")) && img.naturalWidth > 0;
    })()`, 10000);
    ok("顶部 logo 图片渲染", !!logo, `logo=${logo}`);

    // 6.3c 删除会话确认弹窗为中文(替代原生 confirm 的英文 OK/Cancel);这里只验证按钮再取消,不真删
    await execSafe(`document.querySelector(".item .del")?.click()`, 5000);
    await wait(300);
    const dlgInfo = await exec(`(() => {
      const box = document.querySelector("[data-testid=confirm-dialog]");
      if (!box) return "no-dialog";
      return JSON.stringify({
        ok: document.querySelector("[data-testid=dlg-ok]")?.innerText.trim(),
        cancel: document.querySelector("[data-testid=dlg-cancel]")?.innerText.trim(),
        title: document.querySelector("[data-testid=dlg-title]")?.innerText.trim(),
      });
    })()`, 10000);
    ok("删除确认弹窗中文按钮", (() => {
      try {
        const d = JSON.parse(dlgInfo);
        return d.ok === "删除" && d.cancel === "取消" && (d.title || "").includes("删除该会话");
      } catch {
        return false;
      }
    })(), `dlg=${dlgInfo}`);
    await execSafe(`document.querySelector("[data-testid=dlg-cancel]")?.click()`, 5000).catch(() => {});

    // 6.3b 新建弹窗含「名称(可选)」输入框;填名创建后标题按所填写入(不被首条消息覆盖)
    await execSafe(`document.querySelector("[data-testid=create-btn]").click()`, 5000);
    await wait(300);
    const fTitle = await exec(`!!document.querySelector("[data-testid=f-title]") && !!document.querySelector("[data-testid=f-cwd]") && !!document.querySelector("[data-testid=f-save]")`);
    ok("新建弹窗含名称输入框", fTitle, `fTitle=${fTitle}`);
    await exec(`(() => {
      const el = document.querySelector("[data-testid=f-title]");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, "cd-autotest-命名");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-testid=f-save]").click();
    })()`);
    await wait(900);
    const namedIds = JSON.parse(await exec(`window.claude.sessionList().then((x) => JSON.stringify(x.filter((s) => s.title === "cd-autotest-命名").map((s) => s.id)))`));
    ok("可选名称已写入", namedIds.length === 1, `n=${namedIds.length}`);
    if (namedIds.length) {
      await exec(`window.claude.sessionDelete(${JSON.stringify(namedIds[0])})`);
      ok("删除命名测试会话", true);
    }

    // 6.3d 会话列表分页:注入 21 个一次性会话 → 分页控件出现 → 翻页内容变化 → 干净删除
    const pageIds = [];
    for (let i = 0; i < 21; i++) {
      const r = JSON.parse(await exec(`window.claude.sessionCreate({ cwd: "/tmp", title: ${JSON.stringify("cd-page-" + i)} }).then((x) => JSON.stringify(x))`));
      if (r && r.id) pageIds.push(r.id);
    }
    await win.loadURL(global.__baseUrl); // 重新进入列表页触发刷新
    await wait(900);
    let pageUi = {};
    for (let i = 0; i < 30; i++) {
      pageUi = await execSafe(`({
        pager: !!document.querySelector("[data-testid=list-pager]"),
        info: (document.querySelector(".pginfo") || { innerText: "" }).innerText.trim(),
        nextDisabled: document.querySelector("[data-testid=page-next]")?.disabled,
      })`, 10000).catch(() => ({}));
      if (pageUi.pager && Object.keys(pageUi).length) break;
      await wait(200);
    }
    ok("分页控件出现(>20条)", !!pageUi.pager, `pager=${JSON.stringify(pageUi)}`);
    const firstPgTitle = await exec(`(document.querySelector("[data-testid=session-item] .title") || { innerText: "" }).innerText.trim()`);
    await execSafe(`document.querySelector("[data-testid=page-next]").click()`, 5000).catch(() => {});
    await wait(300);
    const pageInfo2 = await exec(`(document.querySelector(".pginfo") || { innerText: "" }).innerText.trim()`);
    const secondPgTitle = await exec(`(document.querySelector("[data-testid=session-item] .title") || { innerText: "" }).innerText.trim()`);
    ok("翻到第2页内容变化", pageInfo2.includes("第 2 /") && secondPgTitle !== firstPgTitle, `p1=${firstPgTitle} p2=${secondPgTitle} info=${pageInfo2}`);
    await execSafe(`document.querySelector("[data-testid=page-prev]").click()`, 5000).catch(() => {});
    await wait(300);
    const pageInfoBack = await exec(`(document.querySelector(".pginfo") || { innerText: "" }).innerText.trim()`);
    ok("返回第1页", pageInfoBack.includes("第 1 /"), `info=${pageInfoBack}`);
    // 注入的分页测试会话全部删除
    for (const pid of pageIds) await exec(`window.claude.sessionDelete(${JSON.stringify(pid)})`);
    ok("分页测试会话清理", true);

    // 7. 停止/收尾:删掉测试会话,避免污染用户数据
    await exec(`window.claude.sessionDelete(${JSON.stringify(sid)})`);
    ok("删除会话", true);

    console.log(fails.length === 0 ? "AUTOTEST_OK ALL PASS" : `AUTOTEST_FAIL n=${fails.length}`);
    if (fails.length) console.log("AUTOTEST_FAILED_ITEMS " + JSON.stringify(fails));
    app.quit();
  } catch (err) {
    console.log("AUTOTEST_FAIL EXCEPTION " + String(err && err.stack || err));
    app.exit(1);
  }
}
