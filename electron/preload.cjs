// 预加载脚本:把主进程能力安全地暴露给渲染进程(上下文隔离下)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claude", {
  // 会话 CRUD
  sessionCreate: (meta) => ipcRenderer.invoke("session-create", meta),
  sessionList: () => ipcRenderer.invoke("session-list"),
  sessionGet: (id) => ipcRenderer.invoke("session-get", id),
  sessionUpdate: (id, patch) => ipcRenderer.invoke("session-update", id, patch),
  sessionDelete: (id) => ipcRenderer.invoke("session-delete", id),
  // 对话
  sessionSend: (id, text) => ipcRenderer.invoke("session-send", id, text),
  sessionStop: (id) => ipcRenderer.invoke("session-stop", id),
  aiSummary: (id, force) => ipcRenderer.invoke("ai-summary", id, force),
  sessionCompact: (id) => ipcRenderer.invoke("session-compact", id),
  // 设置 / 配置文件
  settingsGet: () => ipcRenderer.invoke("settings-get"),
  settingsSet: (patch) => ipcRenderer.invoke("settings-set", patch),
  configList: () => ipcRenderer.invoke("configs-list"),
  configRead: (name) => ipcRenderer.invoke("config-read", name),
  configWrite: (name, content) => ipcRenderer.invoke("config-write", name, content),
  configDelete: (name) => ipcRenderer.invoke("config-delete", name),
  // 命名配置模板(存应用 userData)
  configTemplateList: () => ipcRenderer.invoke("config-templates-list"),
  configTemplateGet: (id) => ipcRenderer.invoke("config-templates-get", id),
  configTemplateSave: (input) => ipcRenderer.invoke("config-templates-save", input),
  configTemplateDelete: (id) => ipcRenderer.invoke("config-templates-delete", id),
  configTemplateApply: (id) => ipcRenderer.invoke("config-templates-apply", id),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  // 云连接(手机远程):查询配置+状态 / 保存并应用;onCloud 订阅状态变化,返回退订函数
  cloudGet: () => ipcRenderer.invoke("cloud-get"),
  cloudSet: (patch) => ipcRenderer.invoke("cloud-set", patch),
  onCloud: (cb) => {
    const h = (_e, st) => cb(st);
    ipcRenderer.on("cloud-event", h);
    return () => ipcRenderer.removeListener("cloud-event", h);
  },
  claudeVersion: (binPath) => ipcRenderer.invoke("claude-version", binPath),
  claudeUpdate: () => ipcRenderer.invoke("claude-update"),
  claudeResolve: () => ipcRenderer.invoke("claude-resolve"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  logPath: () => ipcRenderer.invoke("log-path"), // 落盘日志路径(userData/claude-desk.log),供设置页展示排查
  // 剪贴板桥:终端复制/粘贴(主进程 clipboard,渲染层无需授权)
  clipboardRead: () => ipcRenderer.invoke("clipboard-read"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard-write", String(text ?? "")),
  // 应用版本(供设置页「关于」展示)
  appVersion: () => ipcRenderer.invoke("app-version"),
  // 全屏:切换窗口全屏(F11 快捷键同);onFullscreen 订阅全屏状态变化(按钮图标同步),返回退订函数
  toggleFullscreen: () => ipcRenderer.invoke("set-fullscreen"),
  onFullscreen: (cb) => {
    const h = (_e, v) => cb(!!v);
    ipcRenderer.on("fullscreen-event", h);
    return () => ipcRenderer.removeListener("fullscreen-event", h);
  },
  // 窗口级主题:同步 Win 原生标题栏深/浅(配合主题切换,去掉白色标题栏)
  setWindowTheme: (t) => ipcRenderer.invoke("set-window-theme", t),
  // 退出确认(应用自绘 ConfirmDialog 风格,替代原生弹窗):主进程 close 拦截后 onCloseConfirm
  // 收到 {n 运行中终端数},渲染层弹框;点确定调 confirmClose 真正退出,点取消调 cancelClose 复位
  onCloseConfirm: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on("close-request", h);
    return () => ipcRenderer.removeListener("close-request", h);
  },
  confirmClose: () => ipcRenderer.invoke("confirm-close"),
  cancelClose: () => ipcRenderer.invoke("cancel-close"),
  // 会话事件总线(主→渲染):ev={type:'start'|'user-message'|'stream'|'done'|'error', id, ...}
  onSession: (cb) => ipcRenderer.on("session-event", (_e, ev) => cb(ev)),
  // 终端会话(PTY 真实 claude):打开/写入/缩放/关闭
  terminalOpen: (id) => ipcRenderer.invoke("terminal-open", id),
  terminalWrite: (id, data) => ipcRenderer.invoke("terminal-write", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke("terminal-resize", id, cols, rows),
  terminalSizeOf: (id) => ipcRenderer.invoke("terminal-size-of", id),
  terminalClose: (id) => ipcRenderer.invoke("terminal-close", id),
  // 向当前终端发斜杠命令并捕获输出(/context 监控用);压缩上下文(/compact 自动应答确认)
  terminalCommand: (id, cmd) => ipcRenderer.invoke("terminal-command", id, cmd),
  terminalCompact: (id) => ipcRenderer.invoke("terminal-compact", id),
  // 用户最近一次提交提问(回车)时刻,纪要面板据此做「问完答完才总结」的触发判定
  terminalLastInputAt: (id) => ipcRenderer.invoke("terminal-last-input-at", id),
  // 对话队列(工具面板「☰ 队列」):保存/查询/开始/暂停/停止,状态经 onTerminal(type==='tunnel') 回传
  tunnelSave: (id, items) => ipcRenderer.invoke("tunnel-save", id, items),
  tunnelState: (id) => ipcRenderer.invoke("tunnel-state", id),
  tunnelStart: (id) => ipcRenderer.invoke("tunnel-start", id),
  tunnelPause: (id) => ipcRenderer.invoke("tunnel-pause", id),
  tunnelStop: (id) => ipcRenderer.invoke("tunnel-stop", id),
  // 上下文监控:查询会话「已用 token / 窗口上限」,工具面板底部常显
  contextState: (id) => ipcRenderer.invoke("context-state", id),
  // 与 claude 原版对齐:发 /context 并解析实测「已用/窗口」,面板用它覆盖 jsonl 统计
  contextCli: (id) => ipcRenderer.invoke("context-cli", id),
  // 终端事件总线(主→渲染):ev={type:'open'|'data'|'exit', id, ...};返回退订函数
  onTerminal: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on("terminal-event", h);
    return () => ipcRenderer.removeListener("terminal-event", h);
  },
});
