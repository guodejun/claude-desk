// 会话列表状态(元信息,不含 messages)
import { chat, forget } from "./chat.svelte.js";

export const list = $state({ items: [], loaded: false });

export async function refreshList() {
  list.items = (await window.claude.sessionList()) || [];
  list.loaded = true;
  // 列表 running 状态与 chat 总线同步(供实时刷新用)
  return list.items;
}

export async function createSession(meta) {
  const s = await window.claude.sessionCreate(meta);
  await refreshList();
  return s;
}

export async function updateSession(id, patch) {
  const s = await window.claude.sessionUpdate(id, patch);
  await refreshList();
  return s;
}

export async function removeSession(id) {
  await window.claude.sessionDelete(id);
  forget(id);
  await refreshList();
  return true;
}

// 会话创建/删除后由主进程事件更新 running/updatedAt 的轻量刷新入口
export async function touch() {
  await refreshList();
}
