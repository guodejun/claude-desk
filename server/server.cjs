// Claude Desk 云中转服务(relay)
// 职责:一台公网/局域网服务器上跑着,电脑端与手机端都【外连】到它 —— 绕过家用 NAT,
//      消息经这里路由。「电脑端主动连出 + 手机端主动连出」对服务器来说都是连接,无需端口映射。
//
// 角色:
//   device(电脑端):开机即连上注册,能应答 list-sessions / open-session / exec / stop
//   phone (手机H5):连上后先看在线设备列表 → 选定一台 → 看它的会话列表 → 进对话发消息
//
// 协议(JSON over WebSocket,/ws 路径):
//   hello       → { type:"hello", role:"device"|"phone", token, deviceId?, deviceName? }
//   welcome     ← { type:"welcome", ok, role, error?, devices? }
//   list-devices→ { type:"list-devices", msgId }                          (phone)
//   devices     ← { type:"devices", msgId?, devices:[{deviceId,deviceName,online,since,ip}] } (全量广播+应答)
//   phone→device 请求(定向 deviceId):
//     { type:"list-sessions", msgId, deviceId }
//     { type:"open-session",  msgId, deviceId, sessionId }
//     { type:"exec",          msgId, deviceId, sessionId, text }
//     { type:"stop",          msgId, deviceId, sessionId }
//   device→phone 应答(server 按 msgId 路由回发起请求的那个连接):
//     { type:"sessions",      msgId, sessions:[...] }
//     { type:"session-info",  msgId, sessionId, title, tail }
//     { type:"result",        msgId, ok, text, error? }
//     { type:"answer",        msgId, ok, error? }
//
// 鉴权:一个共享 token(server/config.json,可用环境变量 RELAY_TOKEN / --token 覆盖)。
//       电脑与手机 hello 都带上它,对不上直接 welcome:{ok:false} 并断开。
//       首次启动未配置时自动生成并写回 config.json,打印到终端供复制。
//
// 心跳:服务器侧 ws 协议层 ping(30s),60s 无 pong 断开;设备离线后广播最新设备列表给手机。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- 配置:env > 命令行 > config.json;token 缺省自动生成并持久化 ----
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch {}
const argv = process.argv.slice(2);
const FLAG = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
let port = Number(FLAG("--port") || process.env.PORT || config.port || 8123);
let token = FLAG("--token") || process.env.RELAY_TOKEN || config.token;
if (!token) {
  token = "cd-" + crypto.randomBytes(9).toString("hex");
  config.token = token;
  config.port = port;
  try {
    fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, 2));
  } catch {}
  console.log("\n  ⚠ 未配置 token,已自动生成(已写入 server/config.json):");
  console.log(`    ${token}\n`);
}

// ---- WebSocket 服务(ws 库自带 HTTP upgrade 处理,挂在同一个 http server 上) ----
const { WebSocketServer, WebSocket } = require("ws");
const wss = new WebSocketServer({ noServer: true });

const devices = new Map(); // deviceId -> { ws, name, since, ip }
const pending = new Map(); // msgId -> { phone, at }  手机发起请求的后路由表(电脑应答后回给对应手机)
let phoneSeq = 0;

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function broadcastDevices() {
  const list = [...devices.values()].map((d) => ({
    deviceId: d.deviceId,
    deviceName: d.name,
    online: true,
    since: d.since,
    ip: d.ip,
  }));
  const msg = JSON.stringify({ type: "devices", devices: list });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.role === "phone") ws.send(msg);
  }
}

// 路由:手机的请求 → 对应设备的 ws;设备的应答 → 发起请求的那个手机
function isRequest(m) {
  return ["list-sessions", "open-session", "exec", "stop"].includes(m.type);
}
function forwardToDevice(ws, m) {
  const dev = devices.get(m.deviceId);
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "answer", msgId: m.msgId, ok: false, error: "设备不在线" }));
    return;
  }
  // 记下请求来自哪个连接,设备回执(带同一 msgId)时按此路由回去
  pending.set(m.msgId, { phone: ws, at: Date.now() });
  dev.ws.send(JSON.stringify(m));
}

// 清理过期 pending(exec 可能跑很久,给 1 小时上限,防内存无限涨)
setInterval(() => {
  const now = Date.now();
  for (const [mid, p] of pending) if (now - p.at > 60 * 60 * 1000) pending.delete(mid);
}, 5 * 60 * 1000);

wss.on("connection", (ws, req) => {
  ws.ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;

    // 未 hello 前只认 hello(其余一律忽略,防未鉴权乱发)
    if (!ws.role) {
      if (m.type !== "hello") return;
      if (m.token !== token) {
        ws.send(JSON.stringify({ type: "welcome", role: m.role, ok: false, error: "token 无效" }));
        ws.close();
        return;
      }
      ws.role = m.role;
      if (m.role === "device") {
        const id = String(m.deviceId || "").trim() || crypto.randomUUID();
        ws.deviceId = id;
        // 同 id 重连:顶掉旧连接(旧连接可能在服务器重启/续传后残留)
        const old = devices.get(id);
        if (old && old.ws !== ws) {
          try { old.ws.close(); } catch {}
        }
        devices.set(id, { ws, name: String(m.deviceName || m.deviceId || "电脑").slice(0, 40), since: Date.now(), ip: ws.ip, deviceId: id });
        log(`device 上线 [${id}] ${ws.ip}`);
        broadcastDevices();
        ws.send(JSON.stringify({ type: "welcome", role: "device", ok: true, deviceId: id }));
      } else if (m.role === "phone") {
        ws.phoneKey = "phone-" + ++phoneSeq;
        log(`phone 上线 [${ws.phoneKey}] ${ws.ip}`);
        const list = [...devices.values()].map((d) => ({ deviceId: d.deviceId, deviceName: d.name, online: true, since: d.since, ip: d.ip }));
        ws.send(JSON.stringify({ type: "welcome", role: "phone", ok: true, devices: list }));
      } else {
        ws.send(JSON.stringify({ type: "welcome", role: m.role, ok: false, error: "未知角色" }));
        ws.close();
      }
      return;
    }

    // 已鉴权通道的消息
    if (ws.role === "phone") {
      if (m.type === "list-devices") {
        const list = [...devices.values()].map((d) => ({ deviceId: d.deviceId, deviceName: d.name, online: true, since: d.since, ip: d.ip }));
        ws.send(JSON.stringify({ type: "devices", msgId: m.msgId, devices: list }));
      } else if (isRequest(m)) {
        forwardToDevice(ws, m);
      }
    } else if (ws.role === "device") {
      // 设备应答:带 msgId 的即路由回对应手机(实体数据透传,server 不解析内容)
      if (m.msgId && pending.has(m.msgId)) {
        const p = pending.get(m.msgId);
        pending.delete(m.msgId);
        if (p.phone && p.phone.readyState === WebSocket.OPEN) p.phone.send(JSON.stringify(m));
        else log("应答无手机接收(msgId=" + m.msgId + "),丢弃");
      } else if (m.type === "answer" && m.msgId) {
        // 兜底:answer 即使没有 pending 也原样回给请求方(不存在则丢弃)
      }
    }
  });
  ws.on("close", () => {
    if (ws.role === "device" && ws.deviceId) {
      const d = devices.get(ws.deviceId);
      if (d && d.ws === ws) {
        devices.delete(ws.deviceId);
        log(`device 下线 [${ws.deviceId}]`);
        broadcastDevices();
      }
    }
    // 该连接发起的未完成请求全部作废
    for (const [mid, p] of pending) if (p.phone === ws) pending.delete(mid);
    if (ws.role === "phone") log(ws.phoneKey + " 下线");
  });
});

// 心跳:每 30s ping 所有连接,60s 无 pong 视为死连接断开
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// ---- HTTP:提供静态 H5(public/),WebSocket 服务挂在 /ws ----
const PUB = path.join(__dirname, "public");
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(PUB, path.normalize(p));
  const safe = file.startsWith(PUB);
  if (!safe || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("404 Not Found");
  }
  const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, devices: devices.size, token: !!token }));
  }
  serveStatic(req, res);
});
server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return socket.destroy();
  }
  if (url.pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(port, () => {
  console.log("┌──────────────────────────────────────────────");
  console.log("│  Claude Desk 云中转服务已启动");
  console.log(`│  地址: http://0.0.0.0:${port}  (手机浏览器访问 = H5 遥控页)`);
  console.log(`│  服务: ws://<公网IP>:${port}/ws`);
  console.log(`│  token: ${token}`);
  console.log("│  电脑端设置里填同一条地址与 token 即可连接");
  console.log("└──────────────────────────────────────────────");
});
