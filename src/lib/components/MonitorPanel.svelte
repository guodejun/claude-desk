<script>
  // 右侧工具面板:把常用 claude 斜杠命令做成按钮。点哪个按钮就把命令(带回车)直接写入
  // 当前会话的真实终端(pty.write),输出与后续交互都在主窗口终端里进行——
  // 不捕获输出、不自动执行(打开面板不会触发任何命令)。「/tunnel」是特例:打开对话队列弹窗
  // 底部为上下文监控:主进程读该会话 jsonl 的 usage(精确)或字符估算兜底,2s 轮询刷新
  import { onMount, onDestroy } from "svelte";
  import { ask } from "$lib/stores/dialog.svelte.js";
  import TunnelDialog from "$lib/components/TunnelDialog.svelte";

  let { id = "" } = $props();
  let tunnelOpen = $state(false);
  let ctx = $state(null); // { used, max, pct, source, hitRate, ... }
  let timer = null;
  let maxInput = $state(""); // 上限输入框(允许 200000 / 240k / 1m;空=自动)
  let maxDirty = $state(false); // 用户正在编辑时,poll 不覆盖输入框内容
  let maxErr = $state("");
  let cliPinned = $state(false); // 已按 claude /context 实测读数锁定,poll 不再覆盖
  let cliErr = $state("");
  let cliClue = $state(""); // 解析失败时的 /context 视图片段,方便排查

  // 支持「200000 / 240k / 1m / 」格式,空串返回 0(自动);非法返回 NaN
  function parseMax(v) {
    const s = (v || "").trim().toLowerCase();
    if (!s) return 0;
    const t = /^(\d+(?:\.\d+)?)([kmg]?)$/.exec(s);
    if (!t) return NaN;
    const n = parseFloat(t[1]);
    const u = t[2] || "";
    if (u === "m") return Math.round(n * 1_000_000);
    if (u === "g") return Math.round(n * 1_000_000_000);
    if (u === "k") return Math.round(n * 1000);
    return Math.round(n);
  }

  async function pollCtx() {
    if (cliPinned || !id) return; // 已锁定为 claude 实测读数时,停止 jsonl 轮询覆盖
    try {
      const c = await window.claude.contextState(id);
      if (c && !c.error) {
        ctx = c;
        if (!maxDirty) maxInput = c.maxText;
      }
    } catch {}
  }

  // 与 claude 原版对齐:向终端发 /context 的同时,把它报告的「已用/窗口」解析回面板并锁定
  async function syncCli() {
    cliErr = "";
    cliClue = "";
    const t = await window.claude.contextCli(id).catch(() => null);
    if (!t) return;
    if (t.ok) {
      ctx = {
        used: t.used, max: t.max, pct: t.pct,
        manual: t.manual, usedText: t.usedText, maxText: t.maxText,
        fromCli: true, cliPct: Math.round(t.cliPct ?? (t.pct * 100)),
      };
      cliPinned = true;
    } else {
      cliErr = t.error || "解析失败,请到终端查看 /context";
      cliClue = t.clue || "";
    }
  }
  // 恢复自动:回到 jsonl 精确/估算轮询
  function unpinCli() {
    cliPinned = false;
    cliErr = "";
    cliClue = "";
    pollCtx();
  }

  // 保存手动上限:写入会话(maxTokens),恢复自动则置 0 删除字段
  async function saveMax() {
    maxErr = "";
    let n = parseMax(maxInput);
    if (Number.isNaN(n)) { maxErr = "格式:200000 / 240k / 1m"; return; }
    try {
      await window.claude.sessionUpdate(id, { maxTokens: n });
    } catch (e) { maxErr = String(e); return; }
    maxDirty = false;
    maxInput = n > 0 ? (n >= 1e6 ? Math.round(n / 1e6) + "m" : n.toLocaleString("en-US")) : "自动";
    if (cliPinned && ctx) {
      // 已锁定 claude 读数:窗口换成手动上限,used 不变,百分比按新窗口重算
      ctx = { ...ctx, max: n, maxText: n > 0 ? (n >= 1e6 ? Math.round(n / 1e6) + "m" : n.toLocaleString("en-US")) : ctx.maxText, pct: ctx.used / (n || 1), manual: n > 0 };
    } else {
      pollCtx();
    }
  }

  onMount(() => {
    pollCtx();
    timer = setInterval(pollCtx, 2000);
  });
  onDestroy(() => { if (timer) clearInterval(timer); });

  const LV = $derived.by(() => {
    const p = (ctx && ctx.pct) || 0;
    return p >= 0.75 ? "danger" : p >= 0.5 ? "warn" : "ok";
  });
  const pctW = $derived(Math.min(100, Math.round(((ctx && ctx.pct) || 0) * 100)) + "%");

  // 常用命令按钮:命令文本 + 一句话功能说明(参考 claude 斜杠命令表);/tunnel 放最后
  const CMDS = [
    { c: "/context", d: "上下文用量占比" },
    { c: "/context all", d: "上下文用量全部明细" },
    { c: "/compact", d: "压缩上下文,释放 token" },
    { c: "/clear", d: "清空对话历史", danger: true },
    { c: "/resume", d: "恢复/切换历史会话" },
    { c: "/memory", d: "编辑 CLAUDE.md" },
    { c: "/status", d: "模型/用量/时长概览" },
    { c: "/cost", d: "token 消耗与费用" },
    { c: "/stats", d: "会话统计数据" },
    { c: "/rewind", d: "回退到对话节点", danger: true },
    { c: "/init", d: "生成项目 CLAUDE.md" },
    { c: "/model", d: "切换模型" },
    { c: "/tunnel", d: "对话队列(逐条自动接力)", tunnel: true },
  ];

  // 点击 → 命令直接发进主终端(结果在终端窗口里显示,交互类命令到终端里继续);
  // 清空/回退先弹确认防误触,其余直接执行;
  // 发完把焦点还给主终端输入行(blur 到 tool 按钮上会挡住继续打字,立即归位)
  async function onClick(cmd) {
    if (cmd === "/tunnel") {
      tunnelOpen = true; // 队列入口:打开弹窗,不是终端命令
      return;
    }
    if (cmd === "/clear" && !(await ask("清空对话历史？", "将清空该会话的对话历史从零开始（仅保留项目文件与 CLAUDE.md），且不可恢复。", "清空"))) return;
    if (cmd === "/rewind" && !(await ask("回退对话？", "将回退到之前的对话节点，回退点之后的内容会作废。请到终端中确认具体回退位置。", "回退"))) return;
    if (cmd === "/context") {
      await syncCli(); // 内部已把 /context 写进终端并解析读数,避免双写干扰
      window.dispatchEvent(new CustomEvent("cd-focus-terminal", { detail: { id } }));
      return;
    }
    window.claude.terminalWrite(id, cmd + "\r");
    window.dispatchEvent(new CustomEvent("cd-focus-terminal", { detail: { id } }));
  }
</script>

<section class="panel" data-testid="tools-panel">
  <header class="hd">
    <span>🧰 工具</span>
  </header>

  <div class="grid">
    {#each CMDS as m (m.c)}
      <button class="cmd {m.danger ? 'danger' : ''}" data-testid="tool-btn" onclick={() => onClick(m.c)} title={m.c}>
        <span class="c">{m.c}</span>
        <span class="d">{m.d}</span>
      </button>
    {/each}
  </div>

  <!-- 底部:上下文监控(现在/最大)。数据来自主进程读 jsonl usage(精确)或估算;超 75% 提醒压缩 -->
  {#if ctx}
    <div class="ctx" data-testid="context-usage">
      <div class="ctx-head">
        <span class="ctx-label">上下文</span>
        <span class="ctx-num">{ctx.usedText}<span class="sep">/</span>{ctx.maxText}</span>
        <span class="ctx-pct {LV}">({Math.round(ctx.pct * 100)}%)</span>
        <span class="badge {ctx.source}">{ctx.source === "jsonl" ? "精确" : ctx.source === "cli" ? "claude" : "估算"}</span>
      </div>
      <div class="ctx-bar {LV}" data-testid="context-bar"><i style="width: {pctW}"></i></div>
      {#if ctx.fromCli}
        <div class="ctx-sub">
          claude /context 实测读数({ctx.cliPct}%)
          <button class="link2" data-testid="ctx-unpin" onclick={unpinCli}>恢复自动</button>
        </div>
      {:else if cliErr}
        <div class="ctx-sub err" title={cliClue || ""}>{cliErr}{#if cliClue}<br /><span class="clue">{cliClue}</span>{/if}</div>
      {:else if ctx.note}
        <div class="ctx-sub" title="本机 claude 未把 token 写入会话日志,以下为近似值;点上方 /context 可看精确用量">{ctx.note}</div>
      {:else if ctx.hitRate > 0}
        <div class="ctx-sub">缓存命中 {Math.round(ctx.hitRate * 100)}%</div>
      {/if}
      <!-- 手动调整窗口上限:支持 200000 / 240k / 1m,留空=按模型自动解析 -->
      <div class="ctx-set">
        <span class="ctx-label">上限</span>
        <input
          class="maxin"
          data-testid="ctx-max-input"
          bind:value={maxInput}
          oninput={() => (maxDirty = true)}
          placeholder="自动"
          title="上下文窗口上限;留空自动按模型解析,支持 200000 / 240k / 1m"
        />
        <button class="mini" data-testid="ctx-max-save" onclick={saveMax}>设置</button>
        {#if ctx.manual}
          <span class="badge manual" title="会话手动指定上限">手动</span>
        {/if}
        {#if maxErr}
          <span class="ctx-max-err" data-testid="ctx-max-err">⚠ {maxErr}</span>
        {/if}
      </div>
      {#if ctx.pct >= 0.75}
        <div class="ctx-warn" data-testid="context-warn">⚠ 接近上限，建议 /compact 压缩上下文</div>
      {/if}
    </div>
  {:else}
    <div class="ctx-empty" data-testid="context-usage">上下文监控加载中…</div>
  {/if}
</section>

{#if tunnelOpen}
  <TunnelDialog {id} open={tunnelOpen} onClose={() => (tunnelOpen = false)} />
{/if}

<style>
  .panel { height: 100%; display: flex; flex-direction: column; min-width: 0; }
  .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); color: var(--text); font-weight: 600; flex: 0 0 auto; }

  /* 命令按钮网格 */
  .grid { flex: 0 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 12px 6px; }
  .cmd { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text2); cursor: pointer; text-align: left; min-width: 0; }
  .cmd:hover:not(:disabled) { border-color: var(--accent); background: var(--hover); }
  .cmd:hover:not(:disabled) .c { color: var(--accent); }
  .cmd:disabled { opacity: .5; cursor: not-allowed; }
  .cmd.danger .c { color: var(--danger); }
  .cmd .c { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; }
  .cmd .d { font-size: 11px; color: var(--muted); line-height: 1.4; }

  /* 底部:上下文监控(现在/最大),margin-top:auto 让它在 flex 列里沉到面板最底,
     按钮区高度不足时中间留白 */
  .ctx { flex: 0 0 auto; margin-top: auto; padding: 10px 12px 12px; border-top: 1px solid var(--border); background: var(--bg); }
  .ctx-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .ctx-label { color: var(--muted); }
  .ctx-num { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 600; color: var(--text); }
  .ctx-num .sep { color: var(--muted2); font-weight: 400; margin: 0 2px; }
  .ctx-pct { font-size: 11px; font-weight: 600; }
  .ctx-pct.ok { color: var(--ok); }
  .ctx-pct.warn { color: #d29922; }
  .ctx-pct.danger { color: var(--danger); }
  .badge { font-size: 10px; color: var(--muted2); border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 6px; }
  .badge.jsonl { color: var(--ok); }
  .ctx-bar { height: 4px; border-radius: 2px; background: var(--border); margin-top: 6px; overflow: hidden; }
  .ctx-bar i { display: block; height: 100%; border-radius: 2px; background: var(--ok); transition: width .4s; }
  .ctx-bar.warn i { background: #d29922; }
  .ctx-bar.danger i { background: var(--danger); }
  .ctx-sub { font-size: 11px; color: var(--muted2); margin-top: 4px; }
  .ctx-sub.err { color: var(--danger); }
  .ctx-sub .clue { font-size: 10px; color: var(--muted2); word-break: break-all; }
  .ctx-sub .link2 { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 11px; padding: 0 0 0 4px; text-decoration: underline; }
  .ctx-set { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
  .ctx-set .maxin { flex: 0 0 96px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px; padding: 3px 8px; }
  .ctx-set .maxin:focus { outline: none; border-color: var(--accent); }
  .ctx-set .mini { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
  .ctx-set .mini:hover { color: var(--accent); border-color: var(--accent); }
  .badge.manual { color: var(--accent); border-color: var(--accent); }
  .ctx-max-err { font-size: 11px; color: var(--danger); }
  .ctx-warn { font-size: 11px; color: var(--danger); margin-top: 6px; }
  .ctx-empty { flex: 1 1 auto; display: flex; align-items: flex-end; padding: 10px 12px 12px; color: var(--muted2); font-size: 11px; }
</style>
