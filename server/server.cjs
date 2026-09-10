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
// 对话历史库:MySQL 存 sessions/messages 表。
// 手机端打开会话直接从服务器读历史,设备离线也能看;桌面端把每次对话消息上行入库。
// 连接优先级:环境变量 RELAY_DB_* > config.json 的 db 字段 > 下方缺省(与服务器同机部署)。
const mysql = require("mysql2/promise");

let pool = null;
async function initDb() {
  if (pool) return;
  const cfg = {
    host: process.env.RELAY_DB_HOST || (config.db && config.db.host) || "127.0.0.1",
    port: Number(process.env.RELAY_DB_PORT || (config.db && config.db.port) || 3306),
    user: process.env.RELAY_DB_USER || (config.db && config.db.user) || "cd_relay",
    password: process.env.RELAY_DB_PASS || (config.db && config.db.password) || "",
    database: process.env.RELAY_DB_DATABASE || (config.db && config.db.database) || "claude_desk_relay",
    connectionLimit: 5,
    charset: "utf8mb4",
    dateStrings: true,
  };
  pool = mysql.createPool(cfg);
  // 建表:id 主键、(session_id, seq) 唯一,桌面端按 seq 递增 upsert,天然幂等。
  // 会话表:一条记录对应电脑端/手机端共享的一个 claude 会话
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(128) PRIMARY KEY COMMENT '会话ID(UUID,与电脑端一致)',
      device_id VARCHAR(128) COMMENT '所属设备ID(电脑端设备标识)',
      title TEXT COMMENT '会话标题',
      cwd TEXT COMMENT '会话工作目录',
      created_at BIGINT COMMENT '创建时间(毫秒时间戳)',
      updated_at BIGINT COMMENT '最后更新时间(毫秒时间戳)'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话元信息表'
  `);
  // 消息表:一个会话的全部对话消息,按 seq 递增 upsert 幂等,PC 与手机读到同一份
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
      session_id VARCHAR(128) COMMENT '所属会话ID(对应 sessions.id)',
      device_id VARCHAR(128) COMMENT '上报设备ID',
      seq INT COMMENT '会话内消息序号(自 1 递增,与 session_id 组成唯一键)',
      role VARCHAR(32) COMMENT '消息角色:user(用户)/assistant(claude回答)/ui(系统提示)',
      text LONGTEXT COMMENT '消息纯文本(正文摘要,完整结构见 blocks)',
      blocks LONGTEXT COMMENT '结构化消息块(JSON数组,含 text/error 等块类型)',
      message_id VARCHAR(128) COMMENT '桌面端消息ID(同一回答的多个块据此合并成一条)',
      ts BIGINT COMMENT '消息时间戳(毫秒)',
      status VARCHAR(32) COMMENT '回答状态:running(回答中)/awaiting(停在选择器)/done(完成)',
      type VARCHAR(32) COMMENT '回答类型:text(普通)/choice(单选方案)/checkbox(复选框,预留)',
      options LONGTEXT COMMENT '选择器选项(JSON数组,[{key,label}],type=choice 时使用)',
      UNIQUE KEY uk_session_seq (session_id, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话消息表'
  `);
  log("db 初始化:mysql", `${cfg.host}:${cfg.port}/${cfg.database}`);
}

// upsert 会话元信息(桌面端建会话/改名时上报)
async function dbUpsertSession(deviceId, s) {
  if (!pool || !s || !s.id) return;
  try {
    await pool.query(`
      INSERT INTO sessions (id, device_id, title, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE title=VALUES(title), cwd=VALUES(cwd), updated_at=VALUES(updated_at)
    `, [
      String(s.id),
      String(deviceId || ""),
      String(s.title || ""),
      String(s.cwd || ""),
      Number(s.createdAt) || Date.now(),
      Number(s.updatedAt) || Date.now(),
    ]);
  } catch (e) {
    log("dbUpsertSession 失败:", e && e.message);
  }
}

// upsert 一条消息(桌面端已聚合好的权威结构 {role,text,blocks,messageId,ts,status,type,options})
async function dbUpsertMessage(deviceId, sessionId, seq, msg) {
  if (!pool || !sessionId) return;
  const m = msg || {};
  try {
    await pool.query(`
      INSERT INTO messages (session_id, device_id, seq, role, text, blocks, message_id, ts, status, type, options)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        role=VALUES(role), text=VALUES(text), blocks=VALUES(blocks),
        message_id=VALUES(message_id), ts=VALUES(ts),
        status=VALUES(status), type=VALUES(type), options=VALUES(options)
    `, [
      String(sessionId),
      String(deviceId || ""),
      Number(seq) || 0,
      String(m.role || ""),
      m.text != null ? String(m.text) : "",
      m.blocks ? JSON.stringify(m.blocks) : null,
      m.messageId != null ? String(m.messageId) : null,
      Number(m.ts) || Date.now(),
      m.status != null ? String(m.status) : null,
      m.type != null ? String(m.type) : null,
      m.options ? JSON.stringify(m.options) : null,
    ]);
  } catch (e) {
    log("dbUpsertMessage 失败:", e && e.message);
  }
}

// 读一个会话的历史消息(按 seq 升序),blocks/options 反序列化回数组。
// opts 支持三种取法(手机端懒加载用),按优先级判断:
//   { beforeSeq } : 向更早翻页,取 seq<beforeSeq 的最近 limit 条(返回升序),hasMore=是否还有更早
//   { latest }    : 打开会话首屏,取最新 limit 条(返回升序),hasMore=是否还有更早未加载
//   { afterSeq }  : 增量轮询,取 seq>afterSeq 的 limit 条(升序)
//   无 opts       : 全量返回(兼容旧客户端/旧首屏)。
// 返回 { messages:[...], hasMore:bool };afterSeq 增量与旧逻辑一致,只是改成按 limit 限量。
async function dbGetMessages(sessionId, opts) {
  if (!pool) return { messages: [], hasMore: false };
  const limit = Math.max(1, Math.min(Number(opts && opts.limit) || 500, 500));
  const mapRow = (r) => ({
    seq: r.seq,
    role: r.role,
    text: r.text || "",
    blocks: r.blocks ? JSON.parse(r.blocks) : undefined,
    messageId: r.message_id || null,
    ts: r.ts,
    status: r.status || null,
    type: r.type || null,
    options: r.options ? JSON.parse(r.options) : undefined,
  });
  try {
    const sid = String(sessionId);
    let rows;
    let hasMore = false;
    if (opts && opts.beforeSeq != null) {
      const b = Number(opts.beforeSeq);
      [rows] = await pool.query(
        "SELECT * FROM messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
        [sid, b, limit + 1]
      );
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).sort((x, y) => x.seq - y.seq);
    } else if (opts && opts.latest) {
      [rows] = await pool.query(
        "SELECT * FROM messages WHERE session_id=? ORDER BY seq DESC LIMIT ?",
        [sid, limit + 1]
      );
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).sort((x, y) => x.seq - y.seq);
    } else {
      const after = Number(opts && opts.afterSeq) || 0;
      [rows] = await pool.query(
        after > 0
          ? "SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?"
          : "SELECT * FROM messages WHERE session_id=? ORDER BY seq ASC",
        after > 0 ? [sid, after, limit] : [sid]
      );
    }
    return { messages: rows.map(mapRow), hasMore };
  } catch (e) {
    // 历史读取失败会让手机端「打开会话/轮询/上翻」拿不到数据,必须留日志
    log("dbGetMessages 失败:", e && e.message);
    return { messages: [], hasMore: false };
  }
}

// ---- 配置:env > 命令行 > config.json;token 缺省自动生成并持久化 ----
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) {
  // 首次启动没有 config.json 属常态,由下方自动生成;其他读取失败才记日志说明用了缺省端口
  if (e && e.code !== "ENOENT") log("config.json 读取失败,使用缺省配置:", e && e.message);
}
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
  } catch (e) {
    // 写回失败只影响下次启动自动读取,不阻断本次运行,但必须留日志提醒(否则 token 会换)
    log("回写 config.json 失败(下次启动 token 可能变化):", e && e.message);
  }
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
  // choose:手机点选 claude 原生选择器的某项,转发给设备注入「方向键×N+回车」
  return ["list-sessions", "open-session", "exec", "choose", "stop", "new-session", "close-session"].includes(m.type);
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
      } else if (m.type === "messages") {
        // 手机端直接读服务器历史(不转发设备):设备离线也能看已入库的对话记录。
        // 按请求模式取:afterSeq 增量轮询 / latest 首屏最新一页 / beforeSeq 向上翻更早一页。
        dbGetMessages(m.sessionId, m).then((r) => {
          const out = { type: "messages", msgId: m.msgId, sessionId: m.sessionId, messages: r.messages, hasMore: r.hasMore };
          // 回显请求模式,手机端据此区分首屏替换 / 向上翻页(前置) / 增量追加
          if (m.afterSeq != null) out.afterSeq = m.afterSeq;
          else if (m.beforeSeq != null) out.beforeSeq = m.beforeSeq;
          else if (m.latest) out.latest = true;
          ws.send(JSON.stringify(out));
        }).catch((e) => {
          log("dbGetMessages 承诺拒绝:", e && e.message);
          ws.send(JSON.stringify({ type: "messages", msgId: m.msgId, sessionId: m.sessionId, messages: [] }));
        });
      } else if (isRequest(m)) {
        forwardToDevice(ws, m);
      }
    } else if (ws.role === "device") {
      // 设备上行:把会话元信息 / 对话消息落库(不带 msgId,不路由回手机,直接 return)
      if (m.type === "db-session") {
        dbUpsertSession(ws.deviceId, m.session);
        return;
      } else if (m.type === "db-message") {
        dbUpsertMessage(ws.deviceId, m.sessionId, m.seq, m.message);
        return;
      }
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

// 初始化 MySQL 连接池与建表;连接失败也照常起 relay(仅历史读写不可用),避免整站挂掉
initDb().catch((e) => log("db 初始化失败(历史读写不可用):", e && e.message));

server.listen(port, () => {
  const dbName = (config.db && config.db.database) || process.env.RELAY_DB_DATABASE || "claude_desk_relay";
  console.log("┌──────────────────────────────────────────────");
  console.log("│  Claude Desk 云中转服务已启动");
  console.log(`│  地址: http://0.0.0.0:${port}  (手机浏览器访问 = H5 遥控页)`);
  console.log(`│  服务: ws://<公网IP>:${port}/ws`);
  console.log(`│  token: ${token}`);
  console.log(`│  历史库: MySQL @ ${dbName}`);
  console.log("│  电脑端设置里填同一条地址与 token 即可连接");
  console.log("└──────────────────────────────────────────────");
});
