<script>
  // 对话队列弹窗:把「要问 claude 的一串对话」排成队,能新建/修改/删除多条;
  // 点「开始」后主进程按序逐条写入真实终端——上一条 claude 回答完毕(输出停滞)自动发下一条,
  // 一轮跑完即停。运行中不可编辑(先暂停),状态经 onTerminal(type==='tunnel') 实时刷新。
  import { onMount } from "svelte";

  let { id = "", open = false, onClose = () => {} } = $props();

  let items = $state([]); // [{ id, text, status: pending|active|done }]
  let running = $state(false);
  let input = $state(""); // 新建输入框
  let err = $state("");
  let editingId = $state(""); // 正在行内编辑的条目(空=无)
  let editText = $state("");
  let un = null;

  const LABEL = { pending: "待发", active: "发送中", done: "已完成" };
  let doneCount = $derived(items.filter((x) => x.status === "done").length);

  async function load() {
    try {
      const st = await window.claude.tunnelState(id);
      if (st && Array.isArray(st.items)) {
        items = st.items;
        running = !!st.running;
      }
    } catch {}
  }

  // 打开时拉最新状态
  $effect(() => {
    if (open) {
      err = "";
      load();
    }
  });

  onMount(() => {
    un = window.claude.onTerminal((ev) => {
      if (ev && ev.type === "tunnel" && ev.id === id) {
        items = (ev.state && ev.state.items) || [];
        running = !!ev.state && !!ev.state.running;
        if (editingId && running) editingId = ""; // 万一运行中,退出编辑态
      }
    });
    return () => {
      if (un) un();
    };
  });

  // 全量保存(每次增/删/改都重存一次队列);引擎在运行中会拒绝,错误回显
  // 注意:items 是 Svelte 响应式 proxy,直接传 IPC 会被 structuredClone 拒绝克隆,
  //      保存前统一剥成纯 {id,text,status} 普通对象
  async function save(next) {
    err = "";
    const plain = (next || []).map((x) => ({ id: x.id, text: x.text, status: x.status || "pending" }));
    const st = await window.claude.tunnelSave(id, plain);
    if (st && st.error) {
      err = st.error;
      return null;
    }
    if (st && Array.isArray(st.items)) items = st.items;
    running = !!st.running;
    return st;
  }

  function addItem() {
    const t = input.trim();
    if (!t || running) return;
    // 先清空输入再保存;保存前以主进程最新队列为准再追加(本地 items 可能正被上一次 await 覆盖/过期)
    input = "";
    window.claude.tunnelState(id).then((cur) => {
      const base = (cur && cur.items) || items;
      return save(base.concat([{ text: t, status: "pending" }]));
    });
  }

  async function confirmEdit(it) {
    const t = editText.trim();
    if (!t || running) return;
    await save(items.map((x) => (x.id === it.id ? { ...x, text: t } : x)));
    editingId = "";
  }

  async function removeItem(i0) {
    if (running) return;
    await save(items.filter((x) => x.id !== i0));
    if (editingId === i0) editingId = "";
  }

  async function start() {
    err = "";
    const st = await window.claude.tunnelStart(id);
    if (st && st.error) err = st.error;
  }

  async function pause() {
    err = "";
    if (running) await window.claude.tunnelPause(id);
  }

  // 回车=添加;Shift+Enter 换行(条目内容允许多行)
  function onkey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addItem();
    }
  }
</script>

{#if open}
  <div class="modal" data-testid="tunnel-dialog">
    <div class="card">
      <div class="hd">
        <h2>☰ 对话队列</h2>
        <div class="ops">
          <span class="prog" data-testid="tunnel-progress">{doneCount}/{items.length} 已完成</span>
          <button class="mini run" data-testid="tunnel-start" onclick={start} disabled={running || !items.length} title="按顺序逐条发给 claude,答完一条自动发下一条">{running ? "执行中…" : "▶ 开始"}</button>
          <button class="mini" data-testid="tunnel-pause" onclick={pause} disabled={!running} title="暂停:当前这条答完后不再自动续发">⏸ 暂停</button>
          <button class="mini" data-testid="tunnel-close" onclick={onClose} title="关闭队列(内容保留,可随时再开)">✕</button>
        </div>
      </div>
      <div class="tip">按从上到下顺序逐条发给当前会话的 claude：上一条回答完毕，自动发下一条。运行中不可修改，暂停后可编辑。</div>
      {#if err}
        <div class="err" data-testid="tunnel-err">⚠ {err}</div>
      {/if}
      <div class="list" data-testid="tunnel-list">
        {#each items as it, i (it.id)}
          <div class="row {it.status}" data-testid="tunnel-item">
            <span class="idx">{i + 1}</span>
            {#if editingId === it.id}
              <textarea class="edit" data-testid="tunnel-edit-input" bind:value={editText} rows="3"></textarea>
              <div class="rowops">
                <button class="mini" data-testid="tunnel-edit-save" onclick={() => confirmEdit(it)} disabled={!editText.trim()}>保存</button>
                <button class="mini" onclick={() => (editingId = "")}>取消</button>
              </div>
            {:else}
              <span class="txt">{it.text}</span>
              <span class="st {it.status}">{LABEL[it.status] || it.status}</span>
              {#if !running}
                <button class="mini" data-testid="tunnel-edit" onclick={() => { editingId = it.id; editText = it.text; }}>✎</button>
                <button class="mini danger" data-testid="tunnel-del" onclick={() => removeItem(it.id)}>🗑</button>
              {/if}
            {/if}
          </div>
        {/each}
        {#if !items.length}
          <div class="empty" data-testid="tunnel-empty">队列为空——在下方输入要问 claude 的对话</div>
        {/if}
      </div>
      <div class="add">
        <textarea data-testid="tunnel-input" bind:value={input} onkeydown={onkey} rows="2" placeholder="输入一条对话，回车添加（Shift+Enter 换行）" disabled={running}></textarea>
        <button class="mini addbtn" data-testid="tunnel-add" onclick={addItem} disabled={running || !input.trim()}>＋ 添加</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 70; }
  .card { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px; width: 640px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column; overflow: hidden; padding: 16px 18px; }
  .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 0 0 auto; }
  .hd h2 { font-size: 16px; margin: 0; }
  .ops { display: flex; align-items: center; gap: 6px; }
  .prog { font-size: 12px; color: var(--muted); margin-right: 4px; }
  .tip { color: var(--muted2); font-size: 11px; margin: 8px 0 6px; flex: 0 0 auto; }
  .err { color: var(--danger); font-size: 13px; margin: 4px 0; }

  .list { flex: 1 1 auto; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--bg); }
  .row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .row.active { border-color: var(--accent); }
  .row.done { opacity: .6; }
  .idx { flex: 0 0 auto; min-width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; background: var(--border); color: var(--text); font-size: 11px; }
  .txt { flex: 1 1 auto; font-size: 13px; color: var(--text2); white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .st { flex: 0 0 auto; font-size: 11px; color: var(--muted); background: var(--border); border-radius: 10px; padding: 1px 8px; }
  .st.active { color: var(--ok); background: var(--border); }
  .st.done { color: var(--muted2); }
  .mini { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .mini:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .mini.run { color: var(--ok); }
  .mini.danger { color: var(--danger); }
  .mini:disabled { opacity: .5; cursor: not-allowed; }
  .edit { flex: 1 1 auto; font-family: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; resize: vertical; line-height: 1.5; }
  .rowops { flex: 0 0 auto; display: flex; flex-direction: column; gap: 4px; }
  .empty { color: var(--muted); font-size: 13px; padding: 20px 10px; text-align: center; }
  .add { display: flex; align-items: flex-end; gap: 8px; margin-top: 10px; flex: 0 0 auto; }
  .add textarea { flex: 1 1 auto; font-family: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 10px; resize: vertical; line-height: 1.5; }
  .addbtn { padding: 8px 14px; }
</style>
