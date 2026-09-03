// 全局消息总线:所有会话的实时状态与消息(与页面无关,切回即更新)
// entries[id] = { messages:[], busy, jobKey, loaded }
// messages 结构与主进程落盘一致:
//   { role:'user', text }
//   { role:'assistant', blocks:[{type:'text'|'thinking'|'tool'|'tool-result'|'error',...}] }
//   { role:'ui', blocks:[{type:'error',text}] }
// tool-result 独立成块(不合并进 tool 卡),渲染端画在对应工具卡下方;已落盘结构一致,天然无漂移。

export const chat = $state({ entries: {} });

let inited = false;

// 幂等初始化;由 +layout.svelte onMount 调用一次
export function initBus() {
  if (inited || typeof window === "undefined" || !window.claude) return;
  inited = true;
  window.claude.onSession((ev) => dispatch(ev));
}

function entry(id) {
  if (!chat.entries[id]) {
    chat.entries[id] = { messages: [], busy: false, jobKey: 0, loaded: false };
  }
  return chat.entries[id];
}

function dispatch(ev) {
  const e = entry(ev.id);
  if (ev.type === "start") {
    e.jobKey = ev.jobKey;
    e.busy = true;
  } else if (ev.type === "user-message") {
    e.messages = [...e.messages, { role: "user", text: ev.text, ts: Date.now() }];
  } else if (ev.type === "stream") {
    // 流式块聚合:同一 assistant 消息(相同 messageId)追加进同一条;
    // tool-result 例外:即使 messageId 不同,也并入上一条「刚结束工具调用」的消息(工具卡下方)
    const msgs = [...e.messages];
    const last = msgs[msgs.length - 1];
    const lastBlock = last && last.role === "assistant" ? last.blocks[last.blocks.length - 1] : null;
    const followTool =
      ev.block.type === "tool-result" && !!lastBlock && (lastBlock.type === "tool" || lastBlock.type === "tool-result");
    if (last && last.role === "assistant" && (followTool || !ev.messageId || last.messageId === ev.messageId)) {
      last.blocks = [...(last.blocks || []), ev.block];
    } else {
      msgs.push({ role: "assistant", blocks: [ev.block], messageId: ev.messageId });
    }
    e.messages = msgs;
  } else if (ev.type === "done") {
    e.busy = false;
    e.jobKey = 0;
  } else if (ev.type === "error") {
    // 系统级错误(工作目录不存在/启动失败/异常退出):上屏并把当前 job 结束
    e.messages = [...e.messages, { role: "ui", blocks: [{ type: "error", text: ev.message }], ts: Date.now() }];
    e.busy = false;
    e.jobKey = 0;
  }
}

// 进入会话页时调用;已加载过则直接返回(避免覆盖流式中的增量)
export function openSession(id) {
  entry(id);
  const e = chat.entries[id];
  if (!e.loaded) {
    return window.claude.sessionGet(id).then((s) => {
      e.messages = (s && s.messages) || [];
      e.loaded = true;
      return e;
    });
  }
  return Promise.resolve(e);
}

// 强制重新载入(压缩上下文等改动消息后用于刷新显示)
export function reloadSession(id) {
  const e = entry(id);
  return window.claude.sessionGet(id).then((s) => {
    e.messages = (s && s.messages) || [];
    e.loaded = true;
    e.busy = false;
    e.jobKey = 0;
    return e;
  });
}

// 发送消息:push 不做本地乐观更新,统一等主进程 user-message / stream 事件回流,
// 保证渲染端与落盘结构完全一致
export async function send(id, text) {
  const e = entry(id);
  if (e.busy) return { error: "该会话正在运行,请先停止" };
  const res = await window.claude.sessionSend(id, text);
  if (res && res.error) {
    e.messages = [...e.messages, { role: "ui", blocks: [{ type: "error", text: res.error }], ts: Date.now() }];
  }
  return res;
}

export function stop(id) {
  return window.claude.sessionStop(id);
}

export function forget(id) {
  delete chat.entries[id];
}
