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
const { spawn } = require("child_process");
const { WebSocket } = require("ws");
const persistence = require("./persistence.cjs");
const pty = require("./pty.cjs");
const log = require("./log.cjs");
const { cleanTranscript } = require("./transcript.cjs");

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
let chooserFn = () => {}; // 回答停在选择器回调(main.cjs 挂载 → 把该回答标为 awaiting/choice 入库)
let cloudMsgFn = () => {}; // 手机触发对话回调(main.cjs 挂载 → 把「用户消息+回答」走统一上行入库)。
// 记录各会话「刚全新打开终端」的时刻(fresh)。open-session 会把电脑端终端拉起来,
// 若不等 claude 就绪就回传,exec 再 open 时拿到 fresh:false 会误判"已运行"而跳过等待,
// 导致消息落空。这里记下时间,exec 据此刻距是否够 4.5s 来决定补等。
const freshOpens = new Map(); // sessionId -> ms
const BOOT_MS = 4500; // claude 启动打印横幅到就绪的大致耗时

// ---- exec 执行看门狗 ----
// claude 会话偶尔会「僵死」:①持续输出但永远不到空闲提示符(hasBody 有了但 idle 一直 false),
// ②或静默不返回。此时 waitDone 靠 maxMs 兜底,而 maxMs 高达 8 分钟,期间串行队列
// (enqueue)被该 exec 占满 → 手机端后续 open-session/exec/stop 全部排队,表现「cloud 在线但消息石沉大海」。
// 这里给每个 exec 设一个较短的限时:超时即向终端发 Esc 中断(同手机端「停止」,claude 打断生成用 Esc),
// 并置 aborted 让 waitDone 提前返回,
// 保证队列释放、用户能感知「超时了」而不是无限等待。长回答(大表格/长代码)持续输出会一直重置
// quietSince、且最终到 idle,不会被误伤;只有「异常不返回」才会撞上这个限时。
const EXEC_WATCHDOG_MS = 180 * 1000; // 异常执行最多等 180s,超时强制中断
const execGuards = new Map(); // sessionId -> { aborted, timer, msgId }
function armExecGuard(sessionId, msgId) {
  disarmExecGuard(sessionId);
  const g = { aborted: false, msgId };
  g.timer = setTimeout(() => {
    g.aborted = true;
    log.log("warn", `[exec-guard] 会话 ${String(sessionId).slice(0, 8)}… 执行超 ${EXEC_WATCHDOG_MS / 1000}s 未完成,发送中断(Esc)`);
    try { pty.write(sessionId, "\x1b"); } catch {}
  }, EXEC_WATCHDOG_MS);
  execGuards.set(sessionId, g);
  return g;
}
function disarmExecGuard(sessionId) {
  const g = execGuards.get(sessionId);
  if (g) { clearTimeout(g.timer); execGuards.delete(sessionId); }
}

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
// 注意保留用户填写的子路径(如 ws://host/claude → /claude/ws),以支持 nginx 反代
function normalizeUrl(raw) {
  let url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
  if (!/\/ws$/i.test(url)) url += "/ws";
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
  // 电脑同步:手机打开会话时,把电脑端终端也拉起来(open 幂等,已运行则秒回)。
  // 这样手机看到的就是电脑端同一会话,发送后电脑端也在同一终端执行,后续历史能接上。
  const r = pty.open(sessionId, { cwd: s.cwd, argText: s.argText, skipPermissions: s.skipPermissions });
  if (r && r.fresh) freshOpens.set(sessionId, Date.now());
  // 实时实录优先(终端还开着);否则落盘的干净 transcript。切片后做行过滤,
  // 让手机看到的「最近记录」只剩对话正文,不再夹杂 TUI 状态行/动画残片
  const live = pty.liveTranscript(sessionId, 400000);
  const raw = (live || (s && s.transcript) || "").replace(/\s+$/g, "");
  const tail = filterBodyLines(raw.slice(-4000)).slice(-1800);
  send({ type: "session-info", msgId, sessionId, title: s.title, tail });
}

// 等待 claude TUI 就绪:出现【空的输入框】且终端输出已静默。
// claude 启动(尤其 --resume 大历史)要打印横幅/加载上下文,可达十几秒,固定 BOOT_MS 不可靠——
// 未就绪时写入的 \r 会被 TUI 吞掉,导致问题落空。
// 就绪特征(实测剥离 ANSI 后的真实形态):输入框是 `❯ ` 紧跟一条分隔线 `────`(空输入),
// 即「最后一个 ❯ 之后没有用户文字、直接接 ─ 分隔线」。若 ❯ 后是文字说明仍在启动/加载。
// 上限 readyTimeoutMs 兜底(超时也继续,交给后续 waitDone 判)。
function waitReady(sessionId, readyTimeoutMs = 60000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let lastRaw = pty.rawOf(sessionId);
    let quietSince = Date.now();
    let stable = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      const raw = pty.rawOf(sessionId);
      if (raw !== lastRaw) { lastRaw = raw; quietSince = now; stable = 0; }
      const clean = pty.liveTranscript(sessionId, 200000) || "";
      // 就绪特征:最后一个 ❯ 之后是「空白+分隔线─」(空输入框),而非用户文字/加载动画
      const li = clean.lastIndexOf("❯");
      let idlePrompt = false;
      if (li >= 0) {
        const after = clean.slice(li + 1).replace(/^\s+/, ""); // ❯ 之后去前导空白
        // 空输入框:紧跟 ─ 分隔线 / ⏵ 状态栏,或直接到串尾(无内容)
        idlePrompt = /^[─━]/.test(after) || after === "" || /^⏵/.test(after);
      }
      // 仍在输出字节 → 未就绪;静默超 1.2s 且出现空输入框 → 就绪
      if (idlePrompt && now - quietSince > 1200) {
        stable++;
        if (stable >= 2) { clearInterval(timer); log.log("info", `[waitReady] 就绪 耗时=${((now - t0) / 1000).toFixed(1)}s`); return resolve(true); }
      } else if (!idlePrompt) stable = 0;
      if (now - t0 > readyTimeoutMs) {
        clearInterval(timer);
        log.log("info", `[waitReady] ${(readyTimeoutMs / 1000) | 0}s 未就绪,按未就绪处理`);
        resolve(false);
      }
    }, 300);
  });
}

async function handleExec(msgId, sessionId, text) {
  // 武装执行看门狗:claude 僵死时超时自动 Ctrl+C 中断并释放队列(见文件头 exec 看门狗说明)
  const guard = armExecGuard(sessionId, msgId);
  try {
    const s = sessionOf(sessionId);
    // 会话不存在 / 工作目录失效 → open 会报错,这里先拦一层给出友好提示
    if (!s) return send({ type: "result", msgId, ok: false, error: "会话不存在，请先在电脑端刷新会话列表" });
    const r = pty.open(sessionId, { cwd: s.cwd, argText: s.argText, skipPermissions: s.skipPermissions });
    if (r && r.error) return send({ type: "result", msgId, ok: false, error: r.error });
    // 就绪检测:不依赖固定 BOOT_MS,轮询到 claude 出现空输入框再写入,
    // 避免 claude --resume 大历史启动慢导致消息被吞、问题落空。
    if (r.fresh) freshOpens.set(sessionId, Date.now());
    const ready = await waitReady(sessionId);
    // 未等到明确就绪信号:不盲目写入(会被吞),回明确错误让手机端稍后重试。
    // 仅当终端确实没在跑(open 失败已拦)才可能到这,正常路径 ready=true。
    if (!ready && r.fresh) {
      return send({ type: "result", msgId, ok: false, error: "电脑端正在启动会话，请稍后重试" });
    }
    // 写进真实终端;TUI 停滞判定会在思考期(无输出)提前判「答完」,
    // 故再轮询实时实录,等「出现正文 + 回到空闲提示符」才认为真答完
    const out = await pty.interact(sessionId, text + "\r");
    if (out && out.error) return send({ type: "result", msgId, ok: false, error: out.error });
    // 等待答完:不再用固定总时长,而是「电脑端还在输出就持续等」。
    // quietMs=25s:claude 字节流连续静默 25s 才认为真停;maxMs=8 分钟绝对上限兜底。
    // 这样大表格/长代码(分多段流式输出、单段思考耗时长)不会被误判超时打断。
    await waitDone(sessionId, text, { quietMs: 25000, maxMs: 8 * 60 * 1000 });
    // 检测原生选择器(AskUserQuestion):claude 弹出「↑/↓ to navigate」交互菜单等待选择时,
    // 普通文字回答无法操作,须把手机端这次结果标记为「待选择」并附上选项个数,
    // 手机渲染成序号按钮,用户点选后发 choose 消息,由 bridge 注入「方向键×N + 回车」完成选择。
    // 先检测:选择器场景下 extractAnswer 的正文可能被 filterBodyLines 滤得很残,不能因空就报错。
    let chooser = detectChooser(sessionId);
    // 回传干净实录中「本次问题之后」的正文(而非原始字节切片,避免 TUI 帧乱码)
    const ans = extractAnswer(sessionId, text);
    // 看门狗触发:已超时中断,明确告知用户,而不是让手机端一直「回答中」或误报「没等到回答」
    if (guard.aborted) {
      return send({ type: "result", msgId, ok: false, error: "电脑端长时间未返回，已中断。若无响应请重试或重开会话。" });
    }
    if (!ans && !(chooser && chooser.options.length)) {
      return send({ type: "result", msgId, ok: false, error: "没等到回答，请稍后重试" });
    }
    // 方案A:把被 TUI 重绘破坏的表格/代码经模型还原成干净 markdown 再发给手机,
    // 否则手机端 markdown 渲染到的是一堆 ├─┼─┤ 框线残片与截断单元格。
    // 含表格/残片特征才格式化(纯文本直接透传),用一点 token 和时间换手机端显示正确。
    // 选择器场景:正文残缺,给一句引导语,选项交给 chooser 序号按钮。
    let clean = ans ? await formatAnswer(ans) : "**电脑端弹出了选项，请在下方点选：**";
    // 回答停在选择器:把本次回答标为 awaiting/choice 并入库(手机端历史恢复时能还原成选择卡)。
    // 解析正文里的真实选项文字,失败回退占位「选项 i」。multiSelect 一并透传,供手机端渲染为复选框。
    if (chooser && chooser.options && chooser.options.length) {
      // 优先用正文解析出的真实选项文字;解析不到时保留 detectChooser 已从选择器行提取的标题
      // (多选往下拉 checkbox 行已带真实标题,避免被「选项 i」占位覆盖)
      const parsed = parseOptionLabels(clean, chooser.options.length);
      chooser.options = chooser.options.map((o, i) => {
        const pi = parsed[i];
        const ph = "选项 " + (i + 1);
        if (pi && pi.label && pi.label !== ph) return { key: o.key, label: pi.label };
        if (o.label && o.label !== ph) return { key: o.key, label: o.label };
        return { key: o.key, label: ph };
      });
      // jsonl 权威选择器(main 从 claude jsonl 提取的干净 question/options/multiSelect)。
      // 若有,覆盖本端从 pty 字节流猜的 chooser 与正文 —— pty 转录被 TUI 重绘污染(「选苹果」「[]2 香蕉」),
      // 而 jsonl 的 tool_use 是结构化权威数据,手机端即时回显才与 DB 历史一致、无脏残留。
      const jc = chooserFn({ sessionId, options: chooser.options, text: clean, multiSelect: !!chooser.multiSelect });
      if (jc && jc.options && jc.options.length) {
        chooser = { options: jc.options, multiSelect: !!jc.multiSelect };
        clean = jc.question || clean;
      }
    }
    send({ type: "result", msgId, ok: true, text: clean, chooser: chooser || undefined });
    // 手机触发的对话也走统一入库:把「用户消息 + 本次回答」转发给 main.cjs 的 onSessionEvent,
    // 复用与桌面本地同一套 upSeq/pushUp 机制上行到服务器 MySQL(断线重连对账口径一致)。
    // choice:选择器场景已由 chooserFn(markPendingChoice) 单独标 awaiting/choice 入库,
    // 这里用 choice 标记通知 main「不要再重复上行 assistant,只补上行用户消息」。
    cloudMsgFn({
      sessionId,
      userText: text,
      answerText: clean,
      choice: chooser && chooser.options && chooser.options.length ? chooser.options : null,
      choiceMulti: !!(chooser && chooser.multiSelect),
    });
    log.log("info", `cloud exec 完成(会话 ${sessionId.slice(0, 8)}…${chooser ? " 待选择:" + chooser.options.length + "项" : ""})`);
  } finally {
    disarmExecGuard(sessionId);
  }
}

// 检测 claude 是否正停在原生选择器(AskUserQuestion 的交互菜单),是则返回选项个数。
// 判定锚点(transcript 尾部稳定出现):「↑/↓ to navigate」/「Enter to select」。
// 注意:必须在【原始实时实录】上检测——filterBodyLines 会把选择器行当残片滤掉。
//
// 实测关键(独立 pty 验证):选择器当前高亮项前有「❯」标记,发 \x1b[B 每按一次高亮下移一项,\r 确认。
// 选项文字在 TUI 转录里已残缺错位(连行/折行/编号被光标吃),不值得费力精确解析——
// 完整的选项描述在 exec 的回答正文里(经 formatAnswer 还原的干净 markdown)已有,选择器菜单与正文重复。
// 故这里只确定「在选择器中 + 选项个数 N」:手机端显示正文 + 底部 N 个序号按钮,用户看着正文点序号,
// bridge 注入「\x1b[B×(n-1) + \r」选中。选项个数取「Type something/Chataboutthis 之前的最大编号」,
// 解析不到编号则回退高亮法(数 ❯ 后区域不行)给保守值。
// 判断「选择器是否正激活在终端底部」,返回该锚点下标(在待测串内),否则 -1。
// 选择器(AskUserQuestion)激活时,操作提示行「Enter to select · ↑/↓ to navigate」是当前帧最后一行,
// 之后几乎无内容。但历史弹出的选择器菜单会**长期残留在 transcript**(claude 每帧重绘保留旧帧),
// 即使选择器早已确认关闭,提示行也留在转录中间,下面还跟着确认后的回答/命令回显。
// 故:取最后一个锚点,若其后还有较多非空白实质内容(>40字符)= 历史残留,不算激活。
// 否则罢工场景:claude 明明在正常回答(长代码/大表格),却被误判成「停在选择器」,
// 导致 exec 提前返回「弹出了选项」或 waitDone 提前判答完。
function chooserActiveAt(s) {
  const re = /to navigate|Enter to select|↑\/↓/gi;
  let idx = -1, m, matched = "";
  while ((m = re.exec(s))) { idx = m.index; matched = m[0]; }
  if (idx < 0) return -1;
  const after = s.slice(idx + matched.length).replace(/\s+/g, "");
  if (after.length > 40) return -1; // 锚点后还有回答/回显等输出 → 历史残留
  return idx;
}

// 选择器是否多选(AskUserQuestion 的 multiSelect:true 复选框):
// 选项行会带复选框标记「❯1.[]启用日志增强」([] 未选 / [✔] 已选),且提示多为
// 「Enter to select · ↑/↓ to navigate」+ 每项两行式(标题+描述)。单选选择器选项行无 []。
// 只看「数字. []」前缀的行,避免把正文里的 markdown [x] 误当选择器。
function hasCheckboxOption(region) {
  return /[❯▸>]?\s*\d\s*[.、]\s*\[\s*[ x✔☑✓]?\s*\]/.test(region);
}

// 清理选项标签:去掉复选框标记( [] / [✔] / ☒ )等 TUI 装饰,压缩空白,避免手机端按钮带上脏前缀。
function cleanOptionLabel(x) {
  let t = String(x || "");
  t = t.replace(/[\[\]【】☒✔☑✓✖]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
// 判定是否为选择器特殊项(claude 在列表末尾固定附带的非选项)。
// 用宽松匹配(去掉空格再比较)以容忍 TUI 转录把「Type something」撕裂成「Typsomething」等乱码。
function isSpecialOption(x) {
  const t = String(x || "").replace(/\s+/g, "").toLowerCase();
  return /typesomething|typsomething|chatabout|submit|cancel|取消|提交/.test(t);
}

// 唯一用途:detectChooser 主路径解析选择器选项,单选/多选共用。
// 统一按「编号 + 标签」解析选择器选项(单选/多选共用)。
// 逐行剥掉行首光标(❯▸>)与复选框标记([]/[ ]/[✔]/☒),再匹配「数字. 标签」;含 checkbox 的行还能顺带清掉脏前缀。
// 既用于多选(复选框),也用于单选(编号菜单),并过滤 Type something/Chat about this 等特殊项——
// 否则会把它们误当可选按钮,手机端显示成假的尽头项(如「4 Type something.」「[ ] Typsomething」)。
function parseNumberedOptions(region) {
  const out = [];
  const seen = new Set();
  for (let line of region.split("\n")) {
    line = line.replace(/^[❯▸>\s]+/, "");
    line = line.replace(/^\[\s*[ x✔☑✓✖]?\s*\]\s*/, "");
    line = line.replace(/^[☒✔☑✓✖]\s*/, "");
    const m = line.match(/^(\d)\s*[.、) ]\s*([^\n].*)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const label = cleanOptionLabel(m[2]);
    if (!label || isSpecialOption(label)) continue;
    if (n >= 1 && n <= 20 && !seen.has(n)) { seen.add(n); out.push({ key: String(n), label: label.slice(0, 40) }); }
  }
  out.sort((a, b) => parseInt(a.key, 10) - parseInt(b.key, 10));
  return out;
}

function detectChooser(sessionId) {
  // 取大窗口:会话历史长时选择器菜单可能沉到几千字之前,小窗口(如 60000)会把它截掉导致误判无选择器。
  // 与 open-session 的 tail 口径一致(400000),确保 choose 到达时仍能看见选择器锚点。
  const clean = pty.liveTranscript(sessionId, 400000) || "";
  const tail = clean.slice(-4000);
  // 找最后一个「选择器锚点」并确认它激活在终端底部(见 chooserActiveAt):
  // 若提示行后还有大量输出,说明是已关闭选择器的历史残留——claude 可能在正常回答,
  // 误判会把写到一半的长代码/表格截成「弹出了选项」。
  const anchorIdx = chooserActiveAt(tail);
  if (anchorIdx < 0) return null;
  // 截取锚点之前区域,统计出现过的「编号.」(1~9)最大值即选项数
  const region = tail.slice(0, anchorIdx);
  const flat = region.replace(/\n+/g, " ");
  // 单选/多选统一按「编号 + 标签」解析(剥 [] 脏前缀、过滤 Type something 等特殊项);解析不到再回退占位。
  // 多选(复选框)由 hasCheckboxOption 判定,选项行带 []/[✔],parseNumberedOptions 能一并清理。
  const options = parseNumberedOptions(region);
  if (options.length >= 2) {
    return { options, multiSelect: hasCheckboxOption(region) };
  }
  // 回退:按检测到的最大编号生成占位(此时只在解析被 TUI 折行严重撕裂时才走到,尽可能清掉特殊项后的真实编号)
  const nums = parseNumberOptions(flat);
  const maxNum = nums.length ? nums[nums.length - 1] : 0;
  if (maxNum < 2) return { options: [] };
  const opts = [];
  for (let i = 1; i <= maxNum; i++) opts.push({ key: String(i), label: "选项 " + i });
  return { options: opts, multiSelect: hasCheckboxOption(region) };
}
// 唯一用途:detectChooser 回退分支,当 parseNumberedOptions 解析不到选项时,
// 按检测到的最大编号生成「选项 i」占位(仅在 TUI 折行撕裂较严重时才走到)。
function parseNumberOptions(flat) {
  const nums = [];
  const re = /(\d)\s*[.、]\s*\S/g;
  let m;
  while ((m = re.exec(flat))) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 9 && !nums.includes(n)) nums.push(n);
  }
  return nums.sort((a, b) => a - b);
}

// 多选提交:按「→」(\x1b[C)之后等待 claude 切到确认屏(「Ready to submit your answers?」「Submit answers」)。
// 确认屏渲染出来时光标默认停在高亮的「1. Submit answers」,此刻再发 \r 才真正提交;
// 若过早发 \r 会仍落在勾选页,把回车误当成"切换勾选"。等不到确认屏则超时返回(调用方仍补发 \r 兜底)。
// fromIndex 传注入前的实录长度:只匹配「→」之后**新出现**的确认帧,避免历史残留帧被误判为已就绪。
function waitForConfirmScreen(sessionId, timeoutMs, fromIndex) {
  const end = Date.now() + (timeoutMs || 2000);
  return new Promise((resolve) => {
    const tick = () => {
      const t = (pty.liveTranscript(sessionId, 400000) || "");
      const tail = (fromIndex ? t.slice(fromIndex) : t).slice(-1600);
      if (/ready to submit|submit answers|review your answers/i.test(tail)) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// 唯一用途:从干净正文(appSendBlock 的 answer 文本)尽力补回选项 label,替换 detectChooser 的「选项 i」占位。
// claude 在正文里常用有序列表列出方案;解析不到则保持「选项 i」占位(与 detectChooser 原口径一致,
// 正文本身能看到真实方案)。注意别把正文里其它编号/序号误当选项,只取前 count 条匹配项。
function parseOptionLabels(text, count) {
  const opts = [];
  const re = /^\s*(\d)\s*[.、)]\s*([^\n]+)/gm;
  let m;
  const lines = [];
  while ((m = re.exec(String(text || "")))) {
    const n = parseInt(m[1], 10);
    const label = m[2].trim();
    if (n >= 1 && n <= 9 && label && !/^\~*\^+$/.test(label) && label.length < 80) lines.push({ n, label });
  }
  // 去重并保持编号顺序,取前 count 条作为选项 label
  for (let i = 1; i <= count; i++) {
    const hit = lines.find((x) => x.n === i);
    opts.push({ key: String(i), label: (hit && hit.label) || "选项 " + i });
  }
  return opts;
}

// 处理手机端的「选择」:向选择器注入按键,再等 claude 后续输出。
//   · 单选:sel.index 为第 n 项 → 注入「↓×(n-1) + 回车」选中(单选回车即提交,无确认屏)。
//   · 多选(复选框):sel.indices 为勾选序号数组 → 先逐个「移动 + 回车(切换勾选)」,
//     再按「右箭头 →」进入确认屏,最后「回车」才真正提交(多选是两步确认,见 waitForConfirmScreen)。
// claude 选择器默认高亮第 1 项。
async function handleChoose(msgId, sessionId, sel) {
  sel = sel || {};
  const single = Math.max(1, parseInt(sel.index, 10) || 1);
  const indices = (Array.isArray(sel.indices) ? sel.indices : [])
    .map((i) => Math.max(1, parseInt(i, 10) || 1))
    .filter((n, i, arr) => arr.indexOf(n) === i && n > 0)
    .sort((a, b) => a - b);
  // 选择后 claude 也可能僵死(不返回),同样武装看门狗防队列被占死
  const guard = armExecGuard(sessionId, msgId);
  try {
    const s = sessionOf(sessionId);
    if (!s) return send({ type: "result", msgId, ok: false, error: "会话不存在" });
    if (!pty.isOpen(sessionId)) return send({ type: "result", msgId, ok: false, error: "电脑端会话已关闭，请重新打开" });
    // 先确认当前确在选择器(避免 claude 已自行推进时误发按键)
    const chooser = detectChooser(sessionId);
    if (!chooser) {
      const dbg = (pty.liveTranscript(sessionId, 400000) || "").slice(-200);
      log.log("info", `cloud choose 但未检测到选择器,尾部=${JSON.stringify(dbg)}`);
      return send({ type: "result", msgId, ok: false, error: "选择器已关闭，请直接发消息继续" });
    }
    const isMulti = !!chooser.multiSelect && indices.length > 0;
    if (isMulti && indices.some((n) => n > chooser.options.length)) {
      return send({ type: "result", msgId, ok: false, error: "选项超出范围" });
    }
    log.log("info", `cloud choose ${isMulti ? "多选[" + indices.join(",") + "]" : "第" + single + "项"} (会话 ${sessionId.slice(0, 8)}…)`);
    // 注入按键:注入前先等选择器 TUI 绘制稳定(静默 400ms),
    // 否则 choose 紧跟 exec 时第一个 ↓ 可能被尚未就绪的选择器吞掉(实测过选第2项变第1项)。
    // 按键间隔留足重绘时间,防止连续 ↓ 被合并。
    // 先记下注入前实录长度:选择后只取「注入点之后」的新输出,避开选择器菜单/历史残留混入正文。
    const markLen = (pty.liveTranscript(sessionId, 400000) || "").length;
    await new Promise((r) => setTimeout(r, 400));
    const moveTo = (target, cur) => {
      const delta = target - cur;
      const key = delta > 0 ? "\x1b[B" : "\x1b[A";
      const steps = Math.abs(delta);
      return (async () => {
        for (let i = 0; i < steps; i++) { pty.write(sessionId, key); await new Promise((r) => setTimeout(r, 200)); }
      })();
    };
    if (isMulti) {
      // 多选:起点焦点在第 1 项;对勾选的每项【移动 + 回车(切换勾选)】,回车后焦点停在该项
      let cur = 1;
      for (const n of indices) {
        const d = n - cur;
        if (d !== 0) { await moveTo(n, cur); cur = n; }
        await new Promise((r) => setTimeout(r, 250));
        pty.write(sessionId, "\r"); // Enter 切换当前项勾选([]→[✔])
        await new Promise((r) => setTimeout(r, 250));
      }
      // 提交:勾选完成后按「右箭头 →」(\x1b[C)进入确认屏,再按 Enter 才真正提交。
      // 实测(CLI 2.1.252):多选需走「确认」两步——→ 切到「Ready to submit your answers?」,
      // 光标默认停在高亮的「1. Submit answers」,按 Enter(\r)才提交;确认屏上再按 → 无效。
      // 注意:不能省略 Enter,否则 claude 一直停在确认屏(表现为 PC 端"卡在选择界面")。
      await new Promise((r) => setTimeout(r, 300));
      pty.write(sessionId, "\x1b[C");
      await waitForConfirmScreen(sessionId, 2000, markLen);
      await new Promise((r) => setTimeout(r, 150)); // 确认屏渲染稳定后再回车,防过早被吞
      pty.write(sessionId, "\r");
      log.log("info", `cloud choose 多选已提交(→ + 回车确认,勾选 ${indices.join(",")}),候选 ${chooser.options.length} 项`);
    } else {
      const n = single;
      await moveTo(n, 1);
      await new Promise((r) => setTimeout(r, 200));
      pty.write(sessionId, "\r");
      log.log("info", `cloud choose 第 ${n} 项(会话 ${sessionId.slice(0, 8)}…)`);
    }
    // 选择后 claude 继续处理(可能开始真正动手),等它输出完再回传
    await waitDone(sessionId, "", { quietMs: 25000, maxMs: 8 * 60 * 1000 });
    // 看门狗触发:超时中断,明确告知而不是让手机端一直等
    if (guard.aborted) {
      return send({ type: "result", msgId, ok: false, error: "电脑端长时间未返回，已中断。请重试或重开会话。" });
    }
    const clean = pty.liveTranscript(sessionId, 400000) || "";
    // 选择后的正文:只取「按键注入点之后」的新输出(选择器确认后 claude 的真正回答),
    // 若取整段尾部会把选择器菜单残留/历史回答一起带进来,造成正文重复刷屏。
    const tailAns = filterBodyLines(clean.slice(markLen));
    const out = await formatAnswer(tailAns);
    const nextChooser = detectChooser(sessionId);
    send({ type: "result", msgId, ok: true, text: out, chooser: nextChooser || undefined });
  } finally {
    disarmExecGuard(sessionId);
  }
}

// 轮询实时实录,直到「本次问题已提交、出现了回答正文、且尾部回到空闲提示符」并稳定两次。
// 关键:claude 答长内容(大表格/长代码)会分多段流式输出,段间停顿不代表卡死——
// 所以不能只用「总时长」硬超时。改用「输出活跃度」判定:
//   · raw 字节数还在涨 → 电脑端正在输出/思考 → 持续等待,不计入静默;
//   · raw 字节数连续静默超 quietMs(默认 20s)→ claude 真停了,此时若无正文+idle 才视为超时失败。
// 同时给一个绝对上限 maxMs(默认 6 分钟)兜底,防 claude 死循环刷屏导致永不返回。
function waitDone(sessionId, question, opts = {}) {
  const { quietMs = 20000, maxMs = 6 * 60 * 1000 } = opts;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stable = 0;
    let lastRaw = pty.rawOf(sessionId); // 上次观察到的原始字节数
    let quietSince = Date.now();        // 进入静默(字节数不再涨)的时刻
    const timer = setInterval(() => {
      const now = Date.now();
      // 电脑端仍在输出 → 重置静默计时,继续等(用户的诉求:回答中就等待)
      const raw = pty.rawOf(sessionId);
      if (raw !== lastRaw) { lastRaw = raw; quietSince = now; stable = 0; return; }

      const clean = pty.liveTranscript(sessionId, 400000) || "";
      const start = locateQuestion(clean, question);
      let ok = false;
      if (start >= 0) {
        const tail = clean.slice(start);
        const lines = tail.split("\n");
        // 出现正文:存在非状态/提示的长行(回答至少一句)
        const hasBody = lines.some((l) => {
          const t = l.trim();
          return t.length >= 4 && !/^(❯|✻|✢|✶|✽|✱|·|⎿|Thought|Cogitated|Tip:|esc to|\? for)/.test(t) && !/^[─━=–—•·\s]{4,}$/.test(t);
        });
        // 回到空闲:出现 done 标记,或尾部回到空输入框(最后一个 ❯ 之后无用户文字、直接接 ─ 分隔线)
        let idle = /Cogitated for|Cooked for|Sautéed for|Vibing|done for|Worked for|Churned for/i.test(tail);
        if (!idle) {
          const li = tail.lastIndexOf("❯");
          if (li >= 0) {
            const after = tail.slice(li + 1).replace(/^\s+/, "");
            idle = /^[─━]/.test(after) || after === "" || /^⏵/.test(after);
          }
        }
        // 停在原生选择器(↑/↓ to navigate)也算「答完」——选择器是 claude 输出完毕、等用户选择的静止态,
        // 此时 ❯ 在高亮选项上(❯1.xxx)不满足空输入框特征,若不认会误等满 quietMs 报「没等到回答」。
        // 但必须确认锚点激活在终端底部(chooserActiveAt),否则旧选择器残留会误判 claude 正常回答中的停顿。
        if (!idle && chooserActiveAt(tail) >= 0) idle = true;
        if (hasBody && idle) ok = true;
      }
      if (ok) { stable++; if (stable >= 2) { clearInterval(timer); return resolve(true); } }
      else stable = 0;
      // 看门狗触发(执行超时/用户 stop):提前返回,释放串行队列,避免继续空等
      const guard = execGuards.get(sessionId);
      if (guard && guard.aborted) { clearInterval(timer); return resolve(false); }
      // 静默超 quietMs 仍无正文+idle → claude 真停了,超时返回;或撞绝对上限 maxMs 兜底
      if (now - quietSince > quietMs || now - t0 > maxMs) { clearInterval(timer); resolve(false); }
    }, 400);
  });
}

// 定位「最后一条 ❯ 用户问题」在干净实录里的正文起点(返回原串下标,未命中返回 -1)。
// TUI 会把长问题在终端宽度处折行(中间插入换行/空格),"❯ 完整问题"整串匹配必然失败。
// 故在【去掉所有空白】的副本上定位,再按压缩前后下标映射回原串取切片。
function locateQuestion(clean, question) {
  const q = String(question || "").trim();
  if (!q) return -1;
  const qline = "❯" + q.replace(/\s+/g, ""); // 压缩后的问题提示行
  // 逐段扫描:对每个 "❯" 之后到行尾的内容去空白,与压缩问题比对,取最后一次命中
  let hit = -1;
  let pos = 0;
  while (true) {
    const i = clean.indexOf("❯", pos);
    if (i < 0) break;
    // 该 ❯ 之后取到足够覆盖折行问题的窗口(问题长 + 若干折行换行),去空白比对
    const win = clean.slice(i, i + q.length + 8);
    if (win.replace(/\s+/g, "").startsWith(qline)) hit = i;
    pos = i + 1;
  }
  if (hit < 0) return -1;
  // 从该 ❯ 起,数过 qline.length 个非空白字符,落点即正文起点
  let need = qline.length;
  let j = hit;
  for (; j < clean.length && need > 0; j++) {
    if (!/\s/.test(clean[j])) need--;
  }
  // 跳过紧随的换行,正文从下一非空白处开始(若无正文,指到串尾)
  while (j < clean.length && (clean[j] === "\n" || clean[j] === "\r" || clean[j] === " " || clean[j] === "\t")) j++;
  return j;
}

// 从干净实录提取「最后一条 ❯ 用户问题」之后的正文(复用 filterBodyLines 滤状态/动画/残片)
function extractAnswer(sessionId, question) {
  // 实时实录优先(含刚答完的本次问答,不受 6s 落盘节流影响);磁盘 transcript 仅兜底
  const s = persistence.getSession(sessionId);
  const clean = pty.liveTranscript(sessionId, 400000) || (s && s.transcript) || "";
  if (!clean) return "";
  const start = locateQuestion(clean, question);
  return start >= 0 ? filterBodyLines(clean.slice(start)) : filterBodyLines(clean);
}

// 相邻重复行去重:实时滚动实录里 TUI 重绘会让同一段话重复多次(如"当前会话运行在 Linux…"
// 出现 N 次),只保留相邻相同的最后一条,消除刷屏。
function dedupLines(arr) {
  const out = [];
  for (const l of arr) {
    if (out.length && l === out[out.length - 1]) continue;
    out.push(l);
  }
  return out;
}

// box-drawing 表格 → markdown 表格:claude 输出 markdown 表格被 TUI 渲染成 │ 框线表格,
// 剥 ANSI 后以 │ 分隔但 marked 无法渲染,只好还原成 | a | b | 让 marked 输出真正表格。
// 注意 TUI 会在每两行数据之间画一条 ├─┼─┤ 边框(而非仅表头下一行),故需把「数据行 +
// 其间边框行」聚合为一个连续表格块:边框行只跳过不输出;数据行并入同一张表,首行作表头。
function tablesToMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = [];
  let i = 0;
  // 数据/表头行:含 │ 且不是纯 box 边框行(纯边框行如 ├──┼──┤ 只有边框字符)
  const isDataRow = (s) => /[│]/.test(s) && !/^[│├└┌─┬┴┼┐┘┤┃]+$/.test(s.trim());
  // 边框/表框行:纯 box-drawing 字符(含顶框 ┌─┬─┐ 与底框 └─┴─┘)
  const isBorderLine = (s) => /^[│├└┌─┬┴┼┐┘┤┃]+$/.test(s.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (isDataRow(l) || isBorderLine(l)) {
      const rows = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (isDataRow(cur)) {
          const cell = cur.trim().replace(/^[│\s]+/, "").replace(/[│\s]+$/, "").split(/[│]/).map((c) => c.trim().replace(/\s+/g, " "));
          rows.push(cell);
        } else if (!isBorderLine(cur)) {
          break; // 遇到非表格行(正文/空行),结束本块
        }
        i++;
      }
      if (rows.length) {
        out.push("| " + rows[0].join(" | ") + " |");
        out.push("|" + rows[0].map(() => " --- ").join("|") + "|");
        for (let r = 1; r < rows.length; r++) out.push("| " + rows[r].join(" | ") + " |");
        out.push("");
        continue;
      }
    }
    out.push(l);
    i++;
  }
  return out.join("\n");
}

// 树形行空格规范化:TUI 剥 ANSI 后 box-drawing 行的空格会丢失(如 "├──build/#" 实际是
// "├── build/  #"),导致 md 渲染挤成一段、# 注释看不出来。这里只补空格、绝不改内容顺序,
// 恢复树形的可读性。仅在以树形字符开头(│/├/└/┌)的行上生效。
function fixTreeLines(src) {
  return String(src || "").split("\n").map((l) => {
    if (!/^[│├└┌]/.test(l)) return l;
    let s = l;
    // TUI 重绘会往 ── 连线中间混入空格(如 "├─ ─ dist/"),把连线字符间的空格合并,
    // 但不影响 ── 之后与文件名的正常分隔空格
    s = s.replace(/(─\s*─)+/g, (m) => "─".repeat((m.match(/─/g) || []).length));
    // ── 后若空格被 TUI 吃掉直接贴文件名(如 "├──build/"),补一个空格;
    // 用 [^\s─━│├└┌] 断言后面是真正的文件内容(非空白、也非另一个连线字符),
    // 避免把 "├── dist/" 里的第二个 ─ 误当成文件内容
    s = s.replace(/^([│├└┌]+\s*)([─━]+)(?=[^\s─━│├└┌])/, (_, a, b) => a + b + " ");
    s = s.replace(/#(?=\S)/g, "# ");
    s = s.replace(/(\S)#/g, "$1 #");
    return s;
  }).join("\n");
}

// 从实录文本滤出对话正文行:丢弃 TUI 状态/提示/动画/装饰残留与 REPL 残片,保留正文与空行分隔
function filterBodyLines(src) {
  const out = [];
  let pendingBlank = 0;
  // 先把 box-drawing 表格还原成 markdown 表格,再逐行过滤(否则 │ 表格行会被当作残片滤掉或挤成乱码)
  src = tablesToMarkdown(src);
  for (const raw of String(src || "").split("\n")) {
    const line = raw.replace(/[ \t]+$/g, "");
    // 剥掉控制字符前缀(如转义残留 )再判定,否则头部符号/状态词都匹配不上
    const t = line.trim().replace(/^[\x00-\x1f\x7f]+/, "").trim();
    if (!t) { pendingBlank++; continue; }
    // 状态/提示/动画行(头符号,或已知状态词,中英统一)
    if (/^[❯✻✢✶✽✱⏸◉·⎿;※]/.test(t)) { pendingBlank = 0; continue; }
    // 状态词行允许 * ✳ ◎ 等装饰前缀(如 "*Cogitating…4"),剥前缀再判
    const decoPref = t.replace(/^[*✳◎·]+/, "");
    if (/^(Thought|Cogitat|Ponder|Philosophis|Combobulat|Decipher|Working|Thinking|Crunched|Brewed|Fiddle|Recap)/i.test(decoPref)) { pendingBlank = 0; continue; }
    // 思考计时行 "Thought 3s":剥 ANSI 后 h 后空格丢失,甚至拼成 "Tought3s",故宽松匹配
    // "Tought/Thought"+数字+"s"(可在词前有 * ✳ 等装饰前缀)。只滤这些短残片,不影响正文。
    if (/(?:Tought|Thought)[\s]?\d+\s*s\b/i.test(t) && !/[一-龥]/.test(t) && t.length <= 16) { pendingBlank = 0; continue; }
    if (/^(Tip:|esc to|\? for|Hit |←|disable recaps)/i.test(t)) { pendingBlank = 0; continue; }
    // Claude Code 启动提示「创建技能」的续行(常因窄终端丢空格成残片)
    if (/^for\s*skills\s*that\s*work\s*in\s*any\s*project/i.test(t)) { pendingBlank = 0; continue; }
    // 思考过程残留与状态栏(deepseek 推理输出 + TUI 折叠态)
    // 含 thinking 词但无实质正文(无中文字符)的动画残片
    if (/thinking/i.test(t) && !/[一-龥]/.test(t)) { pendingBlank = 0; continue; }
    // 状态栏特征:计时 / 令牌计数 / 折叠提示 / 进行中分隔符
    if (/·\s*(thinking|thought for|done|↓)|tokens\b|ctrl\+o|\(\d+s?\s*·|\bthought for\b/i.test(t)) { pendingBlank = 0; continue; }
    // 无前缀 spinner 状态词(如 Twisting…),省略号结尾、无中文、较短
    if (/…$/.test(t) && !/[一-龥]/.test(t) && t.length <= 40) { pendingBlank = 0; continue; }
    // spinner 进度帧:英文词 + … + 数字(如 Drizzling…50 / Twisting…1234),TUI 动画残留,无中文、较短
    if (/…\s*\d+\s*$/.test(t) && !/[一-龥]/.test(t) && t.length <= 40) { pendingBlank = 0; continue; }
    // 星号/装饰前缀 + 纯数字,或 *词…数字(*400 / *Drizzling…5) —— 动画 spinner 的另一种形态
    if (/^[*✳◎·]+/.test(t)) {
      const sp = t.replace(/^[*✳◎·]+/, "");
      if (/^\d+\s*$/.test(sp) || (/…\s*\d*\s*$/.test(sp) && !/[一-龥]/.test(sp) && sp.length <= 40)) { pendingBlank = 0; continue; }
    }
    // 工具注解残片:单独文件名/路径行(无动词、无中文、以代码/文本扩展名结尾),如 scene_mnager.py。
    // 排除树形前缀(├/└/│)以免误删目录树叶子行。
    if (!/^(?:├|└|│)/.test(t) && !/[一-龥]/.test(t) && /^(?:[\w.\-/]*[\w])\.(?:py|js|ts|mjs|cjs|json|md|txt|cpp|c|h|hpp|css|scss|html|vue|svelte|svg|sh|bash|ya?ml|toml|ini)$/i.test(t)) { pendingBlank = 0; continue; }
    // 单独 ● / - 残片(折叠展开残留与 markdown 列表分隔)
    if (/^[●]\s*$/.test(t) || /^[-–—]\s*$/.test(t)) { pendingBlank = 0; continue; }
    // 工具注解帧(动词 + 单文件名/路径;TUI 帧里空格常丢失,如 "Showingpackage.json")。
    // 剥掉头部 spinner/装饰前缀(* ✳ 等)再判,否则 "* Listingprojectroot…" 这种带星号的
    // 动作帧会漏掉——星号只是动画前缀,动词后仍是「空格丢失的工具名」。
    const toolAnno = t.replace(/^[*✳◎·+\s]+/, "");
    if (/^(Showing|Reviewing|Running|Reading|Writing|Editing|Wrote|Searched|Saving|Saved|Browsing|Calling|Listing|Scanning|Inspecting|Examining)[A-Za-z0-9._\-/ ]{2,80}$/i.test(toolAnno)) { pendingBlank = 0; continue; }
    // TUI 顶栏/阴影块残留(如 "▝▝ ▝▝  工作目录")
    if (/[▝▘▖▗░▒▓▛▜▌▐]{2,}/.test(t)) { pendingBlank = 0; continue; }
    // 程序横条变体:残片前缀 + ; + ◐/◑/✳ Claude Code(如 "r;◑ Claude Code")
    if (/(?:✳|◐|◑)\s*Claude Code/.test(t.replace(/^[\x00-\x1f;A-Za-z@]{0,3}/, ""))) { pendingBlank = 0; continue; }
    // 状态栏帧:首部残片后跟 ;◐/;◑ / ;✳ + 当前动作描述(如 "Tinkering…6;◐ 工程顶层目录结构"),
    // TUI 实时刷新「正在做什么」这行,剥 ANSI 后成残片,非对话正文
    if (/;[◐◑✳]/u.test(t.replace(/^[\x00-\x1f;A-Za-z@]{0,8}/, ""))) { pendingBlank = 0; continue; }
    // TUI 状态栏帧:直接含 ;◐/;◑/;✳/;◒ 必为动画残片(剥前缀会漏掉 f;✳ 这种,不剥前缀直接判)
    if (/;[◐◑✳◒]/u.test(t)) { pendingBlank = 0; continue; }
    // 纯 box-drawing 边框行(如 ├┼┼┤ / └┴┴┘ / ┌─┬─┐):无文字内容,直接滤掉
    if (/^[│├└┌─┬┴┼┐┘┤┃]+$/.test(t)) continue;
    // 表格行(竖线 ≥2 且非树形引导,如 │会话名称│ID│):TUI 渲染的 markdown 表格,空格丢失难还原,滤掉
    if (!/^[│\s]*[├└┌]/.test(t) && !/^│\s/.test(t) && (t.match(/[│]/g) || []).length >= 2) { pendingBlank = 0; continue; }
    // 思考状态标题行:*…;✳ 步骤名 / *Concocting…
    if (/^[*✳◎·]/.test(t)) {
      const sp = t.replace(/^[*✳◎·]+/, "");
      if (sp.includes(";✳") || (sp.length <= 32 && /…$/.test(sp) && !/[一-龥，。：]/.test(sp))) { pendingBlank = 0; continue; }
    }
    if (/^[─━=–—•·\s]{4,}$/.test(t)) continue;
    // 纯字母数字短残片(重绘动画剥 ANSI 后的碎片,如 *n / en / 20 / i…)
    if (/^[;*✳…A-Za-z0-9]{1,3}$/.test(t)) { pendingBlank = 0; continue; }
    const deco = (t.match(/[─━│┃✻✢✽✱◉⏸]|^●|^✳/g) || []).length;
    if (deco > Math.max(3, t.length * 0.4)) continue;
    if (pendingBlank) { out.push(""); pendingBlank = 0; }
    out.push(line.replace(/\u0007/g, "").replace(/^;/, "").replace(/^●\s?/, "").replace(/\uFFFD/g, ""));
  }
  // 相邻重复行去重:实时滚动实录里同一段话会因屏幕重绘重复多次,只留一条(保留空行分隔)。
  // 再做中英文边界补空格:剥 ANSI 会丢中英文间空格(如"Web平台"/"FlaskWeb框架"/"ClaudeCode"),恢复可读性。
  const joined = fixTreeLines(dedupLines(out).join("\n").replace(/\n{3,}/g, "\n\n").trim());
  return joined.replace(/([A-Za-z0-9])([一-鿿])/g, "$1 $2").replace(/([一-鿿])([A-Za-z0-9])/g, "$1 $2");
}

// ---- 方案A:模型还原(把被 TUI 重绘破坏的转录烤回干净 markdown) ----
// 手机端必须与桌面终端「两边效果一模一样」,故回答仍取 TUI 转录(与桌面同步);
// 但表格/代码被 TUI 的 ANSI 重绘拆散、单元格折行截断,信息丢失前端规则无法找回。
// 因此在回传前,把含表格/残片的文本交给【headless claude】做一次结构还原——
// headless(-p + stream-json)拿到的 assistant 正文是未经 TUI 渲染的原始 markdown,能修好表格。
// 用一点 token 和时间,换手机端表格/代码/列表完整可控。
function claudeFormat(prompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // 剔除传染变量:headless 子进程若继承桌面 TUI 会话上下文会报 "Transcript saving is off"
    for (const k of ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_WS_PORT"]) delete env[k];
    const ch = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    ch.stdout.on("data", (d) => (out += d.toString()));
    const done = () => {
      if (settled) return;
      settled = true;
      let text = "";
      for (const l of out.split("\n")) {
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        if (o.type === "assistant" && Array.isArray(o.message?.content)) {
          for (const c of o.message.content) if (c.type === "text") text += c.text;
        }
      }
      resolve(text.trim());
    };
    ch.on("close", done);
    ch.on("error", done);
    setTimeout(() => { try { ch.kill(); } catch {} done(); }, timeoutMs);
    ch.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    // 发 EOF 让 claude 处理完本轮即退出:headless(--input-format stream-json)会持续读
    // stdin,不发 EOF 就不退出,导致只能等 timeout;end 后 close 立即触发,快速返回。
    ch.stdin.end();
  });
}

// 是否需要模型修复:回答含 markdown 表格 / box-drawing 残留 / 终端状态残片之一即需修复。
// 纯文本回答 TUI 不会重绘破坏,直接透传省 token(用户接受为换清晰度而多点 token,
// 这里只在真正损坏时才花)。
function looksDamaged(text) {
  const s = String(text || "");
  let pipeRows = 0;
  for (const l of s.split("\n")) if (/^\s*\|.*\|\s*$/.test(l)) pipeRows++;
  if (pipeRows >= 2) return true;                 // markdown 表格(无论好坏,统一交给模型烤)
  if (/[│┌└├┬┴┼┐┘┤─━]/.test(s)) return true;     // box-drawing 残留(表格/代码框被剥坏)
  if (/^[❯✻✢✶✽✱⏸;◐◑✳◒]/m.test(s)) return true;   // 终端状态/动画残片
  // 代码空格粘连:claude 输出的代码块在 TUI 转录里空格丢失(def quick_sort → defquick_sort、
  // return arr → returnarr、x for x in → xforxin),剥 ANSI 后围栏(```)也没了,marked 无法识别成代码块。
  // 有 ≥2 行「代码关键字后紧跟字母/下划线(无空格)」即判为受损代码,交模型还原空格与围栏。
  let codeGlue = 0;
  for (const l of s.split("\n")) {
    const t = l.trim();
    if (/(?:^|[\s;])(?:def|if|for|while|import|return|class|const|let|var|function|print|elif|else|try|except|with|lambda|self)[A-Za-z_$]/.test(t)) codeGlue++;
  }
  if (codeGlue >= 2) return true;
  return false;
}

async function formatAnswer(text) {
  const src = String(text || "");
  if (!src.trim() || !looksDamaged(src)) return src;
  try {
    const prompt = `下面是一段 Claude Code 桌面终端转录的回答,被 TUI 的 ANSI 重绘破坏:markdown 表格被渲染成 box-drawing 框线(│ ─ ┼)后又被剥掉空格,单元格被折行截断、内容散落,代码块的空格/缩进/换行与围栏(\`\`\`)也丢了,列表同样混入了终端残片。请还原为标准的 markdown:
1. 删除终端状态/动画残片行(❯ ✻ ✢ ;◐ ;✳ spinner 动词 计时 等);
2. 把拆散、截断的表格单元格按内容拼回,合成一张标准的 markdown 表格(表头 + 分隔行 + 数据行);
3. 代码块请用 \`\`\` 围栏包裹并标注语言(如 python/js),补回丢失的空格、缩进与换行;
4. 保留/还原有序列表的序号与目录树的层级结构;
5. 只输出还原后的正文,不要解释;不要给整段回答额外套一层 \`\`\` 围栏(各代码块各自包裹即可)。

转录内容:
${src}`;
    const clean = await claudeFormat(prompt);
    return clean || src;
  } catch {
    return src;
  }
}
// 回传文本清理:剥 BEL/回车残留,再做桌面 transcript 同款 TUI 行清洗(滤横幅/状态栏/分隔线/装饰行),
// 只留对话正文 — 与桌面所见的干净实录一致,避免手机端看到 TUI 界面帧乱码
function cleanAnswer(raw, input) {
  let t = String(raw || "").replace(/\u0007/g, "").replace(/\r\n?/g, "\n");
  t = cleanTranscript(t);
  const lines = t.split("\n");
  if (lines.length > 1 && lines[0].replace(/\s+/g, " ").trim() === String(input || "").replace(/\s+/g, " ").trim()) lines.shift();
  return lines.join("\n").replace(/\s+$/g, "").trim();
}
function handleStop(msgId, sessionId) {
  // 中断正在进行的生成 —— 用 Esc(claude TUI 打断当前回答的键,实测 Ctrl+C 是「按两次退出」,不打断),
  // 终端若存在才写。Esc 在空闲态无副作用,不会误关会话。
  const done = pty.write(sessionId, "\x1b");
  // 同时触发看门狗中止:让卡在 waitDone 的 exec 提前返回、释放串行队列(否则用户点了停止,
  // 队列仍被占着,后续消息进不来)。aborted 由 handleExec/handleChoose 的 finally 统一 disarm。
  const g = execGuards.get(sessionId);
  if (g) g.aborted = true;
  send({ type: "answer", msgId, ok: true, interrupted: done });
}

// 手机端新建会话:在本机开一个全新 claude 终端窗口。title 供列表显示,必填 cwd。
// 复用 persistence.createSession + pty.open,与会话列表/执行完全一致,桌面端同步出现该会话。
async function handleNewSession(msgId, opts = {}) {
  const title = String(opts.title || "").trim();
  const cwd = String(opts.cwd || "").trim() || undefined;
  if (!title) return send({ type: "answer", msgId, ok: false, error: "请填会话名称" });
  const s = persistence.createSession({ title, cwd, argText: opts.argText, skipPermissions: !!opts.skipPermissions });
  // 立即拉起终端,让桌面与手机同步「会话已开」;失败也保留会话记录(后续可重试打开)
  const r = pty.open(s.id, { cwd: s.cwd, argText: s.argText, skipPermissions: s.skipPermissions });
  if (r && r.fresh) freshOpens.set(s.id, Date.now());
  send({ type: "session-created", msgId, ok: true, session: { id: s.id, title: s.title, cwd: s.cwd, running: r && r.ok !== false } });
  log.log("info", `cloud new-session → ${s.title}(${s.id.slice(0, 8)}…)`);
}

// 手机端关闭会话:结束终端并删除该会话记录。手机/桌面都不再显示,终端的 claude 进程一并结束。
function handleCloseSession(msgId, sessionId) {
  const s = persistence.getSession(sessionId);
  if (!s) return send({ type: "answer", msgId, ok: false, error: "会话不存在" });
  pty.close(sessionId);           // 结束终端(若在运行)
  persistence.deleteSession(sessionId);
  send({ type: "answer", msgId, ok: true, sessionId });
  log.log("info", `cloud close-session → ${sessionId.slice(0, 8)}…`);
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
  if (m.type === "choose") return enqueue(() => handleChoose(m.msgId, m.sessionId, { index: m.index, indices: m.indices }));
  // stop 不排队:立即执行,以便用户能打断卡死的 exec(否则 stop 排在僵死 exec 后面永远轮不到)
  if (m.type === "stop") return handleStop(m.msgId, m.sessionId);
  if (m.type === "new-session") return enqueue(() => handleNewSession(m.msgId, m));
  if (m.type === "close-session") return enqueue(() => handleCloseSession(m.msgId, m.sessionId));
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
  onChooser(fn) {
    chooserFn = fn;
  },
  onCloudMessage(fn) {
    cloudMsgFn = fn;
  },
  applyConfig,
  start,
  stop,
  status,
  // 上行把会话元信息/对话消息落库到服务器(server.cjs 的 node:sqlite)。
  // 复用 send(),断线时静默跳过;重连后的全量对账由 main.cjs 在 online 时触发补传。
  uploadSession(s) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !deviceId || !s || !s.id) return;
    send({
      type: "db-session",
      deviceId,
      session: {
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      },
    });
  },
  uploadMessage(sessionId, seq, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !deviceId || !sessionId) return;
    send({ type: "db-message", deviceId, sessionId, seq, message });
  },
  isOnline() {
    return !!(ws && ws.readyState === WebSocket.OPEN);
  },
};
