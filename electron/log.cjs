// 落盘日志:userData/claude-desk.log(打包后 stdout 不可见,问题排查全靠它)
// 用法:
//   log.init(app.getPath("userData"))  // whenReady 里尽早调用
//   log("info", "...") / log("error", "...")
//   log.teeConsole()                    // 把主进程 console.* 一并写入日志文件
// 日志文件路径也对外暴露(logPath),设置页可展示给用户。
const fs = require("fs");
const path = require("path");

let logPath = null;

function init(userData) {
  if (!userData) return;
  logPath = path.join(userData, "claude-desk.log");
  // 首行标记一次"本次启动"(也顺带清掉陈旧内容,避免无限膨胀;保留容量小风险低)
  try {
    fs.appendFileSync(logPath, `\n===== 启动 ${new Date().toISOString()} =====\n`, "utf8");
  } catch {}
}

function write(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  if (logPath) {
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch {}
  }
}

// 主进程所有 console.log/warn/error 同时落盘(渲染进程的 warn/error 也会经转发到这里)
function teeConsole() {
  for (const m of ["log", "info", "warn", "error"]) {
    const orig = console[m];
    console[m] = function (...args) {
      const text = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? (a && a.stack) || a.message : safeJson(a)))
        .join(" ");
      write("console", text);
      return orig.apply(console, args);
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = { init, log: write, teeConsole, get logPath() { return logPath; } };
