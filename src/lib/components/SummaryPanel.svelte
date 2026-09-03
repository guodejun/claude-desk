<script>
  // 右侧会话纪要面板:默认视图是「问答总结」——把实录交给真实 claude,逐条摘成
  //   【时间】👤 用户问题
  //   🤖 回答要旨
  // 的紧凑条目(比原始实录/长篇 Markdown 文档好读)。顶部开关在「总结 / 实录」两视图间
  // 切换:切到实录可看清洗后的原始对话(带 ❯ 提问行),两者互斥。
  // 数据源:pty 层捕获的 session.transcript(节流落盘)+ 运行中实时实录(生成总结时优先)。
  import { onMount, onDestroy } from "svelte";
  import { list } from "$lib/stores/sessions.svelte.js";

  let { id = "" } = $props();

  let meta = $derived(list.items.find((s) => s.id === id));
  let full = $state(null); // sessionGet 全量(含 transcript)
  let view = $state("summary"); // 'summary'(问答总结) | 'raw'(原始实录)
  let digest = $state({ loading: false, text: "", error: "" });
  let preEl = $state(null);
  let stickBottom = $state(true); // 实录视图下,用户没上翻时自动跟随滚动到底

  function refresh() {
    if (!id) return Promise.resolve();
    return window.claude
      .sessionGet(id)
      .then((s) => {
        full = s || full;
      })
      .catch(() => {});
  }

  // 实录变化时自动滚到底;用户上翻则暂停跟随(下次贴底恢复)
  function onScroll() {
    if (!preEl) return;
    const el = preEl;
    stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  $effect(() => {
    if (full?.transcript && stickBottom && preEl) {
      preEl.scrollTop = preEl.scrollHeight;
    }
  });

  // 生成/刷新问答总结(增量持久化):直接把已持久化纪要当初始文本(点开面板秒出、不重新生成),
  // 再调主进程 ai-summary —— 有新增只把新增段交给 claude 追加,无新增(force=false)直接返回已有文本。
  async function genDigest(force = false) {
    if (!id || digest.loading) return;
    digest = { loading: true, text: digest.text || "", error: "" };
    try {
      const r = await window.claude.aiSummary(id, force);
      if (r.ok) digest = { loading: false, text: r.text || "", error: "" };
      else digest = { loading: false, text: "", error: r.error || "生成失败" };
    } catch (e) {
      digest = { loading: false, text: digest.text || "", error: String(e) };
    }
  }

  // —— 自动摘要:一轮【用户提问 → claude 答完】后追加增量 ——
  // 触发判定:① pty 检测到用户提交过提问(回车,lastUserAt) ② 且这轮有真实回答输出(hadActivity)
  // ③ 且输出已停滞(STALL_MS,claude 答完/空闲)—— 即「我问完、claude 回答完之后」才总结。
  // 相比旧的「任一输出停滞就总结」:机器自己发起提问/TUI 空闲吐状态栏都不会误触发。
  // claude TUI 空闲期每几秒会吐 31-73B 状态栏字节,所以用「>8s 完全无输出」判一轮结束。
  const STALL_MS = 8000;
  let lastData = 0;
  let hadActivity = false; // 本段有真实输出活动(回答量级才算)
  let autoTimer = null;
  let lastAutoDigest = 0; // 已自动总结过的「用户提交时刻」,防重复/留痕

  // 实录行分类:时间分隔 / 用户输入(❯) / 正文 / 空行
  let rows = $derived(
    (full?.transcript || "")
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t) return { kind: "blank", text: "" };
        if (t.startsWith("[ --- 终端实录")) return { kind: "time", text: t };
        if (t.startsWith("❯")) return { kind: "prompt", text: t.replace(/^❯\s*/, "") };
        return { kind: "text", text: t };
      })
  );
  let hasContent = $derived(rows.some((r) => r.kind === "prompt" || r.kind === "text"));

  let timer = null;
  let un = null;
  onMount(() => {
    // 首屏:先拉会话(带回已持久化纪要),有实录内容就增量请求一次 —— 已总结过则主进程
    // 比对 lastLen 无新增直接秒回,不再全量重新生成
    refresh().then(() => {
      if (full?.summary?.text && !digest.text) digest = { loading: false, text: full.summary.text, error: "" };
      if (view === "summary" && full?.transcript) setTimeout(() => genDigest(), 150);
    });
    // 运行中每 4s 刷新实录;另起 2s 计时器做停滞检测 → 一轮答完自动追加增量总结
    timer = setInterval(() => {
      if (meta?.running) refresh();
    }, 4000);
    autoTimer = setInterval(async () => {
      if (!hadActivity || view !== "summary" || digest.loading) return;
      // 必须「用户提交过提问」且是新的(未总结过):机器自发活动不算
      const at = await window.claude.terminalLastInputAt(id).catch(() => 0);
      if (!at || at <= lastAutoDigest) return;
      // 该提问对应的一轮输出必须已停滞(答完);还有新输出说明 claude 可能在答
      if (Date.now() - lastData < STALL_MS) return;
      lastAutoDigest = at; // 留痕:此提问已总结,下轮不再重复
      hadActivity = false;
      genDigest();
    }, 2000);
    un = window.claude.onTerminal((ev) => {
      if (!ev || ev.id !== id) return;
      refresh();
      if (ev.type === "data") {
        lastData = Date.now();
        if ((ev.data || "").length >= 100) hadActivity = true; // 真实回答量级的输出才记活动
      } else if (ev.type === "exit" || ev.type === "open") {
        // 终端退出/新开一步,对话可能已变,自动补摘一次(增量)
        if (view === "summary") setTimeout(() => genDigest(), 300);
      }
    });
    return () => {
      if (timer) clearInterval(timer);
      if (autoTimer) clearInterval(autoTimer);
      if (un) un();
    };
  });

  // 切会话(同路由)时惰性刷新——key 已强制重挂,这里兜底一次
  $effect(() => {
    if (id) refresh();
  });

  function fmtTS(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
</script>

<section class="panel" data-testid="summary-panel">
  <header class="hd">
    <span>📋 会话纪要</span>
    <div class="seg" data-testid="summary-toggle">
      <button class="op {view === 'summary' ? 'on' : ''}" data-testid="summary-view-summary" onclick={() => (view = "summary")} title="问答总结(默认)">✨ 总结</button>
      <button class="op {view === 'raw' ? 'on' : ''}" data-testid="summary-view-raw" onclick={() => (view = "raw")} title="原始实录(清洗后对话)">📜 实录</button>
    </div>
  </header>

  <!-- 会话信息 -->
  <div class="info">
    <div class="row"><span class="k">状态</span><span class="v {meta?.running ? 'run' : ''}">{meta?.running ? "运行中" : "已结束"}</span></div>
    <div class="row"><span class="k">目录</span><span class="v mono">{meta?.cwd || "…"}</span></div>
    <div class="row"><span class="k">参数</span><span class="v mono">{meta?.argText || "（无）"}</span></div>
    <div class="row"><span class="k">更新</span><span class="v">{fmtTS(meta?.updatedAt)}</span></div>
  </div>

  <div class="list">
    {#if view === 'summary'}
      {#if digest.loading}
        <div class="hint">正在生成问答总结…（真实 claude 调用，实录越长越慢）</div>
      {:else if digest.error}
        <div class="err">{digest.error}</div>
        <button class="mini" onclick={() => genDigest()}>重试生成</button>
      {:else if digest.text}
        <div class="digest" data-testid="summary-digest">{digest.text}</div>
        <button class="mini" data-testid="summary-regen" onclick={() => genDigest(true)}>{digest.text.includes("暂无问答内容") ? "生成总结" : "↻ 重新总结"}</button>
      {:else}
        <p class="hint">还没有总结。{hasContent ? "点下方按钮生成：立即把实录摘要成「提问+回答要旨」。" : "打开终端产生对话后，会在这里自动生成问答总结。"}</p>
        {#if hasContent}
          <button class="mini" data-testid="summary-regen" onclick={() => genDigest(true)}>✦ 生成总结</button>
        {/if}
      {/if}
    {:else}
      <div class="sec-t">📜 实录</div>
      {#if !rows.length}
        <p class="hint" data-testid="transcript">打开终端后，对话输出会实时记录在这里。</p>
      {:else if !hasContent}
        <p class="hint" data-testid="transcript">当前会话还没有实际对话内容（TUI 欢迎页与状态栏已自动过滤）。</p>
      {:else}
        <div ref={preEl} class="rows" data-testid="transcript" onscroll={onScroll}>
          {#each rows as r, i (i)}
            {#if r.kind === "time"}
              <div class="time">{r.text}</div>
            {:else if r.kind === "prompt"}
              <div class="prompt" title="你">你:{r.text}</div>
            {:else if r.kind === "text"}
              <div class="txt">{r.text}</div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .panel { height: 100%; display: flex; flex-direction: column; min-width: 0; }
  .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); color: var(--text); font-weight: 600; flex: 0 0 auto; }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; }
  .op { background: none; border: none; color: var(--muted); padding: 3px 10px; font-size: 12px; cursor: pointer; }
  .op + .op { border-left: 1px solid var(--border-strong); }
  .op:hover { color: var(--text); }
  .op.on { background: var(--sel-bg); color: var(--accent); }

  .info { flex: 0 0 auto; padding: 6px 14px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 3px; }
  .row { display: flex; gap: 8px; font-size: 12px; min-width: 0; }
  .k { color: var(--muted); flex: 0 0 30px; }
  .v { color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v.run { color: var(--ok); }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }

  .list { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; }
  .sec-t { font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
  .hint { color: var(--muted); font-size: 13px; }
  .err { color: var(--danger); font-size: 13px; margin-bottom: 8px; }
  .mini { background: var(--border); border: 1px solid var(--border-strong); color: var(--accent); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; margin-top: 8px; }
  .mini:hover { border-color: var(--accent); }

  /* 问答总结:原样保留 claude 生成的 👤/🤖 条目,保留换行与缩进 */
  .digest { color: var(--text2); font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }

  /* 实录:行式排版(时间分隔 / 你-输入 / 正文),等宽紧凑可滚动 */
  .rows { max-height: 100%; overflow-y: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
  .time { color: var(--muted2); font-size: 11px; text-align: center; margin: 8px 0 4px; letter-spacing: .3px; }
  .rows .time:first-child { margin-top: 0; }
  .prompt { color: var(--text); font-weight: 600; margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
  .prompt::before { content: "❯ "; color: var(--accent); }
  .txt { color: var(--text2); white-space: pre-wrap; word-break: break-word; margin-top: 4px; }
</style>
