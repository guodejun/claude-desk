// 已打开会话的标签页(顶部 tab 栏),localStorage 持久化,重启可恢复
const LS_KEY = "cd-tabs";

export const tabs = $state({ items: [] }); // [{id, title}]

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tabs.items));
  } catch {}
}

export function initTabs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) tabs.items = arr;
    }
  } catch {
    tabs.items = [];
  }
}

// 打开(若已在列表则仅更新标题)
export function openTab(id, title) {
  const hit = tabs.items.find((t) => t.id === id);
  if (hit) {
    if (title && hit.title !== title) {
      hit.title = title;
      persist();
    }
    return;
  }
  tabs.items = [...tabs.items, { id, title: title || "未命名会话" }];
  if (tabs.items.length > 10) tabs.items = tabs.items.slice(-10);
  persist();
}

export function updateTabTitle(id, title) {
  const t = tabs.items.find((x) => x.id === id);
  if (t && t.title !== title) {
    t.title = title;
    persist();
  }
}

export function closeTab(id) {
  tabs.items = tabs.items.filter((t) => t.id !== id);
  persist();
}
