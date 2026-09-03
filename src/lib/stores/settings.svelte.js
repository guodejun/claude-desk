// 应用设置与 Claude 配置文件列表
export const appSettings = $state({ claudePath: "", terminalFontSize: 13, closeAction: "exit", configFiles: [], loaded: false });
// 命名配置模板(存应用 userData)
export const templates = $state({ items: [], loaded: false });

export async function loadSettings() {
  const s = (await window.claude.settingsGet()) || {};
  appSettings.claudePath = s.claudePath || "";
  appSettings.terminalFontSize = Number(s.terminalFontSize) || 13;
  appSettings.closeAction = s.closeAction === "tray" ? "tray" : "exit"; // 关闭按钮:exit 退出 / tray 缩托盘
  appSettings.configFiles = (await window.claude.configList()) || [];
  templates.items = (await window.claude.configTemplateList()) || [];
  templates.loaded = true;
  appSettings.loaded = true;
}

export async function saveSettings() {
  return window.claude.settingsSet({
    claudePath: appSettings.claudePath,
    terminalFontSize: appSettings.terminalFontSize,
    closeAction: appSettings.closeAction,
  });
}

export async function refreshConfigFiles() {
  appSettings.configFiles = (await window.claude.configList()) || [];
}

export async function refreshTemplates() {
  templates.items = (await window.claude.configTemplateList()) || [];
  templates.loaded = true;
  return templates.items;
}

export async function getTemplate(id) {
  return window.claude.configTemplateGet(id);
}

export async function saveTemplate(input) {
  const r = await window.claude.configTemplateSave(input);
  if (r && r.ok) await refreshTemplates();
  return r;
}

export async function deleteTemplate(id) {
  const r = await window.claude.configTemplateDelete(id);
  if (r) await refreshTemplates();
  return r;
}

export async function applyTemplate(id) {
  return window.claude.configTemplateApply(id);
}

export async function testClaudePath(override) {
  return window.claude.claudeVersion(override && override.trim ? override.trim() : "");
}

export async function updateClaude() {
  return window.claude.claudeUpdate();
}

// 查询实际使用的 claude 二进制路径 + 版本(设置页动态显示用)
export async function resolveClaude() {
  return window.claude.claudeResolve();
}

export async function deleteConfigFile(name) {
  const r = await window.claude.configDelete(name);
  await refreshConfigFiles();
  return r;
}
