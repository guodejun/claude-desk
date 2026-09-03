// 对话队列引擎:工具面板「☰ 队列」的自动接力后台。
// per-session:队列存会话文件(session.tunnel),执行状态驻内存(与应用同生命周期)。
// 跑一轮即停:start 后从队首依次发出,每条经 pty.interact 等 claude「答完(输出停滞)」再发下一条,
// 发完最后一条自动停止;run 中可暂停(不再续发),修改队列需先暂停。终端退出即自动停止。
const pty = require("./pty.cjs");
const persistence = require("./persistence.cjs");

const states = new Map(); // sessionId -> { items, running, cancelled }
let emitFn = () => {};

function setEmit(fn) {
  emitFn = fn;
}

// 条目规整:去空、补 id、统一状态缺省为待发
function normalize(items) {
  return (Array.isArray(items) ? items : [])
    .map((it, i) => ({
      id: (it && it.id) || `${Date.now().toString(36)}-${i}`,
      text: String((it && it.text) || "").trim(),
      status: (it && it.status) || "pending",
    }))
    .filter((it) => it.text);
}

function load(id) {
  if (states.has(id)) return states.get(id);
  const t = (persistence.getSession(id) || {}).tunnel;
  const st = { items: normalize(t && t.items), running: false, cancelled: false };
  states.set(id, st);
  return st;
}

function persistTunnel(id, st) {
  const s = persistence.getSession(id);
  if (!s) return;
  s.tunnel = { items: st.items };
  persistence.updateSession(id, {});
}

function stateOf(id) {
  return { running: !!load(id).running, cancelled: !!load(id).cancelled, items: load(id).items.map((x) => ({ ...x })) };
}

function emitTunnel(id) {
  emitFn({ type: "tunnel", id, state: stateOf(id) });
}

// 保存/重建队列;运行中禁止改(保持引擎指针简单),须先暂停
function save(id, items) {
  const st = load(id);
  if (st.running) return { error: "队列正在执行，请先暂停再修改" };
  st.items = normalize(items).map((it) => ({ ...it, status: "pending" }));
  st.running = false;
  st.cancelled = false;
  persistTunnel(id, st);
  emitTunnel(id);
  return stateOf(id);
}

// 暂停:不再自动续发下一条(当前交互中的那条等完即可停止),再 start 会从头重跑
function pause(id) {
  const st = load(id);
  if (!st.running) return stateOf(id);
  st.cancelled = true;
  st.running = false;
  st.items.forEach((it) => { if (it.status !== "done") it.status = "pending"; });
  persistTunnel(id, st);
  emitTunnel(id);
  return stateOf(id);
}

// 停止(终端退出联动 / 手动):清运行态,未完成条目回到待发
function stop(id) {
  const st = load(id);
  st.cancelled = true;
  st.running = false;
  st.items.forEach((it) => { if (it.status !== "done") it.status = "pending"; });
  persistTunnel(id, st);
  emitTunnel(id);
  return stateOf(id);
}

// 开始:从队首依次接力,答完一条发下一条,一轮跑完即停
function start(id) {
  const st = load(id);
  if (st.running) return stateOf(id);
  if (!st.items.length) return { error: "队列为空，先添加对话再开始" };
  st.running = true;
  st.cancelled = false;
  st.items.forEach((it) => { it.status = "pending"; });
  emitTunnel(id);
  runNext(id, 0);
  return stateOf(id);
}

async function runNext(id, idx) {
  const st = load(id);
  if (!st.running || st.cancelled) return;
  if (idx >= st.items.length) {
    st.running = false; // 一轮跑完
    persistTunnel(id, st);
    emitTunnel(id);
    return;
  }
  const it = st.items[idx];
  it.status = "active";
  persistTunnel(id, st);
  emitTunnel(id);

  // 等 claude 答完(pty 输出停滞判定);期间被暂停/停止/终端退出都能被下面的检查拦下
  const r = await pty.interact(id, it.text + "\r");

  const cur = states.get(id);
  if (cur !== st || !st.running || st.cancelled) return;
  if (r && r.error) {
    it.status = "pending";
    st.running = false;
    persistTunnel(id, st);
    emitTunnel(id);
    return;
  }
  it.status = "done";
  persistTunnel(id, st);
  emitTunnel(id);
  runNext(id, idx + 1);
}

module.exports = { setEmit, save, start, pause, stop, stateOf, emitTunnel };
