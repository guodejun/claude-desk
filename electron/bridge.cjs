// 电脑端云连接桥:以 device 角色【外连】到云中转服务(server/server.cjs),
// 使手机 H5 能远程操作本机 claude 会话。核心思路与手机端一致——都主动连出,绕开 NAT。
//
// 职责:
//   - 外连 WSS / 分发 hello 注册 / ws 层心跳 / 指数退避断线重连
//   - 应答手机请求(list-sessions / open-session / exec / stop),
//     exec 复用本应用的真实 PTY:open 幂等 + interact 等「答完」再回传,输出与桌面实时同步
//   - 连接状态经 onStatus 上报主进程(设置页展示 / 状态广播)
//
// 配置来自 persistence 的 app-settings.json 的 cloud 字段(serverUrl/token/deviceName/autoStart),
// deviceId 首次生成后存 userData/cloud-device-id(重装前的身份保持,服务端会顶掉同 id 旧连接)。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require("ws");
const persistence = require("./persistence.cjs");
const pty = require("./pty.cjs");
const log = require("./log.cjs");

let userData = "";
let deviceId = "";
let cfg = { serverUrl: "", token: "", deviceName: "桌面电脑", autoStart: false };
let ws = null;
let state = "off"; // off | connecting | online | error
let stateReason = "";
let onlineSince = 0;
let attempts = 0;
let pingTimer = null;
let lastPong = 0;
let manualStop = false;
let statusFn = () => {}; // 状态变更回调(main.cjs 挂载 → 转发渲染层)

// 体温:断线重连指数退避 1s->30s 封顶
const reconnectWait = () => Math.min(1000 * Math.pow(2, attempts), 30000);

function setState(s, reason = "") {
  state = s;
  stateReason = reason;
  log.log("info", `cloud 状态=${s}${reason ? " 原因=" + reason : ""}`);
  statusFn({ state, serverUrl: cfg.serverUrl, deviceName: cfg.deviceName, deviceId, reason: stateReason, onlineSince: state === "online" ? onlineSince : 0 });
}

function deviceFile() {
  return path.join(userData, "cloud-device-id");
}
function loadDeviceId() {
  try {
    const s = JSON.parse(fs.readFileSync(deviceFile(), "utf8"));
    if (s && s.id) return s.id;
  } catch {}
  const id = "dev-" + crypto.randomUUID();
  try {
    fs.writeFileSync(deviceFile(), JSON.stringify({ id, createdAt: Date.now() }), "utf8");
  } catch {}
  return id;
}

// 规范化服务器地址:允许只填 ip:port,自动补 ws:// 与 /ws 路径
function normalizeUrl(raw) {
  let url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
  if (!/\/ws$/i.test(url)) {
    if (url.endsWith("/")) url = url.slice(0, -1);
    // 兼容填写了完整 ws://host/ 或 ws://host/xxx 的情况
    const u = /^wss?:\/\/[^/]+/.exec(url);
    url = (u ? u[0] : url) + "/ws";
  }
  return url;
}

// ---- 手机请求的应答(串行队列,保证手机端多条指令按序执行) ----
let queue = Promise.resolve();
function enqueue(fn) {
  const r = queue.then(fn);
  queue = r.catch(() => {});
  return r;
}

function sessionOf(id) {
  return persistence.getSession(id);
}

function handleListSessions(msgId) {
  const sessions = persistence.listSessions().map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    running: s.running,
    updatedAt: s.updatedAt,
    ctxTok: s.ctxTok,
  }));
  send({ type: "sessions", msgId, sessions });
  log.log("info", `cloud list-sessions → ${sessions.length} 条`);
}

function handleOpenSession(msgId, sessionId) {
  const s = sessionOf(sessionId);
  if (!s) return send({ type: "answer", msgId, ok: false, error: "会话不存在" });
  // 回传该会话最近实录尾段,让手机端看到之前对话(去装饰后的 transcript 已落盘)
  const tail = (s.transcript || "").replace(/\s+$/g, "").slice(-1800);
  send({ type: "session-info", msgId, sessionId, title: s.title, tail });
}

async function handleExec(msgId, sessionId, text) {
  const s = sessionOf(sessionId);
  // 会话不存在 / 工作目录失效 → open 会报错,这里先拦一层给出友好提示
  if (!s) return send({ type: "result", msgId, ok: false, error: "会话不存在，请先在电脑端刷新会话列表" });
  const r = pty.open(sessionId, { cwd: s.cwd, argText: s.argText, skipPermissions: s.skipPermissions });
  if (r && r.error) return send({ type: "result", msgId, ok: false, error: r.error });
  // 写进真实终端并等答完(与本地队列引擎同一机制),结果原样回传;手机消息同步显示在桌面终端
  const out = await pty.interact(sessionId, text + "\r");
  if (out && out.error) return send({ type: "result", msgId, ok: false, error: out.error });
  send({ type: "result", msgId, ok: true, text: cleanAnswer(out && out.text, text) });
  log.log("info", `cloud exec 完成(会话 ${sessionId.slice(0, 8)}…)`);
}

// 回传文本清理:去掉 TUI 把用户消息回显在输入行的重复行与残余控制符,其余保留(与桌面所见一致)
function cleanAnswer(raw, input) {
  let t = String(raw || "").replace(/\u0007/g, "");
  const lines = t.split("\n");
  if (lines.length > 1 && lines[0].replace(/\s+/g, " ").trim() === String(input || "").replace(/\s+/g, " ").trim()) lines.shift();
  return lines.join("\n").replace(/\s+$/g, "").trim();
}

function handleStop(msgId, sessionId) {
  // 中断正在进行的生成(Ctrl+C),终端若存在才写
  const done = pty.write(sessionId, "\x03");
  send({ type: "answer", msgId, ok: true, interrupted: done });
}

function onMessage(buf, t) {
  let m;
  try {
    m = JSON.parse(buf.toString());
  } catch {
    return console.log("cloud 收到非法消息");
  }
  if (m.type === "list-sessions") return enqueue(() => handleListSessions(m.msgId));
  if (m.type === "open-session") return enqueue(() => handleOpenSession(m.msgId, m.sessionId));
  if (m.type === "exec") return enqueue(() => handleExec(m.msgId, m.sessionId, m.text));
  if (m.type === "stop") return enqueue(() => handleStop(m.msgId, m.sessionId));
}

// ---- 连接管理 ----
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startHeartbeat() {
  stopHeartbeat();
  lastPong = Date.now();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > 60000) {
      log.log("warn", "cloud 心跳超时,强制重连");
      try { ws.terminate(); } catch {} // terminate 触发 close → 走重连
      return;
    }
    ws.ping();
  }, 25000);
}
function stopHeartbeat() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function connect() {
  if (!cfg.serverUrl || !cfg.token) {
    setState("off", "未配置");
    return;
  }
  manualStop = false;
  const url = normalizeUrl(cfg.serverUrl);
  if (!url) {
    setState("error", "服务器地址无效");
    return;
  }
  setState("connecting");
  let closedOnce = false;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setState("error", "地址无效：" + String((e && e.message) || e));
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    attempts = 0;
    send({ type: "hello", role: "device", deviceId, deviceName: cfg.deviceName, token: cfg.token });
  });
  ws.on("message", (buf) => {
    // 本连接握手应答:服务端确认上线才置 online
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      m = null;
    }
    if (m && m.type === "welcome") {
      if (m.ok !== false && m.role === "device") {
        onlineSince = Date.now();
        setState("online");
      } else {
        setState("error", (m.error || "服务端拒绝"));
        scheduleReconnect();
      }
      return; // welcome 不再走下面的指令分发
    }
    onMessage(buf);
  });
  ws.on("pong", () => (lastPong = Date.now()));
  ws.on("close", () => {
    cleanWs();
    if (!closedOnce) {
      closedOnce = true;
      if (!manualStop) setState("off", "连接断开");
      scheduleReconnect();
    }
  });
  ws.on("error", (e) => {
    stateReason = String((e && e.message) || e);
  });
  startHeartbeat();
}

function cleanWs() {
  stopHeartbeat();
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
      ws.terminate();
    } catch {}
    ws = null;
  }
}

function scheduleReconnect() {
  if (manualStop) return;
  const wait = reconnectWait();
  attempts++;
  setTimeout(() => {
    if (!manualStop) connect();
  }, wait);
}

function applyConfig(next) {
  // 只更新提供的字段,未提供的保留现值(避免「断开」这种局部调用把地址/token 清掉)
  const merged = {
    serverUrl: next.serverUrl !== undefined ? next.serverUrl : cfg.serverUrl,
    token: next.token !== undefined ? next.token : cfg.token,
    deviceName: next.deviceName !== undefined ? next.deviceName : cfg.deviceName,
    autoStart: next.autoStart !== undefined ? !!next.autoStart : cfg.autoStart,
  };
  const changed =
    cfg.serverUrl !== merged.serverUrl ||
    cfg.token !== merged.token ||
    cfg.deviceName !== merged.deviceName;
  cfg = merged;
  if (!cfg.autoStart) {
    // 关闭云连接:彻底断开且不再自动重连
    manualStop = true;
    cleanWs();
    setState("off", "已关闭");
    return;
  }
  if (state === "online" && !changed) return; // 配置没变且已在线,不动
  cleanWs();
  connect();
}

function start() {
  manualStop = false;
  connect();
}
function stop() {
  manualStop = true;
  cleanWs();
  setState("off", "已手动停止");
}

function status() {
  return { state, serverUrl: cfg.serverUrl, token: cfg.token ? true : "", deviceName: cfg.deviceName, deviceId, reason: stateReason, onlineSince };
}

module.exports = {
  init(options = {}) {
    userData = options.userData || "";
    deviceId = loadDeviceId();
  },
  onStatus(fn) {
    statusFn = fn;
  },
  applyConfig,
  start,
  stop,
  status,
};
