<script>
  // 输入区:发送按钮与输入框同一行、正常大小;底部一行显示上下文统计(当前/估算最大) + 压缩上下文按钮
  import { contextLimitOf, fmtNum } from "$lib/lib/context.js";

  let { busy = false, onSend = () => {}, onCompact = async () => ({}), placeholder = "给 Claude 发消息… (Enter 发送, Shift+Enter 换行)", messages = [], model = "" } = $props();
  let input = $state("");
  let compacting = $state(false);
  let compactMsg = $state("");

  let stats = $derived(computeStats(messages));
  let ctxMax = $derived(contextLimitOf(model));

  // 统计:消息条数、文本总字符数、估算 token(字符 ≈ 1 token,粗估)
  function computeStats(msgs) {
    let n = 0;
    let ch = 0;
    for (const m of msgs || []) {
      if (m.role === "user") {
        n++;
        ch += (m.text || "").length;
      } else if (m.role === "assistant") {
        n++;
        for (const b of m.blocks || []) {
          if (b.type === "text") ch += (b.text || "").length;
          else if (b.type === "thinking") ch += ((b.text || "").length / 2) | 0;
        }
      }
    }
    return { n, ch, tok: Math.round(ch / 4) };
  }

  function submit() {
    const msg = input.trim();
    if (!msg || busy) return;
    onSend(msg);
    input = "";
  }

  async function doCompact() {
    if (compacting || stats.n < 4) return;
    compacting = true;
    compactMsg = "正在压缩上下文…（真实 claude 提炼，可能需十几秒）";
    const r = await onCompact();
    compacting = false;
    if (r && r.ok) compactMsg = `✓ 上下文已压缩（节省约 ${(r.saved || 0).toLocaleString()} tok）`;
    else compactMsg = `✗ ${(r && r.error) || "压缩失败"}`;
    setTimeout(() => (compactMsg = ""), 6000);
  }
</script>

<footer class="composer">
  <div class="row">
    <textarea
      rows="1"
      data-testid="input"
      bind:value={input}
      placeholder={placeholder}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      }}
    ></textarea>
    <button
      class="compact"
      data-testid="compact-btn"
      title="压缩上下文：把当前对话交给真实 claude 提炼成要点摘要，降低上下文量（需至少 4 条消息、且运行结束后使用）"
      onclick={doCompact}
      disabled={compacting || busy || stats.n < 4}
    >🗜</button>
    <button class="send" data-testid="send" onclick={submit} disabled={!input.trim() || busy}>
      {busy ? "…" : "发送"}
    </button>
  </div>
  <div class="bar">
    <span class="msg">{compactMsg}</span>
    <span class="stats" data-testid="ctx-stats">
      {stats.n} 条消息 · {stats.tok.toLocaleString()} / {fmtNum(ctxMax)} tok
      {#if ctxMax > 0}· 已用 {Math.round((stats.tok / ctxMax) * 100)}%{/if}
    </span>
  </div>
</footer>

<style>
  .composer { padding: 8px 12px 6px; border-top: 1px solid var(--border); background: var(--surface); flex: 0 0 auto; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row textarea { flex: 1 1 auto; min-width: 0; resize: none; background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 10px 12px; font: inherit; min-height: 44px; max-height: 180px; }
  .row textarea:focus { outline: none; border-color: var(--accent); }
  .send { flex: 0 0 auto; height: 44px; padding: 0 18px; background: var(--btn-green); border: none; color: #fff; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; }
  .send:disabled { opacity: .5; cursor: not-allowed; }
  .compact { flex: 0 0 auto; height: 44px; width: 44px; padding: 0; background: var(--border); border: 1px solid var(--border-strong); color: var(--muted); border-radius: 8px; cursor: pointer; font-size: 16px; }
  .compact:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .compact:disabled { opacity: .4; cursor: not-allowed; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 2px 0; min-height: 18px; }
  .msg { font-size: 11px; color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { font-size: 11px; color: var(--muted2); user-select: none; flex: 0 0 auto; }
</style>
