// 自测模块:主进程自测三件套(主流程 / 终端形态 / 云连接)。
// 从 main.cjs 拆出,靠形参 win 拿到窗口(原为 main 的全局 win),global.__baseUrl 仍共享。
// 均为开发期注入式端到端自测,仅在对应 CD_*_AUTOTEST=1 环境变量下由 main.cjs 条件 require 加载。
const { app, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const persistence = require("./persistence.cjs");
const bridge = require("./bridge.cjs");

// ---- 云连接自测(CD_CLOUD_AUTOTEST=1) ----
// 真实 Electron 壳内联调:本地起中转服务 → 通过 IPC+设置页开启云连接 → 主进程以「手机」角色
// 走完整流程(握手/设备列表/会话列表/打开会话/停止/断开)。不碰真实 claude 终端与真实数据
// (配合 CD_USERDATA 指定独立 userData 更干净)。
async function runCloudAutotest(win) {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const ok = (label, cond, extra = "") => {
    console.log(`${cond ? "AUTOTEST_PASS" : "AUTOTEST_FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails.push(label);
  };
  const { spawn } = require("child_process");
  const crypto = require("crypto");
  const { WebSocket } = require("ws");
  const https = require("http");

  const PORT = 8900 + Math.floor(Math.random() * 300);
  const TOKEN = "cd-auto-" + crypto.randomBytes(6).toString("hex");
  const srv = spawn(process.platform === "win32" ? "node.exe" : "node", [path.join(__dirname, "..", "server", "server.cjs"), "--port", String(PORT), "--token", TOKEN], { stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => console.log("[relay] " + String(d).trim()));
  srv.stderr.on("data", (d) => console.log("[relay-err] " + String(d).trim()));
  srv.on("exit", (code) => console.log("[relay] EXIT code=" + code));

  // 简易 http 请求(等 /health)
  const httpGet = (p) => new Promise((res) => {
    const r = https.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 2000 }, (resp) => { resp.resume(); resp.on("end", () => res(resp.statusCode)); });
    r.on("error", () => res(0));
    r.on("timeout", () => { r.destroy(); res(0); });
  });

  try {
    // 等中转服务就绪
    let up = false;
    for (let i = 0; i < 60; i++) {
      if ((await httpGet("/health")) === 200) { up = true; break; }
      await wait(200);
    }
    ok("本地中转服务起来", up);

    // 1. 设置页云 UI 存在
    await win.loadURL(global.__baseUrl + "settings");
    await wait(900);
    const ui = await exec(`({
      url: !!document.querySelector('[data-testid=cloud-url]'),
      token: !!document.querySelector('[data-testid=cloud-token]'),
      name: !!document.querySelector('[data-testid=cloud-name]'),
      on: !!document.querySelector('[data-testid=cloud-on]'),
      status: !!document.querySelector('[data-testid=cloud-status]'),
    })`);
    ok("设置页云连接 UI 齐全", ui.url && ui.token && ui.name && ui.on && ui.status, JSON.stringify(ui));

    // 2. IPC 开启云连接(autoStart=true)→ 状态应达 online
    const setVal = `(sel, v) => { const el = document.querySelector(sel); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }`;
    await exec(`(${setVal})('[data-testid=cloud-url]', ${JSON.stringify("ws://127.0.0.1:" + PORT)}); (${setVal})('[data-testid=cloud-token]', ${JSON.stringify(TOKEN)}); (${setVal})('[data-testid=cloud-name]', '自测电脑');`);
    await wait(300);
    await exec(`document.querySelector('[data-testid=cloud-on]').click()`);
    let stOnline = false;
    let stJson = "";
    for (let i = 0; i < 60; i++) {
      const r = await exec(`window.claude.cloudGet().then(x => JSON.stringify(x.status))`).catch(() => '"{}"');
      stJson = r;
      if (JSON.parse(r).state === "online") { stOnline = true; break; }
      await wait(300);
    }
    ok("开启云连接后状态 online", stOnline, `st=${stJson}`);
    const devId = JSON.parse(stJson).deviceId;

    // 3. 状态徽标渲染为已上线
    let badge = "";
    for (let i = 0; i < 30; i++) {
      badge = await exec(`(document.querySelector('[data-testid=cloud-status]') || { textContent: '' }).textContent`).catch(() => "");
      if (badge.includes("已上线")) break;
      await wait(200);
    }
    ok("设置页状态徽标「已上线」", badge.includes("已上线"), `badge=${badge.trim()}`);

    // 4. 建一个会话,手机端应能列出
    const created = JSON.parse(await exec(`window.claude.sessionCreate({ cwd:${JSON.stringify(os.tmpdir())}, title:"云自测会话" }).then(x=>JSON.stringify(x))`));
    ok("自测会话创建", !!created.id);
    // 预置一段实录,让 H5「打开会话」能看到回传的上下文(模拟会话跑过对话)
    persistence.setTranscript(created.id, "用户：你好\n助手：你好！这是一段用于云自测的历史对话记录。\n");

    // 5. 主进程扮演手机:握手 → 设备列表 → 会话列表 → 打开会话
    const phoneDone = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const out = { devices: null, sessions: null, info: null, stop: null };
      const timer = setTimeout(() => resolve(out), 25000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "phone", token: TOKEN })));
      ws.on("message", (b) => {
        const m = JSON.parse(b.toString());
        if (m.type === "welcome" && m.ok) {
          out.devices = (m.devices || []).find((d) => d.deviceId === devId) ? "FOUND" : JSON.stringify(m.devices);
          ws.send(JSON.stringify({ type: "list-sessions", msgId: "r1", deviceId: devId }));
        } else if (m.type === "sessions" && m.msgId === "r1") {
          out.sessions = (m.sessions || []).find((s) => s.id === created.id) ? "FOUND" : JSON.stringify(m.sessions);
          ws.send(JSON.stringify({ type: "open-session", msgId: "r2", deviceId: devId, sessionId: created.id }));
        } else if (m.type === "session-info" && m.msgId === "r2") {
          out.info = m.sessionId === created.id ? "FOUND" : JSON.stringify(m);
          ws.send(JSON.stringify({ type: "stop", msgId: "r3", deviceId: devId, sessionId: created.id }));
        } else if (m.type === "answer" && m.msgId === "r3") {
          out.stop = m.ok ? "FOUND" : JSON.stringify(m);
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(out);
        }
      });
      ws.on("error", () => { clearTimeout(timer); resolve(out); });
    });
    ok("手机可见本设备", phoneDone.devices === "FOUND", `devices=${phoneDone.devices}`);
    ok("手机可见自测会话", phoneDone.sessions === "FOUND", `sessions=${phoneDone.sessions}`);
    ok("手机打开会话信息回传", phoneDone.info === "FOUND", `info=${phoneDone.info}`);
    ok("手机 stop 受理", phoneDone.stop === "FOUND", `stop=${phoneDone.stop}`);

    // 7. 真实 H5 手机页全流程:页面 JS → 中转 → 桥(连接/设备/会话/打开对话拿上下文)
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
    await wait(800);
    ok("H5 页连接界面加载", !!(await exec(`!!document.querySelector('#btn-connect')`)));
    // 填 token 点连接(服务器地址默认已取当前页 origin)
    await exec(`(() => {
      const i = document.querySelector('#in-token');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(TOKEN)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-connect').click();
      return true;
    })()`);
    let devItem = "";
    for (let i = 0; i < 40; i++) {
      devItem = await exec(`(() => { const el = document.querySelector('#devlist .item'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`).catch(() => "");
      if (devItem.includes("自测电脑")) break;
      await wait(250);
    }
    ok("H5 进入设备视图并看到本机", devItem.includes("自测电脑"), `item=${devItem}`);
    await exec(`document.querySelector('#devlist .item').click()`).catch(() => {});
    let sesItem = "";
    for (let i = 0; i < 40; i++) {
      sesItem = await exec(`(() => { const el = document.querySelector('#seslist .item'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`).catch(() => "");
      if (sesItem.includes("云自测会话")) break;
      await wait(250);
    }
    ok("H5 会话列表看到自测会话", sesItem.includes("云自测会话"), `item=${sesItem}`);
    await exec(`document.querySelector('#seslist .item').click()`).catch(() => {});
    let ctxText = "";
    for (let i = 0; i < 40; i++) {
      ctxText = await exec(`(() => { const el = document.getElementById('chat-ctx'); return el && el.style.display !== 'none' ? el.textContent.slice(0, 40) : ''; })()`).catch(() => "");
      if (ctxText.length) break;
      await wait(250);
    }
    ok("H5 打开会话回传上下文", ctxText.length > 0, `ctx=${ctxText.replace(/\n/g, " ").slice(0, 60)}`);

    // 8. 断开云连接 → 设备下线(此刻窗口停在 H5 页,直接主进程侧关云,不依赖页面元素)
    bridge.applyConfig({ autoStart: false });
    await wait(500);
    const stOff = bridge.status();
    ok("断开后状态非 online", stOff.state !== "online", `st=${JSON.stringify(stOff).slice(0, 120)}`);

    // 7. 清理:删自测会话、恢复配置
    await exec(`window.claude.sessionDelete(${JSON.stringify(created.id)})`);
    await exec(`window.claude.cloudSet({ serverUrl:"", token:"", autoStart:false })`);

    console.log(fails.length === 0 ? "AUTOTEST_OK CLOUD ALL PASS" : `AUTOTEST_FAIL n=${fails.length}: ${JSON.stringify(fails)}`);
  } catch (err) {
    console.log("AUTOTEST_FAIL EXCEPTION " + String((err && err.stack) || err));
  } finally {
    try { srv.kill(); } catch {}
    setTimeout(() => app.quit(), 200);
  }
}

// ---- 终端自测(CD_TERM_AUTOTEST=1) ----
// 验证终端形态:createSession → 进对话页 → xterm 挂载并渲染出真实 claude TUI → 关终端 → 删除

async function runTermAutotest(win) {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const ok = (label, cond, extra = "") => {
    console.log(`${cond ? "AUTOTEST_PASS" : "AUTOTEST_FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails.push(label);
  };
  // 读取当前终端视图状态(bytes 为渲染层累计接收字节;err/exit 为错误/退出提示)
  const readTerm = () =>
    exec(`(() => {
      const t = document.querySelector('.xterm');
      return {
        path: location.pathname,
        xterm: !!t,
        rows: t ? t.querySelectorAll('.xterm-rows > div').length : 0,
        txt: t ? t.textContent.replace(/\\s+/g, " ").slice(0, 120) : "",
        bytes: window.__termBytes || 0,
        err: (document.querySelector('[data-testid=term-err]') || { textContent: "" }).textContent || "",
        exit: !!document.querySelector('[data-testid=term-exit]'),
        summary: !!document.querySelector('[data-testid=summary-panel]'),
        worktab: !!document.querySelector('[data-testid=tab-workspace]'),
        transcript: (document.querySelector('[data-testid=transcript]') || { textContent: "" }).textContent || "",
      };
    })()`).catch(() => null);
  // 客户端导航:注入 <a> 并 click,走 SvelteKit 客户端路由(= goto),而非整页 loadURL

  try {
    // 1. 等首屏渲染
    for (let i = 0; i < 150; i++) {
      if (await exec(`!!document.querySelector("[data-testid=create-btn]")`).catch(() => false)) break;
      await wait(100);
    }
    // 2. 建会话 A(用安全参数,真实 claude 会在 /tmp 询问"信任此文件夹?",终端原样呈现)
    const created = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits" }).then(x => JSON.stringify(x))`);
    const s = JSON.parse(created);
    ok("创建会话", !!s?.id, created.slice(0, 100));
    const sid = s.id;

    // 3. 直接整页加载对话页(SPA fallback),等待 TerminalView 挂载 xterm 并渲染 claude TUI 输出
    await win.loadURL(global.__baseUrl + "session/" + sid);
    let st = { xterm: false, txt: "", bytes: 0, err: "", exit: false, summary: false, transcript: "" };
    for (let i = 0; i < 200; i++) {
      st = (await readTerm()) || st;
      if (st.err || st.exit || (st.bytes > 0 && st.txt.trim())) break;
      await wait(150);
    }
    ok("xterm已挂载", !!st.xterm, JSON.stringify(st));
    ok("claude TUI已渲染", st.bytes > 0 && st.txt.trim().length > 0, `bytes=${st.bytes} txt=${JSON.stringify(st.txt)}`);
    ok("终端行数填满(输入行贴底)", st.rows >= 32, `rows=${st.rows}(默认 24 即 fit 失败未贴底)`);
    // 4. pty 侧真实尺寸核查:fit 后必须显式同步行列到 pty/claude,否则输入行停在默认行数居中
    const ptySz = await exec(`window.claude.terminalSizeOf(${JSON.stringify(sid)}).then(x => JSON.stringify(x))`).catch(() => null);
    let psz = null;
    try { psz = JSON.parse(ptySz); } catch {}
    ok("pty行列已同步(输入行贴底)", !!psz && psz.rows >= 32, `pty=${ptySz}(open 默认 30 行,fit 后未同步即未贴底)`);
    ok("终端打开无错误", !st.err, `err=${st.err}`);
    // 默认右侧为工具面板(非纪要)
    let defTools = null;
    for (let i = 0; i < 20; i++) {
      defTools = await exec(`(() => ({ tools: !!document.querySelector('[data-testid=tools-panel]'), summaryGone: !document.querySelector('[data-testid=summary-panel]') }))()`).catch(() => null);
      if (defTools && defTools.tools) break;
      await wait(100);
    }
    ok("默认右侧为工具面板", !!defTools && defTools.tools && defTools.summaryGone, JSON.stringify(defTools));
    const bytesAtA = st.bytes;

    // 3.35 右侧面板切换:默认工具;点「纪要」切到纪要,再点「工具」切回(纯按钮、无输出区、无自动执行)
    await exec(`document.querySelector('[data-testid=toggle-summary]').click()`).catch(() => false);
    let smtrl = null;
    for (let i = 0; i < 40; i++) {
      smtrl = await exec(`(() => ({ summary: !!document.querySelector('[data-testid=summary-panel]'), toolsGone: !document.querySelector('[data-testid=tools-panel]'), on: !!document.querySelector('[data-testid=toggle-summary].on') }))()`).catch(() => null);
      if (smtrl && smtrl.summary && smtrl.toolsGone) break;
      await wait(100);
    }
    ok("点「纪要」从工具切到纪要", !!smtrl && smtrl.summary && smtrl.toolsGone, JSON.stringify(smtrl));
    await exec(`document.querySelector('[data-testid=toggle-tools]').click()`).catch(() => false);
    let mtrl = null;
    for (let i = 0; i < 40; i++) {
      mtrl = await exec(`(() => ({
        panel: !!document.querySelector('[data-testid=tools-panel]'),
        summaryGone: !document.querySelector('[data-testid=summary-panel]'),
        hasCompact: !![...document.querySelectorAll('[data-testid=tool-btn]')].some(b => (b.textContent || '').includes('/compact')),
        outputGone: !document.querySelector('[data-testid=monitor-text]'),
        btns: document.querySelectorAll('[data-testid=tool-btn]').length,
        on: !!document.querySelector('[data-testid=toggle-tools].on'),
      }))()`).catch(() => null);
      if (mtrl && mtrl.panel && mtrl.summaryGone) break;
      await wait(100);
    }
    ok("点「工具」切回工具面板", !!mtrl && mtrl.on && mtrl.panel && mtrl.summaryGone, JSON.stringify(mtrl));
    ok("常用命令按钮存在(≥8)", !!mtrl && mtrl.btns >= 8, `btns=${mtrl && mtrl.btns}`);
    ok("压缩上下文按钮存在", !!mtrl && mtrl.hasCompact, `compact=${mtrl && mtrl.hasCompact}`);
    ok("工具面板无输出捕获区", !!mtrl && mtrl.outputGone, `outputGone=${mtrl && mtrl.outputGone}`);

    // 3.35c 底部上下文监控:工具面板底部显示「已用/窗口 (占比%)」,来自主进程读 jsonl usage 或估算
    let ctxUi = "";
    for (let i = 0; i < 20; i++) {
      ctxUi = await exec(`(document.querySelector('[data-testid=context-usage]') || { textContent: '' }).textContent`).catch(() => "");
      if (ctxUi && ctxUi.includes('/')) break;
      await wait(300);
    }
    ok("上下文监控 现在/最大", /[0-9.]+[KM]?\/[0-9.]+[KM]?/.test(ctxUi || "") && ctxUi.includes('%'), `ctx=${String(ctxUi).trim()}`);

    // 3.35d 手动调整上限:输入 240k 点设置 → 徽标出现「手动」,上限字段随之改变
    await exec(`(() => { const i = document.querySelector('[data-testid=ctx-max-input]'); if (!i) return "NO"; i.value = "240k"; i.dispatchEvent(new Event('input', { bubbles: true })); return "SET"; })()`).catch(() => "ERR");
    await wait(200);
    await exec(`(() => { const b = document.querySelector('[data-testid=ctx-max-save]'); if (!b) return "NO"; b.click(); return "OK"; })()`).catch(() => "ERR");
    let maxManual = false;
    let maxVal = "";
    for (let i = 0; i < 20; i++) {
      maxManual = await exec(`!![...document.querySelectorAll('[data-testid=context-usage] .badge')].find(b => (b.textContent || '').includes('手动'))`).catch(() => false);
      maxVal = await exec(`(document.querySelector('[data-testid=ctx-max-input]') || { value: '' }).value`).catch(() => "");
      if (maxManual) break;
      await wait(300);
    }
    ok("手动设置上限生效", maxManual && /240/i.test(maxVal || ""), `manual=${maxManual} val=${maxVal}`);

    // 3.35b 打开面板不自动执行:等 TUI 自绘稳定后,终端文本里不得出现 /context 之类的命令回显
    await wait(1500);
    const notAuto = await exec(`(() => {
      const t = document.querySelector('.xterm');
      const txt = t ? t.textContent || "" : "";
      const userLine = txt.match(/❯[ \\t]*\\/[a-z]+/);
      // 命令被回显:输入行「❯ /xxx」;或输出里出现 /context 字样(它自己会显示命令名)
      const echoed = userLine && userLine[0].includes('/context');
      return JSON.stringify({ echoed, sample: txt.replace(/\\s+/g, " ").slice(-80) });
    })()`).catch(() => null);
    let notAutoOk = false;
    try { notAutoOk = !JSON.parse(notAuto).echoed; } catch {}
    ok("进入工具面板不自动执行命令", notAutoOk, `auto=${notAuto}`);

    // 3.36 点按钮即执行:点击「/context」按钮 → 命令直接写入主终端,输出在主窗口出现(渲染字节增长)
    const beforeBtn = await exec(`window.__termBytes || 0`).catch(() => null);
    const clickCtx = await exec(`(() => { const b = [...document.querySelectorAll('[data-testid=tool-btn]')].find(x => (x.textContent || '').includes('/context')); if (!b) return "NO_BTN"; b.click(); return "CLICKED"; })()`).catch(() => "NO_BTN");
    let ctxBtnOk = false;
    let afterBtn = beforeBtn;
    for (let i = 0; i < 40; i++) {
      await wait(150);
      afterBtn = await exec(`window.__termBytes || 0`).catch(() => null);
      if (parseInt(afterBtn || "0", 10) > parseInt(beforeBtn || "0", 10) + 50) { ctxBtnOk = true; break; }
    }
    ok("工具按钮点击→命令进主终端(/context)", clickCtx === "CLICKED" && ctxBtnOk, `click=${clickCtx} bytes=${beforeBtn}->${afterBtn}`);

    // 3.36b 点工具按钮后键盘焦点回到终端输入行(xterm 隐藏 textarea),可直接继续打字
    const focusInfo = await exec(`(() => {
      const a = document.activeElement;
      const xterm = document.querySelector('.xterm');
      const cls = (a && (typeof a.className === 'string' ? a.className : (a.getAttribute && a.getAttribute('class') || '')) || '').toString();
      return JSON.stringify({ inside: !!(a && xterm && xterm.contains(a)), cls }) ;
    })()`).catch(() => null);
    let focusOk = false;
    try { const f = JSON.parse(focusInfo); focusOk = f.inside && /textarea|xterm/i.test(f.cls); } catch {}
    ok("点工具按钮后焦点回到终端输入行", focusOk, `focus=${focusInfo}`);

    // 3.37 对话队列:工具面板点 /tunnel 打开弹窗,可新增/修改多条;开始后「答完一条自动接力下一条」
    await exec(`(() => { const b = [...document.querySelectorAll('[data-testid=tool-btn]')].find(x => (x.textContent || '').includes('/tunnel')); if (b) b.click(); return 'ok'; })()`).catch(() => "err");
    let tdlg = false;
    for (let i = 0; i < 40; i++) {
      tdlg = await exec(`!!document.querySelector('[data-testid=tunnel-dialog]')`).catch(() => false);
      if (tdlg) break;
      await wait(100);
    }
    ok("打开对话队列弹窗", tdlg);

    // 新增两条(输入框设值并派 input 事件驱动 Svelte bind:value,稍候再点添加)
    const tAdd = async (text) => {
      await exec(`(() => {
        const inp = document.querySelector('[data-testid=tunnel-input]');
        if (!inp) return "NO_INPUT";
        inp.value = ${JSON.stringify(text)};
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return "SET";
      })()`).catch(() => "ERR");
      await wait(250);
      await exec(`(() => { const b = document.querySelector('[data-testid=tunnel-add]'); if (!b || b.disabled) return "DISABLED"; b.click(); return "ADD"; })()`).catch(() => "ERR");
      await wait(400);
    };
    await tAdd("只回复两个字：队列一");
    await tAdd("只回复两个字：队列二");
    await tAdd("请你逐行输出数字1到80，每行一个阿拉伯数字，不要任何其他文字");
    await wait(250);
    const rowsInfo = await exec(`(() => JSON.stringify([...document.querySelectorAll('[data-testid=tunnel-item]')].map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim())))()`).catch(() => "[]");
    let rows = [];
    try { rows = JSON.parse(rowsInfo); } catch {}
    ok("队列可新增多条", rows.length === 3 && /队列一/.test(rows[0] || "") && /逐行输出数字/.test(rows[2] || ""), `rows=${rowsInfo}`);

    // 行内修改第一条
    await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; if (!r) return "NO_ROW"; const b = r.querySelector('[data-testid=tunnel-edit]'); if (b) b.click(); return "OK"; })()`).catch(() => "err");
    let hasEditInput = false;
    for (let i = 0; i < 20; i++) {
      hasEditInput = await exec(`!!document.querySelector('[data-testid=tunnel-edit-input]')`).catch(() => false);
      if (hasEditInput) break;
      await wait(100);
    }
    ok("点条目可进入编辑", hasEditInput);
    await exec(`(() => {
      const inp = document.querySelector('[data-testid=tunnel-edit-input]');
      if (!inp) return "NO_INPUT";
      inp.value = "只回复两个字：队列一改";
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return "SET";
    })()`).catch(() => "ERR");
    await wait(500);
    await exec(`(() => { const b = document.querySelector('[data-testid=tunnel-edit-save]'); if (!b || b.disabled) return "DISABLED"; b.click(); return "CLICK"; })()`).catch(() => "ERR");
    await wait(500);
    const afterEdit = await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; return (r && r.textContent || '').replace(/\\s+/g, ' ').trim(); })()`).catch(() => "");
    ok("修改条目生效", /队列一改/.test(afterEdit || ""), `row=${afterEdit}`);

    // 开始:第一条立即进入发送中
    const ctxA = await exec(`window.claude.contextState(${JSON.stringify(sid)}).then(c => JSON.stringify(c)).catch(() => 'ERR')`).catch(() => "'ERR'");
    const trA = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(s => (s && s.transcript || '').length).catch(() => 0)`).catch(() => 0);
    await exec(`document.querySelector('[data-testid=tunnel-start]').click()`).catch(() => false);
    let firstActive = false;
    for (let i = 0; i < 40; i++) {
      firstActive = await exec(`(() => { const r = document.querySelectorAll('[data-testid=tunnel-item]')[0]; return !!(r && r.classList.contains('active')); })()`).catch(() => false);
      if (firstActive) break;
      await wait(200);
    }
    ok("开始后第一条进入发送", firstActive);

    // 自动接力:第一条答完应变成 done,且第二条自动进入发送——claude 真实回答耗时不定,放开等
    let relayOk = false;
    for (let i = 0; i < 300; i++) {
      const st = await exec(`(() => {
        const rs = [...document.querySelectorAll('[data-testid=tunnel-item]')];
        return JSON.stringify({ d0: !!(rs[0] && rs[0].classList.contains('done')), b1: !!(rs[1] && (rs[1].classList.contains('done') || rs[1].classList.contains('active'))) });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(st); } catch {}
      if (j && j.d0 && j.b1) { relayOk = true; break; }
      await wait(250);
    }
    ok("答完第一条自动接力第二条", relayOk);

    // 一轮跑完即停:三条都 done 且引擎退出执行态
    let allDone = false;
    for (let i = 0; i < 300; i++) {
      const st = await exec(`(() => {
        const rs = [...document.querySelectorAll('[data-testid=tunnel-item]')];
        const btn = document.querySelector('[data-testid=tunnel-start]');
        return JSON.stringify({ done: rs.length === 3 && rs.every(r => r.classList.contains('done')), startText: btn ? (btn.textContent || '').trim() : '' });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(st); } catch {}
      if (j && j.done && j.startText && !j.startText.includes("执行中")) { allDone = true; break; }
      if (i > 30 && j && j.done) { allDone = true; break; } // 容错:done 就够了(引擎事件可能已收尾)
      await wait(250);
    }
    ok("队列一轮跑完全部完成", allDone);

    // 历史回看:claude TUI 全屏(alt buffer)在 xterm 里无 scrollback,我们自存行历史;
    // 向上滚 → 回看覆盖层出现且滚动条带比例滑块;向下滚到底 → 退出回看恢复实时
    await exec(`(() => {
      const h = document.querySelector('.host');
      if (!h) return 'NO_HOST';
      h.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true, cancelable: true }));
      return 'SCROLLED';
    })()`).catch(() => "ERR");
    let revInfo = null;
    for (let i = 0; i < 30; i++) {
      revInfo = await exec(`(() => {
        const rv = document.querySelector('[data-testid=terminal-review]');
        const sb = document.querySelector('[data-testid=terminal-scroller]');
        const t = sb && sb.querySelector('.thumb');
        return JSON.stringify({ review: !!rv, sb: !!sb, th: t ? t.style.height : '', text: rv ? (rv.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) : '' });
      })()`).catch(() => null);
      let j = null;
      try { j = JSON.parse(revInfo); } catch {}
      if (j && j.review && j.sb) break;
      await wait(200);
    }
    let revOK = false;
    try { const j = JSON.parse(revInfo); revOK = j.review && j.sb && j.th && j.th !== '100%'; } catch {}
    ok("历史回看:上滚出现覆盖层与滚动条", revOK, `rev=${revInfo}`);

    // 向下滚到底 → 退出回看,恢复实时画面
    await exec(`(() => { const h = document.querySelector('.host'); if (h) h.dispatchEvent(new WheelEvent('wheel', { deltaY: 9999, bubbles: true, cancelable: true })); return 1; })()`).catch(() => 0);
    let revGone = false;
    for (let i = 0; i < 20; i++) {
      revGone = await exec(`!document.querySelector('[data-testid=terminal-review]')`).catch(() => false);
      if (revGone) break;
      await wait(150);
    }
    ok("回看滚到底退出,恢复实时", revGone);

    // 上下文统计随真实对话变化:队列两队问答全部完成后,jsonl 常量 usage(本机后端写死 18286/60)
    // 应被探测到(stale)并转估算;估算按去重内容随对话真实增长,used 应大于开头采样且非 jsonl 固定值
    const ctxB = await exec(`window.claude.contextState(${JSON.stringify(sid)}).then(c => JSON.stringify(c)).catch(() => 'ERR')`).catch(() => "'ERR'");
    let ctxAUsed = 0, ctxBUsed = 0, ctxBFrom = "";
    try { ctxAUsed = JSON.parse(ctxA).used; } catch {}
    try { const j = JSON.parse(ctxB); ctxBUsed = j.used; ctxBFrom = j.source || ""; } catch {}
    ok(
      "上下文统计随对话增长(转估算)",
      ctxBUsed > ctxAUsed && ctxBFrom === "estimate",
      `used ${ctxAUsed} -> ${ctxBUsed} src=${ctxBFrom} raw=${ctxB}`
    );

    // 关闭弹窗(队列与记录保留),回到纪要流程
    await exec(`document.querySelector('[data-testid=tunnel-close]').click()`).catch(() => false);
    for (let i = 0; i < 30; i++) {
      const gone = await exec(`!document.querySelector('[data-testid=tunnel-dialog]')`).catch(() => true);
      if (gone) break;
      await wait(100);
    }

    // 切回纪要(后续断言基于纪要面板),同按钮再次点击收起语义保持
    await exec(`(() => { const el = document.querySelector('[data-testid=toggle-summary]'); if (!el) return "NO_EL"; el.click(); return "CLICKED"; })()`).catch(() => "NO_EL");
    let backSummary = false;
    for (let i = 0; i < 40; i++) {
      const has = await exec(`!!document.querySelector('[data-testid=summary-panel]')`).catch(() => false);
      if (has) { backSummary = true; break; }
      await wait(100);
    }
    ok("切回纪要面板恢复", backSummary);

    // 3.4 「结束终端」需确认:点按钮弹中文确认框,取消则进程不动
    await exec(`document.querySelector('[data-testid=term-stop]').click()`).catch(() => false);
    let dlgText = "";
    for (let i = 0; i < 30; i++) {
      dlgText = await exec(`(document.querySelector('[data-testid=confirm-dialog] .title') || { textContent: "" }).textContent`).catch(() => "");
      if (dlgText.trim()) break;
      await wait(100);
    }
    ok("结束终端弹确认框", dlgText.trim() === "结束终端？", `title=${JSON.stringify(dlgText)}`);
    await exec(`document.querySelector('[data-testid=dlg-cancel]').click()`).catch(() => false);
    await wait(250);
    const stCancel = (await readTerm()) || st;
    ok("取消后终端仍在运行", stCancel.bytes >= bytesAtA && !stCancel.exit, `bytes=${stCancel.bytes} exit=${stCancel.exit}`);

    // 3.4b Ctrl+C 退出重连:关闭终端(=退出后的 UI 状态)→ 出现「进程已结束」+ 重连按钮;点重连恢复
    await exec(`window.claude.terminalClose(${JSON.stringify(sid)})`);
    let exitShown = false;
    let hasReconn = false;
    for (let i = 0; i < 40; i++) {
      exitShown = await exec(`!!document.querySelector('[data-testid=term-exit]')`).catch(() => false);
      hasReconn = await exec(`!!document.querySelector('[data-testid=term-reconnect]')`).catch(() => false);
      if (exitShown && hasReconn) break;
      await wait(100);
    }
    ok("进程退出显示重连提示", exitShown && hasReconn, `exit=${exitShown} term-reconnect=${hasReconn}`);
    const topBtn = await exec(`!!document.querySelector('[data-testid=term-reconnect-top]')`).catch(() => false);
    ok("顶部出现重连按钮(未运行)", topBtn, `top=${topBtn}`);
    const prevTopBytes = parseInt(await exec(`window.__termBytes || 0`).catch(() => "0"), 10);
    await exec(`document.querySelector('[data-testid=term-reconnect]').click()`).catch(() => false);
    let reconnOk = false;
    for (let i = 0; i < 50; i++) {
      const running = await exec(`!!document.querySelector('[data-testid=term-stop]') && !document.querySelector('[data-testid=term-exit]')`).catch(() => false);
      const nowBytes = parseInt(await exec(`window.__termBytes || 0`).catch(() => "0"), 10);
      if (running && nowBytes > prevTopBytes + 30) { reconnOk = true; break; }
      await wait(150);
    }
    ok("重连后终端恢复运行", reconnOk, `bytes ${prevTopBytes} -> ${await exec(`window.__termBytes || 0`).catch(() => "?")}`);

    // 3.5 同路由参数变化(会话页内「＋新建/切 tab」):SvelteKit 复用组件实例不重跑 onMount,
    //     必须 {#key id} 重挂才能给新会话起新终端 → 用客户端导航复现用户实际问题
    const createdB = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits", skipPermissions:true }).then(x => JSON.stringify(x))`);
    const sB = JSON.parse(createdB);
    ok("建会话B", !!sB?.id, createdB.slice(0, 100));
    const sidB = sB.id;
    await exec(`(() => { const a = document.createElement("a"); a.id="gotoB"; a.href="/session/${sidB}"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let navB = false;
    let stB = st;
    for (let i = 0; i < 200; i++) {
      stB = (await readTerm()) || stB;
      navB = navB || stB.path === "/session/" + sidB;
      if (navB && (stB.bytes > bytesAtA || stB.err || stB.exit)) break;
      await wait(150);
    }
    ok("客户端导航到新会话B", navB, `path=${stB.path} bytes=${stB.bytes}`);
    ok("B的终端已开启(新终端存在)", stB.bytes > bytesAtA, `bytesAtA=${bytesAtA} bytesB=${stB.bytes} err=${stB.err}`);

    // 3.5b 跳过权限确认:会话B创建时勾选 skipPermissions,查其 pty 启动参数确实带上了该 flag
    const skipArgs = await exec(`window.claude.terminalOpen(${JSON.stringify(sidB)}).then(x => JSON.stringify((x && x.args) || null))`).catch(() => "null");
    ok("跳过权限确认勾选生效(--dangerously-skip-permissions)", (skipArgs || "").includes("--dangerously-skip-permissions"), `args=${skipArgs}`);

    // 3.6 纪要面板:默认视图是「问答总结」,实录在「📜 实录」视图下。
    // 先点开关切到实录验证 transcript 出现,再切回总结视图(开关往返都验证)
    await exec(`document.querySelector('[data-testid=summary-view-raw]').click()`).catch(() => false);
    let stTrans = "";
    for (let i = 0; i < 200; i++) {
      stTrans = ((await readTerm()) || {}).transcript || "";
      if (stTrans.trim().length > 0) break;
      await wait(150);
    }
    ok("纪要面板实录出现", stTrans.trim().length > 0, `len=${stTrans.trim().length}`);
    await exec(`document.querySelector('[data-testid=summary-view-summary]').click()`).catch(() => false);
    let backDigest = false;
    // 摘要由真实 claude -p 生成,耗时不固定 → 等放宽到 ~20s 再判
    for (let i = 0; i < 100; i++) {
      const has = await exec(`!!document.querySelector('[data-testid=summary-digest]') || !!document.querySelector('[data-testid=summary-regen]')`).catch(() => false);
      if (has) { backDigest = true; break; }
      await wait(200);
    }
    ok("切回问答总结视图", backDigest);

    // 3.7 切回会话A:附着式 replay 重放历史,不报错
    await exec(`(() => { const a = document.createElement("a"); a.id="gotoA"; a.href="/session/${sid}"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let stA2 = st;
    for (let i = 0; i < 120; i++) {
      stA2 = (await readTerm()) || stA2;
      if (stA2.path === "/session/" + sid && stA2.xterm) break;
      await wait(150);
    }
    ok("切回会话A不报错", stA2.path === "/session/" + sid && !stA2.err, `path=${stA2.path} err=${stA2.err}`);

    // 3.7b 顶部 tab 栏首位固定「工作空间」入口(跳回会话列表,补全跳转)
    ok("tab栏含工作空间跳转入口", !!stA2.worktab, `worktab=${stA2.worktab}`);

    // 3.8 工作空间编辑会话:齿轮 → 改名称 → 保存落库(用独立一次性会话,避免误改用户数据)
    const titleC = `cd-edit-${Date.now()}`;
    const doneTitle = titleC + "-done";
    const createdC = await exec(`window.claude.sessionCreate({ cwd:"/tmp", title:${JSON.stringify(titleC)} }).then(x=>JSON.stringify(x))`);
    const sC = JSON.parse(createdC);
    const sidC = sC.id;
    await exec(`(() => { const a=document.createElement("a"); a.href="/"; document.body.appendChild(a); a.click(); a.remove(); return true; })()`).catch(() => false);
    let gearOk = "";
    for (let i = 0; i < 60; i++) {
      gearOk = await exec(`(() => {
        const items = [...document.querySelectorAll("[data-testid=session-item]")];
        const it = items.find((x) => { const t = x.querySelector(".title"); return t && t.textContent.trim() === ${JSON.stringify(titleC)}; });
        if (!it) return "NO_ITEM";
        const gear = it.querySelector("[data-testid=edit-session]");
        if (!gear) return "NO_GEAR";
        gear.click();
        return "OPENED";
      })()`).catch(() => "");
      if (gearOk === "OPENED") break;
      await wait(150);
    }
    ok("列表项有编辑齿轮", gearOk === "OPENED", `gear=${gearOk}`);
    let editModal = false;
    for (let i = 0; i < 20; i++) {
      editModal = await exec(`!!document.querySelector("[data-testid=f-save]")`).catch(() => false);
      if (editModal) break;
      await wait(100);
    }
    ok("编辑弹窗打开", !!editModal);
    await exec(`(() => { const inp = document.querySelector("[data-testid=f-title]"); inp.value = ${JSON.stringify(doneTitle)}; inp.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`).catch(() => false);
    await exec(`document.querySelector("[data-testid=f-save]").click()`).catch(() => false);
    let savedTitle = "";
    for (let i = 0; i < 30; i++) {
      savedTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sidC)}).then(x => JSON.stringify(x.title))`).catch(() => "");
      if (JSON.parse(savedTitle || '"---"') === doneTitle) break;
      await wait(150);
    }
    ok("编辑保存生效", JSON.parse(savedTitle || '"---"') === doneTitle, `title=${savedTitle}`);

    // 3.9 未命名会话自动标题:向会话B发一条提问,实录落盘后标题按首条提问内容自动生成
    await exec(`window.claude.terminalCommand(${JSON.stringify(sidB)}, "请用一句中文介绍你自己\\n")`).catch(() => null);
    let autoTitle = "";
    for (let i = 0; i < 40; i++) {
      await wait(500);
      autoTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sidB)}).then((x) => JSON.stringify(x.title))`).catch(() => JSON.stringify("---"));
      const t = JSON.parse(autoTitle || '"---"');
      if (t && t !== "未命名会话") break;
    }
    const autoT = JSON.parse(autoTitle || '"---"');
    ok("未命名会话按提问自动生成标题", typeof autoT === "string" && autoT !== "未命名会话" && autoT.length > 0, `title=${autoTitle}`);

    // 4. 关闭终端(不删会话)
    const closed = await exec(`window.claude.terminalClose(${JSON.stringify(sid)}).then(x=>JSON.stringify(x))`);
    ok("终端可关闭", JSON.parse(closed) === true, `close=${closed}`);
    await wait(400);

    // 5. 清理(三会话)
    await exec(`window.claude.sessionDelete(${JSON.stringify(sidC)})`);
    await exec(`window.claude.sessionDelete(${JSON.stringify(sidB)})`);
    await exec(`window.claude.sessionDelete(${JSON.stringify(sid)})`);
    ok("删除会话", true);

    // 6. 全屏:进入↔退出各验证一次(状态经 IPC 返回;布局自适应由 ResizeObserver→doFit 兜底)
    const fs1 = await exec(`window.claude.toggleFullscreen().then((x) => JSON.stringify(x))`).catch(() => "null");
    ok("全屏切换生效", JSON.parse(fs1) === true, `fs1=${fs1}`);
    await wait(300);
    const fs2 = await exec(`window.claude.toggleFullscreen().then((x) => JSON.stringify(x))`).catch(() => "null");
    ok("退出全屏恢复", JSON.parse(fs2) === false, `fs2=${fs2}`);

    console.log(fails.length === 0 ? "AUTOTEST_OK TERM ALL PASS" : `AUTOTEST_FAIL n=${fails.length}: ${JSON.stringify(fails)}`);
    app.quit();
  } catch (err) {
    console.log("AUTOTEST_FAIL EXCEPTION " + String((err && err.stack) || err));
    app.exit(1);
  }
}

async function runAutotest(win) {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const execSafe = (js, ms = 20000) =>
    Promise.race([exec(js), wait(ms).then(() => "__EXEC_TIMEOUT__")]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const ok = (label, cond, extra = "") => {
    console.log(`${cond ? "AUTOTEST_PASS" : "AUTOTEST_FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails.push(label);
  };

  try {
    // 轮询等前端首屏挂载(注入将增大 bundle,固定等 1.5s 在慢机不稳)
    await execSafe(`new Promise((res) => { const t0 = Date.now(); const p = () => { if (document.querySelector("[data-testid=create-btn]") || Date.now() - t0 > 15000) return res(true); setTimeout(p, 100); }; p(); })`, 20000);
    // 1. 列表页渲染
    const listState = await exec(`({
      mounted: !!document.querySelector("textarea") || !!document.querySelector(".session-list"),
      createBtn: !!document.querySelector("[data-testid=create-btn]"),
      list: !!document.querySelector("[data-testid=session-item]") || document.querySelector(".empty"),
      text: document.body.innerText.slice(0, 300),
    })`);
    ok("列表页渲染", listState.createBtn, JSON.stringify(listState));
    ok("无原生菜单栏", Menu.getApplicationMenu() === null, "Menu=null");

    // 2. 建会话(不传标题,验证自动命名;参数用无害的自定义 flag 验证传递)
    const created = await exec(`window.claude.sessionCreate({ cwd:"/tmp", argText:"--permission-mode acceptEdits", skipPermissions:true }).then(x => JSON.stringify(x))`);
    const s = JSON.parse(created);
    ok("创建会话返回id", !!s?.id, created.slice(0, 120));
    const sid = s.id;

    // 3. 列表能查到
    const listed = await exec(`window.claude.sessionList().then(x => JSON.stringify(x.length))`);
    ok("列表查得到会话", Number(listed) >= 1, `count=${listed}`);

    // 3.5 建会话时不填标题 → 默认标题;回首页触发 onMount 刷新,列表出现按天筛选 tabs
    const defTitle = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(x => JSON.stringify(x.title))`);
    ok("标题默认未命名", JSON.parse(defTitle) === "未命名会话", `title=${defTitle}`);
    await win.loadURL(global.__baseUrl); // 触发列表页 onMount refreshList
    await wait(800);
    const hasTabs = await exec(`!!document.querySelector("[data-testid=filter-today]") && !!document.querySelector("[data-testid=session-item]")`);
    ok("按天筛选tabs存在", !!hasTabs, `tabs&item=${hasTabs}`);

    // 4. 发消息(用户消息/流式/完成落库)
    const sendRes = await exec(`window.claude.sessionSend(${JSON.stringify(sid)}, "用一句话介绍你自己").then(x => JSON.stringify(x))`);
    ok("发送返回ok", !JSON.parse(sendRes).error, sendRes.slice(0, 120));

    // 5. 直接整页加载对话页(SPA fallback),绕开点击导航的渲染进程不确定性。
    //    注意:会话页主体已是「真实 claude 终端」(见 CD_TERM_AUTOTEST 的完整验证:
    //    终端挂载/TUI 渲染/行数贴底/滚动回看/上下文监控等);历史上「问答气泡」
    //    (ChatLog 的 block-text / Composer 的 ctx-stats)已随 UI 演进移除,
    //    对应的过期断言不再有意义,这里只验证会话视图可正常导航。
    await win.loadURL(global.__baseUrl + "session/" + sid);
    await wait(1200);
    const navPath = await exec(`location.pathname`);
    ok("导航进入对话页", String(navPath).includes("/session/"), `path=${navPath}`);

    // 上下文统计栏 + 首条消息后标题自动生成(统计栏已并入工具面板上下文监控,见 CD_TERM_AUTOTEST)
    const afterSend = await execSafe(`window.claude.sessionGet(${JSON.stringify(sid)}).then((x) => JSON.stringify({ title: x.title }))`, 10000);
    const as = JSON.parse(afterSend);
    ok("标题已自动生成", as.title === "用一句话介绍你自己", `title=${as.title}`);

    // 等 UI tick 让 $derived 总结重算完成;默认右侧为工具面板,先点「纪要」展开纪要再查右栏
    await wait(800);
    await exec(`(() => { const el = document.querySelector('[data-testid=toggle-summary]'); if (!el) return "NO_EL"; el.click(); return "CLICKED"; })()`).catch(() => "NO_EL");
    await wait(600);
    const summaryState = await execSafe(`({
      hasToggle: !!document.querySelector("[data-testid=summary-toggle]"),
      hasViewSummary: !!document.querySelector("[data-testid=summary-view-summary]"),
      hasViewRaw: !!document.querySelector("[data-testid=summary-view-raw]"),
      hasTabbar: !!document.querySelector("[data-testid=session-tab]"),
      hasNewTab: !!document.querySelector("[data-testid=new-session-tab]"),
      hasFs: !!document.querySelector("[data-testid=toggle-fullscreen]"),
    })`, 10000);
    ok("纪要面板分「总结/实录」两视图(开关)", !!summaryState.hasToggle && summaryState.hasViewSummary && summaryState.hasViewRaw, JSON.stringify(summaryState).slice(0, 160));
    ok("多会话tab栏存在", !!summaryState.hasTabbar, `tab=${summaryState.hasTabbar}`);
    ok("新建对话按钮存在", !!summaryState.hasNewTab, `newTab=${summaryState.hasNewTab}`);
    ok("全屏切换按钮存在", !!summaryState.hasFs, `fs=${summaryState.hasFs}`);

    // 5. 落盘反查:loadSession 的 messages 里应含 user + assistant 文本
    const persisted = await exec(`window.claude.sessionGet(${JSON.stringify(sid)}).then(x => JSON.stringify({ n: x.messages.length, texts: x.messages.map(m => m.role==='user' ? (m.text||'') : (m.blocks||[]).map(b=>b.text||'').join('')).filter(t=>t.length>0).slice(0,4) }))`);
    const p = JSON.parse(persisted);
    ok("消息已落盘", p.n >= 2 && p.texts.length >= 2, persisted.slice(0, 200));

    // 6. 设置回环:先备份原值,断言后恢复(不改动用户真实偏好)
    let origSettings = {};
    try { origSettings = JSON.parse(await exec(`window.claude.settingsGet().then(x => JSON.stringify(x))`).catch(() => "{}") || "{}"); } catch {}
    await exec(`window.claude.settingsSet({ claudePath: "", terminalFontSize: 17 }).then(x => JSON.stringify(x))`);
    const st = await exec(`window.claude.settingsGet().then(x => JSON.stringify(x))`);
    ok("设置读写", !JSON.parse(st).claudePath && JSON.parse(st).terminalFontSize === 17, st.slice(0, 80));
    await exec(`window.claude.settingsSet({ claudePath: ${JSON.stringify(origSettings.claudePath || "")}, terminalFontSize: ${Number(origSettings.terminalFontSize) || 13} }).then(x => JSON.stringify(x))`);

    // 6.2 设置页:安装指南链接 / 命名配置模板(新建+下拉应用) / 动态版本 + 标准三文件直编回环 + 单编辑区语法高亮编辑器
    await win.loadURL(global.__baseUrl + "settings");
    await wait(2600); // 等 claudeResolve 探测版本(claude --version)
    const setUi = await execSafe(`({
      guide: !!document.querySelector("[data-testid=guide-link]"),
      tmplNew: !!document.querySelector("[data-testid=tmpl-new]"),
      tmplSel: !!document.querySelector("[data-testid=tmpl-select]"),
      verCode: (document.querySelector(".desc code") || { innerText: "" }).innerText.trim(),
      dp: !!document.querySelector("[data-testid=date-picker]") || !!document.querySelector("[data-testid=session-item]"),
      font: !!document.querySelector("[data-testid=term-fontsize]"),
    })`, 10000);
    ok("设置页安装指南链接", setUi.guide, `guide=${setUi.guide}`);
    ok("命名配置模板按钮/下拉存在", setUi.tmplNew && setUi.tmplSel, `new=${setUi.tmplNew} sel=${setUi.tmplSel}`);
    ok("版本描述动态化", setUi.verCode.includes("claude") && setUi.verCode.length > 6, `ver=${setUi.verCode}`);
    ok("终端字体大小设置项存在", !!setUi.font, `font=${setUi.font}`);

    // 备份用户真实 settings.json / settings.local.json(下面的写回测会修改它们,必须恢复)
    const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
    const LOCAL_PATH = path.join(os.homedir(), ".claude", "settings.local.json");
    const settingsBackup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : null;
    const localBackup = fs.existsSync(LOCAL_PATH) ? fs.readFileSync(LOCAL_PATH, "utf8") : null;

    // 6.2a 标准三文件直编(白名单):写 settings.local.json → 读回 → 删除
    const cfgRT = await exec(`(async () => {
      const name = "settings.local.json";
      await window.claude.configWrite(name, "{\\"ok\\":true}");
      const r = await window.claude.configRead(name);
      await window.claude.configDelete(name);
      return JSON.stringify({ read: r.content, exists: r.exists, n: (await window.claude.configList()).length });
    })()`);
    const cfgRt = JSON.parse(cfgRT);
    ok("标准三文件读写回环", cfgRt.read === "{\"ok\":true}" && cfgRt.exists && cfgRt.n === 3, cfgRT.slice(0, 120));
    // 恢复 settings.local.json 原样
    if (localBackup != null) fs.writeFileSync(LOCAL_PATH, localBackup, "utf8");
    else if (fs.existsSync(LOCAL_PATH)) fs.rmSync(LOCAL_PATH);

    // 6.2b 命名配置模板:UI 新建(名字+JSON 内容) → 列表出现 → 下拉选中并应用写入真实 settings.json → 删除
    const setValFn = `(sel, v) => { const el = document.querySelector(sel); const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }`;
    await execSafe(`document.querySelector("[data-testid=tmpl-new]").click()`, 5000);
    await wait(300);
    const tplPanel = await exec(`!!document.querySelector("[data-testid=tmpl-editor-panel]") && !!document.querySelector("[data-testid=tmpl-editor]") && !!document.querySelector(".edwrap .hl")`);
    ok("模板编辑器面板+高亮", tplPanel, `panel=${tplPanel}`);
    await exec(`(${setValFn})(${JSON.stringify("[data-testid=tmpl-name]")}, ${JSON.stringify("cd-autotest-模板")}); (${setValFn})(${JSON.stringify("[data-testid=tmpl-editor]")}, ${JSON.stringify('{"theme": "dark", "tmp": true}')});`);
    await execSafe(`document.querySelector("[data-testid=tmpl-save]").click()`, 5000);
    await wait(500);
    const tplArr = JSON.parse(await exec(`window.claude.configTemplateList().then((x) => JSON.stringify(x))`));
    const mine = tplArr.find((t) => t.name === "cd-autotest-模板");
    ok("模板保存成功并列出", !!mine && !!mine.id, `n=${tplArr.length}`);

    // 回显:点「编辑」应把模板名称/内容回填(列表项不含 content,必须按 id 拉取)
    await execSafe(`(() => {
      const items = [...document.querySelectorAll("[data-testid=tmpl-item]")];
      const it = items.find((x) => (x.querySelector(".name") || {}).innerText === ${JSON.stringify("cd-autotest-模板")});
      if (!it) return;
      const b = it.querySelector("[data-testid=tmpl-edit]");
      if (b) b.click();
    })()`, 5000);
    await wait(400);
    const tplBackRaw = await exec(`(() => {
      const ta = document.querySelector("[data-testid=tmpl-editor]");
      const hl = document.querySelector(".edwrap .hl");
      const val = ta ? ta.value : "";
      return JSON.stringify({ val, hlOk: hl ? hl.innerHTML.includes("t-key") || hl.innerHTML.includes("t-str") : false, hlSmp: hl ? hl.innerHTML.slice(0, 160) : "" });
    })()`, 10000);
    const tplBack = JSON.parse(tplBackRaw);
    ok("模板编辑回显内容", tplBack.val.includes('"tmp": true') && tplBack.val.includes("dark"), `val=${(tplBack.val || "").slice(0, 40)}`);
    ok("模板编辑高亮渲染", tplBack.hlOk, `hl=${tplBack.hlSmp}`);
    await execSafe(`[...document.querySelectorAll("[data-testid=tmpl-editor-panel] button")].find((b) => b.innerText.includes("收起"))?.click()`, 4000).catch(() => {});
    await wait(200);

    // 下拉选中该模板并「应用」→ 写入真实 settings.json
    await exec(`(() => {
      const sel = document.querySelector("[data-testid=tmpl-select]");
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(mine.id)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })();`);
    await execSafe(`document.querySelector("[data-testid=tmpl-apply]").click()`, 5000);
    await wait(300);
    const afterApply = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : "";
    ok("模板应用写入 settings.json", afterApply.includes('"tmp": true'), afterApply.slice(0, 80));
    // 恢复 settings.json 原样
    if (settingsBackup != null) fs.writeFileSync(SETTINGS_PATH, settingsBackup, "utf8");
    else if (fs.existsSync(SETTINGS_PATH)) fs.rmSync(SETTINGS_PATH);

    // 删除模板 → 列表不再含它
    const delOk = await exec(`window.claude.configTemplateDelete(${JSON.stringify(mine && mine.id)}).then((x) => JSON.stringify(x))`);
    const tplArr2 = JSON.parse(await exec(`window.claude.configTemplateList().then((x) => JSON.stringify(x))`));
    ok("模板删除", JSON.parse(delOk) === true && !tplArr2.some((t) => t.id === mine.id), `del=${delOk}`);

    // 单编辑区:先写入确定 JSON,点开 settings.local.json 验证【回显内容 + 高亮 span 真实渲染】
    await exec(`window.claude.configWrite("settings.local.json", '{"color":"#ff0","num":42}')`);
    await execSafe(`[...document.querySelectorAll("[data-testid=config-item]")][1].click()`, 5000);
    await wait(400);
    const edRaw = await exec(`(() => {
      const ta = document.querySelector("[data-testid=cfg-editor]");
      const hl = document.querySelector(".edwrap .hl");
      return JSON.stringify({ has: !!ta, out: ta ? ta.value : "", hlOk: !!hl && (hl.innerHTML.includes("t-key") || hl.innerHTML.includes("t-str") || hl.innerHTML.includes("t-num")) });
    })()`, 10000);
    const ed = JSON.parse(edRaw);
    ok("配置文件编辑回显内容", ed.has && ed.out.includes('"color"'), `out=${(ed.out || "").slice(0, 40)}`);
    ok("配置文件编辑语法高亮渲染", ed.hlOk, `ed=${edRaw.slice(0, 100)}`);
    // 高亮颜色真实可见:历史根因是 .t-* 类只出现在 JS 拼接出的 HTML 里,Svelte 把规则当 unused 剔除
    // (高亮只有 span 结构、没有颜色),现用 :global 保留 + 主题变量,亮/暗 computed 都应是可见色
    const darkColor = await exec(`(() => {
      document.querySelector('[data-testid=theme-dark]').click();
      const el = document.querySelector(".edwrap .hl .t-key");
      return el ? getComputedStyle(el).color : "no-el";
    })()`).catch(() => "eval-err");
    const lightColor = await exec(`(() => {
      document.querySelector('[data-testid=theme-light]').click();
      const el = document.querySelector(".edwrap .hl .t-key");
      return el ? getComputedStyle(el).color : "no-el";
    })()`).catch(() => "eval-err");
    await exec(`document.querySelector('[data-testid=theme-dark]').click()`).catch(() => {}); // 切回暗色,保持与默认一致
    ok("高亮颜色真实可见(暗/亮)", darkColor === "rgb(126, 231, 135)" && lightColor === "rgb(17, 99, 41)", `dark=${darkColor} light=${lightColor}`);
    // 用完删除并恢复用户原样
    await execSafe(`[...document.querySelectorAll("[data-testid=cfg-editor-panel] button")].find((b) => b.innerText.includes("收起"))?.click()`, 4000).catch(() => {});
    await exec(`window.claude.configDelete("settings.local.json")`);
    if (localBackup != null) fs.writeFileSync(LOCAL_PATH, localBackup, "utf8");
    else if (fs.existsSync(LOCAL_PATH)) fs.rmSync(LOCAL_PATH);

    // 6.3 列表页:日期选择器 + 列表项含 创建/更新时间、上下文长度 文案
    await win.loadURL(global.__baseUrl);
    await wait(900);
    const listUi = await execSafe(`({
      date: !!document.querySelector("[data-testid=date-picker]"),
      meta: (document.body.innerText.match(/🕒|✏️|tok/) || []).length > 0,
      // 模块标题「工作空间」;新建等其余文案回归「会话」
      title: document.querySelector("h1")?.innerText.trim() === "工作空间",
      newBtn: document.querySelector("[data-testid=create-btn]")?.innerText.includes("新建会话"),
    })`, 10000);
    ok("列表日期选择器存在", listUi.date, `date=${listUi.date}`);
    ok("列表项时间与上下文", listUi.meta, `meta=${listUi.meta}`);
    ok("模块标题工作空间+新建会话", listUi.title && listUi.newBtn, `title=${listUi.title} new=${listUi.newBtn}`);

    // 6.3a 顶部导航 logo 换成用户图片(screenshot-20260903-084503.png),而非文字"◆"
    const logo = await exec(`(() => {
      const img = document.querySelector(".logo img.logo-img");
      return !!img && (img.src === "/screenshot-20260903-084503.png" || img.src.endsWith("/screenshot-20260903-084503.png")) && img.naturalWidth > 0;
    })()`, 10000);
    ok("顶部 logo 图片渲染", !!logo, `logo=${logo}`);

    // 6.3c 删除会话确认弹窗为中文(替代原生 confirm 的英文 OK/Cancel);这里只验证按钮再取消,不真删
    await execSafe(`document.querySelector(".item .del")?.click()`, 5000);
    await wait(300);
    const dlgInfo = await exec(`(() => {
      const box = document.querySelector("[data-testid=confirm-dialog]");
      if (!box) return "no-dialog";
      return JSON.stringify({
        ok: document.querySelector("[data-testid=dlg-ok]")?.innerText.trim(),
        cancel: document.querySelector("[data-testid=dlg-cancel]")?.innerText.trim(),
        title: document.querySelector("[data-testid=dlg-title]")?.innerText.trim(),
      });
    })()`, 10000);
    ok("删除确认弹窗中文按钮", (() => {
      try {
        const d = JSON.parse(dlgInfo);
        return d.ok === "删除" && d.cancel === "取消" && (d.title || "").includes("删除该会话");
      } catch {
        return false;
      }
    })(), `dlg=${dlgInfo}`);
    await execSafe(`document.querySelector("[data-testid=dlg-cancel]")?.click()`, 5000).catch(() => {});

    // 6.3b 新建弹窗含「名称(可选)」输入框;填名创建后标题按所填写入(不被首条消息覆盖)
    await execSafe(`document.querySelector("[data-testid=create-btn]").click()`, 5000);
    await wait(300);
    const fTitle = await exec(`!!document.querySelector("[data-testid=f-title]") && !!document.querySelector("[data-testid=f-cwd]") && !!document.querySelector("[data-testid=f-save]")`);
    ok("新建弹窗含名称输入框", fTitle, `fTitle=${fTitle}`);
    await exec(`(() => {
      const el = document.querySelector("[data-testid=f-title]");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, "cd-autotest-命名");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("[data-testid=f-save]").click();
    })()`);
    await wait(900);
    const namedIds = JSON.parse(await exec(`window.claude.sessionList().then((x) => JSON.stringify(x.filter((s) => s.title === "cd-autotest-命名").map((s) => s.id)))`));
    ok("可选名称已写入", namedIds.length === 1, `n=${namedIds.length}`);
    if (namedIds.length) {
      await exec(`window.claude.sessionDelete(${JSON.stringify(namedIds[0])})`);
      ok("删除命名测试会话", true);
    }

    // 6.3d 会话列表分页:注入 21 个一次性会话 → 分页控件出现 → 翻页内容变化 → 干净删除
    const pageIds = [];
    for (let i = 0; i < 21; i++) {
      const r = JSON.parse(await exec(`window.claude.sessionCreate({ cwd: "/tmp", title: ${JSON.stringify("cd-page-" + i)} }).then((x) => JSON.stringify(x))`));
      if (r && r.id) pageIds.push(r.id);
    }
    await win.loadURL(global.__baseUrl); // 重新进入列表页触发刷新
    await wait(900);
    let pageUi = {};
    for (let i = 0; i < 30; i++) {
      pageUi = await execSafe(`({
        pager: !!document.querySelector("[data-testid=list-pager]"),
        info: (document.querySelector(".pginfo") || { innerText: "" }).innerText.trim(),
        nextDisabled: document.querySelector("[data-testid=page-next]")?.disabled,
      })`, 10000).catch(() => ({}));
      if (pageUi.pager && Object.keys(pageUi).length) break;
      await wait(200);
    }
    ok("分页控件出现(>20条)", !!pageUi.pager, `pager=${JSON.stringify(pageUi)}`);
    const firstPgTitle = await exec(`(document.querySelector("[data-testid=session-item] .title") || { innerText: "" }).innerText.trim()`);
    await execSafe(`document.querySelector("[data-testid=page-next]").click()`, 5000).catch(() => {});
    await wait(300);
    const pageInfo2 = await exec(`(document.querySelector(".pginfo") || { innerText: "" }).innerText.trim()`);
    const secondPgTitle = await exec(`(document.querySelector("[data-testid=session-item] .title") || { innerText: "" }).innerText.trim()`);
    ok("翻到第2页内容变化", pageInfo2.includes("第 2 /") && secondPgTitle !== firstPgTitle, `p1=${firstPgTitle} p2=${secondPgTitle} info=${pageInfo2}`);
    await execSafe(`document.querySelector("[data-testid=page-prev]").click()`, 5000).catch(() => {});
    await wait(300);
    const pageInfoBack = await exec(`(document.querySelector(".pginfo") || { innerText: "" }).innerText.trim()`);
    ok("返回第1页", pageInfoBack.includes("第 1 /"), `info=${pageInfoBack}`);
    // 注入的分页测试会话全部删除
    for (const pid of pageIds) await exec(`window.claude.sessionDelete(${JSON.stringify(pid)})`);
    ok("分页测试会话清理", true);

    // 7. 停止/收尾:删掉测试会话,避免污染用户数据
    await exec(`window.claude.sessionDelete(${JSON.stringify(sid)})`);
    ok("删除会话", true);

    console.log(fails.length === 0 ? "AUTOTEST_OK ALL PASS" : `AUTOTEST_FAIL n=${fails.length}`);
    if (fails.length) console.log("AUTOTEST_FAILED_ITEMS " + JSON.stringify(fails));
    app.quit();
  } catch (err) {
    console.log("AUTOTEST_FAIL EXCEPTION " + String(err && err.stack || err));
    app.exit(1);
  }
}

module.exports = { runAutotest, runTermAutotest, runCloudAutotest };
