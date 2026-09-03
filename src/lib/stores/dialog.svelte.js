// 全局中文确认弹窗信号(替代浏览器原生 confirm——按钮在 Electron 里只能是英文 OK/Cancel)
// 用法:await ask("删除该会话?","运行中的任务会被终止。","删除") → true/false
export const dialog = $state({
  open: false,
  title: "",
  message: "",
  confirmText: "确定",
  cancelText: "取消",
  _resolve: null,
});

export function ask(title, message = "", confirmText = "确定") {
  return new Promise((resolve) => {
    dialog.title = title;
    dialog.message = message;
    dialog.confirmText = confirmText;
    dialog.cancelText = "取消";
    dialog._resolve = resolve;
    dialog.open = true;
  });
}

function close(result) {
  const r = dialog._resolve;
  dialog.open = false;
  dialog._resolve = null;
  if (r) r(result);
}

export function confirmDialog() {
  close(true);
}
export function cancelDialog() {
  close(false);
}
