<script>
  // 终端视图:点会话即在此目录、套用会话参数,起/附着一个【真实交互 claude】终端(PTY -> xterm 直接渲染)
  // 100% 原版终端手感:权限确认 / /retry /rewind / Ctrl+C / 状态栏 全部由 claude TUI 自己处理,
  // 本组件只做字节流双向透传,不做任何解析——claude 升级渲染风格也不受影响。
  // 附着式(多会话并行):终端生命期由 pty 层管理(结束按钮/删会话/退出才关)。
  //   本组件挂载时若终端已开(同路由切 tab / 离开再回来),terminalOpen 幂等返回本轮原始字节 replay,
  //   先把 replay 画出来,再把缓冲期间到达的实时字节补上,实现无缝重附着。
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { appSettings } from "$lib/stores/settings.svelte.js";

  let { id = "", panelOpen = true } = $props();
  // 终端字体大小走设置(默认 13),设置页改即时生效
  let termFont = $derived(appSettings.terminalFontSize || 13);

  let host = $state(null); // xterm 挂载容器
  let err = $state(""); // 打开失败文案
  let exited = $state(false); // 进程已退出
  let term = null;
  let fit = null;
  let ro = null;
  let unsubscribe = null;
  let mounted = true;
  let lastPushed = ""; // 最近一次显式同步给 pty 的尺寸,避免重复 IPC
  // 附着缓冲:terminalOpen 返回前到达的实时字节先入队,resolve 后先 replay 再补上,保证顺序
  let pending = [];
  let replaying = true;

  // 打开/重连(幂等):进入会话目录+参数,已开则附带本轮原始字节 replay 供重放;
  // 进程退出(Ctrl+C 等)后可点重连,重新 terminalOpen 起一个真实 claude
  function attach() {
    if (!term || !mounted) return;
    err = "";
    exited = false;
    replaying = true;
    pending = [];
    window.claude
      .terminalOpen(id)
      .then((r) => {
        if (r && r.error) {
          err = r.error;
          return;
        }
        if (r && r.replay) {
          term.write(r.replay);
          pushHist(r.replay); // 回放的旧字节也进历史(重附着后仍能回看)
        }
        replaying = false;
        for (const d of pending) {
          term.write(d);
          pushHist(d);
        }
        pending = [];
        // 窗口容器尺寸稳定后 fit 一次(fit 引发的 onResize 会自动同步 pty 行列);
        // 先清空 lastPushed 再补一次 doFit——首轮 fit 早于 pty 会话创建(terminalOpen 异步),
        // 那次 push 是被 no-op 丢弃的,同名尺寸会被去重拦掉,必须此刻显式补推一次才算真正生效
        [0, 80, 300].forEach((ms) => setTimeout(() => { lastPushed = ""; doFit(); }, ms));
      })
      .catch((e) => {
        err = String(e);
      });
  }

  // 顶部「重连」按钮通过全局事件找本会话的视图,复用同一打开流程
  function onReconnect(ev) {
    if (ev && ev.detail && ev.detail.id === id) attach();
  }

  // 工具面板点按钮发命令后,把键盘焦点还给本终端输入行(命令输出直接看,想继续打字直接打)
  function onFocusTerminal(ev) {
    if (!ev || !ev.detail || ev.detail.id !== id) return;
    if (!term || !mounted) return;
    try {
      term.focus();
    } catch {}
  }

  // 显式把当前行列同步到 pty:fit 引发的 onResize 在尺寸未变时不会触发(首轮又发生在
  // onResize 注册前),若不显式推一次,claude 会一直停留在 open 时的默认尺寸(如 30 行),
  // 输入行就悬在窗口中部;隐藏纪要/改窗口尺寸后列宽变化触发 onResize 才会落底——此处补上首推
  function pushSize() {
    if (!term || !mounted) return;
    const k = `${term.cols}x${term.rows}`;
    if (k === lastPushed) return;
    lastPushed = k;
    window.claude.terminalResize(id, term.cols, term.rows);
  }

  function doFit() {
    if (!term || !fit || !mounted) return;
    try {
      fit.fit();
      // fit 成功时也会把计算出的 width/height(可能为 NaN/旧值)内联到 .xterm,强制回铺满容器,
      // 保证终端画面(底部输入行)始终贴住容器底部
      const el = host && host.querySelector(".xterm");
      if (el) {
        el.style.width = "100%";
        el.style.height = "100%";
      }
    } catch {
      // fit 失败(字体未就绪/计量为 0 等):兜底用 proposeDimensions 手动调行数,
      // 不然行数停在默认 24,claude TUI 的输入行会悬在窗口中部、下方留大片空白
      try {
        const d = fit.proposeDimensions();
        if (d && d.rows > 0 && d.cols > 0) term.resize(d.cols, d.rows);
      } catch {}
    }
    pushSize();
    measureRowH();
    rAF(updateScroller);
  }
  // 量取 xterm 一行的真实像素高,回看覆盖层用它对齐行(行距与终端一致,观感才接近真实渲染)
  function measureRowH() {
    if (!host) return;
    const row = host.querySelector(".xterm-rows .xterm-rows .xterm-rows > div");
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h > 0) rowH = h;
    }
  }

  // ---- 滚动 / 历史回看 ----
  // xterm 对 alternate screen(claude TUI 全屏)不保留 scrollback:baseY 恒 0、无历史可滚,
  // 所以「滚动条看不见、滚轮滚不动」不是样式问题而是能力边界。解法:renderer 持续把输出
  // 字节剥 ANSI 存成本地行历史(histLines),滚轮向上进入「回看」——用覆盖层显示历史文本,
  // 滚动条照常出现、可拖动;滚到底或任意按键返回实时画面。
  // 正常 buffer 有 scrollback 时(baseY>0,如 TUI 退出后的 shell 输出)则用行数算滑块,两种场景一套 UI。
  let histLines = $state([]); // 剥 ANSI 后的行文本历史(尾部为最新),cap 3000
  let reviewTop = $state(0); // 回看窗口顶部行(0=最早)
  let reviewing = $state(false); // 是否处于回看覆盖层
  let rowH = $state(0); // 终端的真实行高(px,覆盖层对齐用)
  let sbThumbTop = $state(0); // 滑块 top(%)
  let sbThumbH = $state(0); // 滑块高(%)
  let sbOn = $state(false); // 有可滚内容才出现滑块

  // 简易去 ANSI:剥 CSI/OSC/单字符转义,得到纯文本(足够用于回看展示,不追求字节级还原)
  function stripAnsi(s) {
    return String(s || "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[()][0-9A-Z]/g, "")
      .replace(/\x1b[=>]/, "");
  }
  // 字节 -> 行历史:逐行截断,cap 3000(TUI 每帧全屏重绘会有重复行,保留即可,最近内容始终在尾)。
  // TUI 刷屏多用 \r(回车原地覆盖)而非 \n,先把 \r 归一成 \n 再切分,否则整屏内容粘成一行
  function pushHist(chunk) {
    const txt = stripAnsi(chunk);
    if (!txt) return;
    const lines = String(txt).replace(/\r/g, "\n").split("\n");
    for (let i = 0; i < lines.length - 1; i++) histLines.push(lines[i].replace(/\s+$/, ""));
    if (histLines.length > 5000) histLines = histLines.slice(-3000);
  }

  function enterReview() {
    if (reviewing) return;
    reviewing = true;
    reviewTop = Math.max(0, (histLines.length || 0) - (term?.rows || 40));
    rAF(updateScroller);
  }
  function exitReview() {
    if (!reviewing) return;
    reviewing = false;
    rAF(updateScroller);
  }

  function updateScroller() {
    if (!term || !mounted) return;
    const rows = term.rows || 0;
    if (reviewing) {
      const total = histLines.length;
      sbOn = total > rows && rows > 0;
      if (sbOn) {
        sbThumbTop = (reviewTop / total) * 100;
        sbThumbH = Math.min(100, Math.max(8, (rows / total) * 100));
        if (sbThumbTop + sbThumbH > 100) sbThumbTop = 100 - sbThumbH;
      }
      return;
    }
    // 实时模式:normal buffer 有 scrollback 才显示(alt 无历史,交给回看)
    let len = 0, off = 0;
    try {
      const b = term.buffer.active;
      len = b.baseY + rows;
      off = b.viewportY;
    } catch {
      return;
    }
    sbOn = bHasSb() && len > rows && rows > 0;
    if (sbOn) {
      sbThumbTop = (off / len) * 100;
      sbThumbH = Math.min(100, Math.max(8, (rows / len) * 100));
      if (sbThumbTop + sbThumbH > 100) sbThumbTop = 100 - sbThumbH;
    }
  }
  // 当前 buffer 是否带 xterm scrollback(alt 恒定 false)
  function bHasSb() {
    try {
      return term.buffer.active.type !== "alternate" && term.buffer.active.hasScrollback;
    } catch {
      return false;
    }
  }
  // 滚轮:当前 buffer 已有 xterm scrollback(可滚历史)交给 xterm(scrollSensitivity 已加快);
  // 无历史可滚(alt 全屏 TUI / 内容不足一屏)或正在回看时由我们接管 → 上滚进历史回看
  function onHostWheel(e) {
    if (!term || !mounted) return;
    let hasReal = false;
    try {
      hasReal = term.buffer.active.baseY > 0;
    } catch {}
    if (hasReal && !reviewing) return;
    e.preventDefault();
    const step = Math.max(1, Math.abs(Math.round(e.deltaY)));
    if (e.deltaY > 0) {
      // 向下
      if (reviewing) {
        const m = Math.max(0, histLines.length - term.rows);
        reviewTop = Math.min(m, reviewTop + step);
        if (reviewTop >= m) exitReview();
      }
    } else if (!reviewing) {
      enterReview();
    } else {
      reviewTop = Math.max(0, reviewTop - step);
    }
    rAF(updateScroller);
  }
  // 点轨道/拖滑块:回看时改 reviewTop,实时时回写终端滚动位置
  function onScrollerPointer(e) {
    if (!term || !sbOn) return;
    const r = e.currentTarget.getBoundingClientRect();
    const setFrom = (clientY) => {
      const ratio = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      if (reviewing) {
        const m = Math.max(0, histLines.length - term.rows);
        reviewTop = Math.round(ratio * m);
        if (reviewTop >= m) exitReview();
        return;
      }
      let len = 0;
      try {
        len = term.buffer.active.baseY + term.rows;
      } catch {
        return;
      }
      term.scrollToLine(Math.round(ratio * (len - term.rows)));
    };
    setFrom(e.clientY);
    const move = (ev) => setFrom(ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const rAF = (fn) => requestAnimationFrame(fn);
  const rAFSb = () => rAF(updateScroller);

  onMount(() => {
    if (!host) return;
    term = new Terminal({
      cursorBlink: true,
      fontSize: termFont,
      scrollback: 5000,
      // 滚轮灵敏度:xterm6 走 scrollSensitivity(旧 wheelSensitivity 已废弃,之前设了也不生效,
      // 这就是滚轮慢的根因);6 = 默认灵敏度下滚多少翻 6 倍,滚起来明显跟手
      scrollSensitivity: 6,
      // 滚动条宽度:由 overviewRuler.width 控制,默认 14(Win 上偏宽),压到 8 统一细条;
      // 滑块颜色在 theme 里调亮(xterm6 默认是前景色 20% 透明度,深底下几乎看不见)
      overviewRuler: { width: 8 },
      fontFamily: 'ui-monospace, Menlo, Consolas, "Cascadia Mono", monospace',
      // 配色与全局暗色主题(#0d1117)一致
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(88,166,255,.28)",
        black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#d29922",
        blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#e6edf3",
        scrollbarSliderBackground: "#6e7681",
        scrollbarSliderHoverBackground: "#8b949e",
        scrollbarSliderActiveBackground: "#8b949e",
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // 自测句柄:autotest 用它往终端注入字节以制造可滚历史(验证自绘滚动条)并读取 buffer 状态
    window.__cdTermWrite = (d) => { try { term.write(d); } catch {} };
    window.__cdTerm = term;
    // 首轮 fit:容器可能刚布局完/字体未就绪,多轮补算(拉长间隔覆盖冷字体/慢布局),确保行数填满窗口
    doFit();
    [60, 240, 700, 1500, 3000].forEach((ms) => setTimeout(doFit, ms));

    // 附着缓冲:terminalOpen 返回前到达的实时字节先入队,resolve 后先 replay 再补上,保证顺序
    pending = [];
    replaying = true;

    // 用户输入 -> 主进程 pty;尺寸变化 -> 同步 pty 行列(与 doFit 后的显式同步共用 pushSize);
    // 回看中敲任何键都先退出回看,恢复实时画面与输入
    term.onData((d) => {
      if (reviewing) exitReview();
      window.claude.terminalWrite(id, d);
    });
    term.onResize(() => pushSize());

    // 全局终端事件按会话过滤;组件卸载时退订
    unsubscribe = window.claude.onTerminal((ev) => {
      if (!ev || ev.id !== id) return;
      if (ev.type === "data") {
        window.__termBytes = (window.__termBytes || 0) + ev.data.length;
        if (replaying) pending.push(ev.data);
        else term.write(ev.data);
        pushHist(ev.data); // 输出字节持续进历史(回看数据源)
      } else if (ev.type === "exit") onExit(ev.exitCode, ev.reason);
    });

    // 每批字节解析完成 + 滚动变化时,刷新自绘滚动条的滑块位置/可见性
    term.onWriteParsed(() => rAFSb());
    term.onScroll(() => rAFSb());

    // 滚轮接管:normal buffer 有历史交给 xterm,alt/回看时我们自己翻历史
    host.addEventListener("wheel", onHostWheel, { capture: true, passive: false });

    // 打开(幂等):进入该会话目录 + 参数,已开则附带本轮 replay 供重放;
    // 顶部/退出提示条的「重连」按钮也走同一 attach;工具面板发命令后聚焦也在此收口
    attach();
    window.addEventListener("cd-reconnect", onReconnect);
    window.addEventListener("cd-focus-terminal", onFocusTerminal);

    // 窗口/容器变化时重新 fit(同时观察自身与父容器,宽度/高度变化都能触发)
    ro = new ResizeObserver(() => doFit());
    if (host.parentElement) ro.observe(host.parentElement);
    ro.observe(host);
  });

  // 右侧纪要面板开合会改变终端列宽,重算 fit
  $effect(() => {
    if (panelOpen === undefined) return;
    const t = setTimeout(doFit, 60);
    return () => clearTimeout(t);
  });

  // 设置页改终端字体大小:即时生效 + 重新 fit 同步 pty 行列(字符宽变化,行列会变)
  $effect(() => {
    const v = termFont;
    if (!term) return;
    try {
      term.setOption("fontSize", v);
    } catch {}
    const t = setTimeout(doFit, 80);
    return () => clearTimeout(t);
  });

  function onExit(exitCode, reason) {
    exited = true;
    const why = reason || (exitCode === 0 ? "正常退出" : `退出码 ${exitCode}`);
    term.write(`\r\n\x1b[33m[进程已结束：${why}]\x1b[0m\r\n`);
  }

  onDestroy(() => {
    mounted = false;
    window.removeEventListener("cd-reconnect", onReconnect);
    window.removeEventListener("cd-focus-terminal", onFocusTerminal);
    if (host) host.removeEventListener("wheel", onHostWheel);
    if (unsubscribe) unsubscribe();
    if (ro) ro.disconnect();
    if (term) {
      try {
        term.dispose();
      } catch {}
    }
    // 注意:这里不 terminalClose——多会话并行,切页不杀真实 claude(由「结束终端」/删会话/退出负责)
  });
</script>

<div class="wrap">
  {#if err}
    <div class="errbar" data-testid="term-err">⚠ {err}</div>
  {:else}
    <div class="host" bind:this={host}>
      {#if reviewing}
        <!-- 回看层:覆盖终端显示历史文本(TUI 全屏 no scrollback,历史由我们自存) -->
        <div class="review" data-testid="terminal-review" style="--rowH:{rowH || 15}px;--rows:{term ? term.rows : 24}">
          <div class="rev-inner">
            {#each histLines.slice(reviewTop, reviewTop + (term ? term.rows : 24)) as ln, i (reviewTop + i)}
              <div class="rl">{ln}</div>
            {/each}
            <div class="rev-tip">↑ 历史回看 · 滚轮到底 / 按任意键返回实时</div>
          </div>
        </div>
      {/if}
      {#if sbOn}
        <!-- 自绘滚动条:实时模式走 buffer scrollback,回看模式走历史行数;拖轨道/滑块可快速定位 -->
        <div class="sb" data-testid="terminal-scroller" onpointerdown={onScrollerPointer} title="拖动定位">
          <i class="thumb" style="top:{sbThumbTop}%;height:{sbThumbH}%"></i>
        </div>
      {/if}
    </div>
    {#if exited}
      <div class="exitbar" data-testid="term-exit">
        <span>■ 进程已结束(Ctrl+C 等可能使 claude 退出)</span>
        <button class="reconnect" data-testid="term-reconnect" onclick={attach} title="重新打开该会话的终端,恢复工作">⟳ 重连</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .wrap { position: relative; height: 100%; display: flex; flex-direction: column; background: #0d1117; }
  .host { position: relative; flex: 1 1 auto; min-height: 0; padding: 6px 8px 0; }
  .host :global(.xterm) { height: 100%; }
  /* 禁用 xterm 自绘滚动条(monaco slider 在 alt 屏恒 0 高失效,且与我们自绘条重复),统一用 .sb */
  .host :global(.xterm-scrollable-element > .scrollbar) { display: none !important; }
  /* 回看覆盖层:等宽字体按终端行距逐行渲染历史,顶层盖住实时画面,文本区不拦截指针(滚轮/点击穿透到终端) */
  .host .review { position: absolute; inset: 6px 8px 0; z-index: 4; background: #0d1117; overflow: hidden; font-family: ui-monospace, Menlo, Consolas, "Cascadia Mono", monospace; font-size: 13px; line-height: 1; }
  .host .review .rev-inner { position: absolute; top: 0; left: 0; right: 6px; color: #e6edf3; }
  .host .review .rl { height: var(--rowH); line-height: var(--rowH); white-space: pre; overflow: hidden; text-overflow: clip; }
  .host .review .rev-tip { color: #8b949e; font-size: 11px; height: var(--rowH); line-height: var(--rowH); border-top: 1px solid #21262d; }
  /* 自绘滚动条(覆盖在终端右侧,统一实时/回看两种模式):细轨道 + 按比例滑块,平时半透明,悬停加亮 */
  .host .sb { position: absolute; right: 3px; top: 8px; bottom: 8px; width: 6px; z-index: 5; border-radius: 3px; cursor: pointer; }
  .host .sb:hover { background: rgba(255,255,255,.06); }
  .host .sb .thumb { position: absolute; left: 0; right: 0; background: #6e7681; border-radius: 3px; opacity: .6; }
  .host .sb:hover .thumb { opacity: 1; background: #8b949e; }
  .errbar { color: #ff7b72; padding: 12px 16px; font-size: 13px; }
  .exitbar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; color: #8b949e; font-size: 12px; padding: 3px 12px; border-top: 1px solid #21262d; background: #161b22; }
  .reconnect { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 3px 12px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .reconnect:hover { color: var(--accent); border-color: var(--accent); }
</style>
