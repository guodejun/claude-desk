<script>
  // 对话区:终端式渲染(非气泡)
  // - 用户消息:❯ 前缀
  // - Claude:白色正文(marked md)、工具调用 ◢ 命令卡、思考折叠(流式'思考中…'/完成可展开)
  // - 工具执行结果独立块:└─ 输出/报错/diff 高亮,长文截断可展开
  // - 打字机:busy 期间 text 逐字出现,结束后立即补全文;近底才自动滚动(不打扰上翻查看)
  import { onMount, onDestroy } from "svelte";
  import { marked } from "marked";
  let { messages = [], busy = false } = $props();
  let scrollEl = $state(null);

  function renderMd(text) {
    try {
      return marked.parse(text || "");
    } catch {
      return (text || "").replace(/</g, "&lt;");
    }
  }

  // 全局是否已出现任何 text 回复:thinking 块常在独立 assistant 消息里(不同 messageId),
  // 故不能只看当前消息,要看整个对话——一旦出现 text,所有 thinking 折叠为"思考过程"
  let anyText = $derived(
    (messages || []).some((m) => m.role === "assistant" && (m.blocks || []).some((b) => b.type === "text"))
  );

  // 工具输入预览:字符串原样,对象 JSON 紧凑展示
  function toolPreview(b) {
    const inp = b.input;
    if (!inp) return "";
    if (typeof inp === "string") return inp;
    try {
      return JSON.stringify(inp, null, 2).slice(0, 1500);
    } catch {
      return String(inp).slice(0, 1500);
    }
  }

  // ---- 打字机 ----
  // stream 每来一块 text 都是"完整文本"的新对象,所以按字符递增、被最新文本长度钳制:
  // 单调递增展示量,块换新不会闪回。busy 结束立即补全文(自测轮询到结果即可命中)。
  let typing = $state(0);
  let curTb = $state(null); // 正在打字的 text 块(引用,用于渲染层判断该截哪块)
  let curTbText = $state("");
  let typingLive = $state(false);
  let lastTool = $state(null); // 当前辅助消息里最后一个 tool 块引用 → 标注"运行中"

  $effect(() => {
    const m = messages || [];
    const last = m[m.length - 1];
    let tb = null;
    let tbb = null;
    if (busy && last && last.role === "assistant") {
      const blocks = last.blocks || [];
      tb = [...blocks].reverse().find((b) => b.type === "text") || null;
      tbb = [...blocks].reverse().find((b) => b.type === "tool") || null;
    }
    const text = (tb && tb.text) || "";
    curTb = tb;
    curTbText = text;
    lastTool = tbb;
    typingLive = !!tb;
    if (!tb) typing = text.length;
    else if (typing > text.length) typing = text.length; // 收缩钳制(理论不发生)
    else if (!busy) typing = text.length;
  });

  let tick = null;
  onMount(() => {
    tick = setInterval(() => {
      if (typingLive && curTbText) {
        typing = Math.min(typing + 2, curTbText.length); // 每 16ms 两个字
      }
      stickBottom();
    }, 16);
  });
  onDestroy(() => tick && clearInterval(tick));

  // 近底才滚动:打字/stream 过程中贴底自动跟随,用户上翻查看历史时不打扰
  function stickBottom() {
    if (!scrollEl) return;
    const near = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
    if (near) scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  $effect(() => {
    void messages;
    void busy;
    stickBottom();
  });

  // ---- 工具结果:截断/展开 + 轻量 diff 高亮 ----
  const OUT_CAP = 200000; // 单块展示上限(字符),超出折叠
  let cutOpen = $state(new Set()); // 已展开完整内容的 tool-result 标识
  function outInfo(b) {
    const raw = (b.text || "").trimEnd();
    const over = raw.length > OUT_CAP;
    const id = b.toolUseId || raw.slice(0, 48);
    return { id, over, raw, excess: raw.length - OUT_CAP };
  }
  function looksLikeDiff(t) {
    const head = t.slice(0, 500);
    return head.includes("diff --git") || head.includes("@@ -") || head.includes("\n+++ ");
  }
  function toggleCut(id) {
    const s = new Set(cutOpen);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    cutOpen = s;
  }
  function diffLines(t) {
    return t.split("\n").map((ln) => ({
      text: ln,
      add: ln.startsWith("+") && !ln.startsWith("+++"),
      del: ln.startsWith("-") && !ln.startsWith("---"),
      meta: ln.startsWith("@@") || ln.startsWith("+++") || ln.startsWith("---"),
    }));
  }
</script>

<section class="term" bind:this={scrollEl}>
  {#if messages.length === 0}
    <div class="empty">
      <div class="empty-logo">◆</div>
      <h2>Claude Desk</h2>
      <p>在下方输入消息 · 底层即真实 claude</p>
    </div>
  {/if}

  {#each messages as m (m)}
    {#if m.role === "user"}
      <div class="u" data-testid="bubble-you">
        <span class="prompt">❯</span>
        <span class="utext">{m.text}</span>
      </div>
      <div class="gap"></div>
    {:else if m.role === "ui"}
      {#each m.blocks || [] as b (b)}
        {#if b.type === "error"}
          <div class="err" data-testid="bubble-error">{b.text}</div>
        {/if}
      {/each}
    {:else}
      <div class="a" data-testid="bubble-ai">
        {#each m.blocks || [] as b (b)}
          {#if b.type === "thinking"}
            {#if !anyText}
              <div class="thinking" data-testid="block-thinking">💭 思考中…</div>
            {:else}
              <details class="done-think" data-testid="block-think-done">
                <summary>💭 思考过程</summary>
                <div class="thinking-body">{b.text}</div>
              </details>
            {/if}
          {:else if b.type === "tool"}
            <details class="toolcard" data-testid="toolcard" open>
              <summary>
                <span class="t-ico">◢</span> {b.name}
                {#if busy && lastTool === b}<span class="t-run">⚙ 运行中</span>{/if}
              </summary>
              {#if toolPreview(b)}
                <pre class="tool-in">{toolPreview(b)}</pre>
              {/if}
            </details>
          {:else if b.type === "tool-result"}
            {@const s = outInfo(b)}
            {@const shownText = cutOpen.has(s.id) ? s.raw : (s.over ? s.raw.slice(0, OUT_CAP) : s.raw)}
            {@const isDiff = !b.isError && looksLikeDiff(shownText)}
            <details class="toolout {b.isError ? 'bad' : ''}" data-testid="tool-result" open>
              <summary>
                <span class="t-ico">└─</span>
                {b.isError ? '✗ 报错' : isDiff ? '▎ diff' : '… 输出'}
              </summary>
              {#if b.isError}
                <pre class="out err">{shownText || "（无输出）"}</pre>
              {:else if isDiff}
                <pre class="out diff">
{#each diffLines(shownText) as ln, i (i)}<span class="dl {ln.add ? 'add' : ''}{ln.del ? 'del' : ''}{ln.meta ? 'meta' : ''}">{ln.text}</span>
{/each}</pre>
              {:else}
                <pre class="out">{shownText || "（无输出）"}</pre>
              {/if}
              {#if s.over && !cutOpen.has(s.id)}
                <button class="cut" data-testid="tool-cut" onclick={() => toggleCut(s.id)}>
                  …结果过长,展开完整（{(s.excess).toLocaleString()} 字符）
                </button>
              {:else if s.over && cutOpen.has(s.id)}
                <button class="cut" onclick={() => toggleCut(s.id)}>收起 ↥</button>
              {/if}
            </details>
          {:else if b.type === "text"}
            {@const live = busy && curTb === b}
            <div class="md" data-testid="block-text">{@html renderMd(live ? b.text.slice(0, typing) : b.text)}</div>
          {:else if b.type === "error"}
            <div class="err">{b.text}</div>
          {/if}
        {/each}
      </div>
      <div class="sep"></div>
    {/if}
  {/each}

  {#if busy}
    <div class="cursor-line" data-testid="busy-cursor">▍</div>
  {/if}
</section>

<style>
  .term { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 20px; display: flex; flex-direction: column; line-height: 1.65; }
  .empty { margin: auto; text-align: center; color: var(--muted); }
  .empty-logo { font-size: 26px; color: var(--accent); }
  .empty h2 { color: var(--text); }

  /* 用户行:❯ 前缀终端风 */
  .u { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; }
  .prompt { color: var(--user-text); font-weight: 700; user-select: none; flex: 0 0 auto; }
  .utext { color: var(--text); font-weight: 600; white-space: pre-wrap; word-break: break-word; }
  .gap { height: 12px; }

  /* Claude 回复块 */
  .a { padding: 2px 0; }
  .sep { border-top: 1px dashed var(--border); margin: 14px 0 16px; }

  .thinking { color: var(--think); font-style: italic; font-size: 13px; padding: 2px 0; }
  .done-think { margin: 2px 0 6px; }
  .done-think summary { color: var(--think); font-size: 12px; cursor: pointer; user-select: none; }
  .thinking-body { color: var(--muted); font-size: 13px; white-space: pre-wrap; padding: 6px 0; border-left: 2px solid var(--border); margin-left: 4px; padding-left: 10px; }

  /* 工具调用:命令卡(终端感) */
  .toolcard { margin: 6px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
  .toolcard summary { cursor: pointer; padding: 6px 10px; color: var(--accent); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; user-select: none; }
  .t-ico { opacity: .7; }
  .t-run { margin-left: 8px; color: var(--ok); font-size: 11px; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .tool-in { margin: 0; padding: 6px 10px; border-top: 1px solid var(--border); background: var(--code-bg); color: var(--text2); font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }

  /* 工具执行结果 */
  .toolout { margin: 0 0 6px 16px; border-left: 2px solid var(--border-strong); }
  .toolout.bad { border-left-color: var(--danger); }
  .toolout summary { cursor: pointer; padding: 4px 8px; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; user-select: none; }
  .toolout summary:hover { color: var(--text); }
  .out { margin: 0; padding: 6px 10px; background: var(--code-bg); color: var(--text); font-size: 12px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  .out.err { color: var(--danger); }
  .out.diff { padding: 0; }
  .out.diff :global(.dl) { display: block; padding: 0 10px; white-space: pre-wrap; }
  .out.diff :global(.dl.add) { background: rgba(63,185,80,.16); color: var(--ok); }
  .out.diff :global(.dl.del) { background: rgba(248,81,73,.16); color: var(--danger); }
  .out.diff :global(.dl.meta) { color: var(--muted); }
  .cut { display: block; margin: 2px 8px 6px; background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; text-align: left; padding: 2px 4px; border-radius: 4px; }
  .cut:hover { background: var(--border); }

  .cursor-line { color: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .err { color: var(--danger); font-size: 13px; }

  /* ---- Markdown 排版 ---- */
  .md :global(p) { margin: 0 0 8px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) { margin: 12px 0 6px; line-height: 1.35; }
  .md :global(h1) { font-size: 1.35em; }
  .md :global(h2) { font-size: 1.2em; }
  .md :global(h3) { font-size: 1.08em; }
  .md :global(ul), .md :global(ol) { margin: 0 0 8px; padding-left: 22px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(strong) { color: var(--text); font-weight: 700; }
  .md :global(a) { color: var(--accent); }
  .md :global(code) { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .md :global(pre) { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 0 0 8px; }
  .md :global(pre code) { background: none; border: none; padding: 0; display: block; white-space: pre; }
  .md :global(blockquote) { border-left: 3px solid var(--border-strong); margin: 0 0 8px; padding-left: 10px; color: var(--muted); }
  .md :global(hr) { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
  .md :global(table) { border-collapse: collapse; margin: 0 0 8px; display: block; overflow-x: auto; }
  .md :global(th), .md :global(td) { border: 1px solid var(--border-strong); padding: 4px 10px; font-size: 13px; }
  .md :global(th) { background: var(--surface); }
  .md :global(input[type="checkbox"]) { margin-right: 6px; }
</style>
