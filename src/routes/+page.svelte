<script>
  // 首页:工作空间列表(CRUD 入口,标题自动生成,按天筛选:全部/今天/昨天 + 任意日期选择)
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { list, createSession, updateSession, removeSession, refreshList } from "$lib/stores/sessions.svelte.js";
  import { contextLimitOf } from "$lib/lib/context.js";
  import SessionForm from "$lib/components/SessionForm.svelte";
  import { ask } from "$lib/stores/dialog.svelte.js";

  let isCreating = $state(false);
  let error = $state("");
  let editing = $state(null); // 正在编辑的会话(对象),null 表示关闭
  let editError = $state("");
  let filter = $state("all"); // all | today | yesterday
  let dateFilter = $state(""); // yyyy-MM-dd(选中后优先于 tabs)

  // 每次进入列表都刷新(显示对话后的自动标题/时间等最新状态)
  onMount(() => {
    refreshList();
  });

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 本地日期字符串 yyyy-MM-dd(与 <input type=date> 的值同格式)
  function localDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 创建/更新时间:今天只显 HH:mm,否则 yyyy-MM-dd HH:mm
  function fmtDT(ts) {
    if (!ts) return "";
    const day = localDate(ts);
    const today = localDate(Date.now());
    return day === today ? `今天 ${fmtTime(ts)}` : `${day} ${fmtTime(ts)}`;
  }

  // 分组标题:今天/昨天/最近一周内 M月D日/更早 yyyy-mm-dd
  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sT = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((sT - t) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff < 7) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // ---- 分页:过滤(全部/今天/昨天/任意日期) → 按 updatedAt 倒序切片 → 页内按天分组 ----
  const PAGE_SIZE = 20;
  let page = $state(1);

  // 过滤后的有序列表(列表本身已按 updatedAt 倒序,保持顺序做分页)
  let filtered = $derived(
    list.items.filter((s) => {
      if (dateFilter) return localDate(s.updatedAt) === dateFilter;
      if (filter === "today" && dayLabel(s.updatedAt) !== "今天") return false;
      if (filter === "yesterday" && dayLabel(s.updatedAt) !== "昨天") return false;
      return true;
    })
  );
  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));

  // 筛选/会话增删变化时回到第一页(只有切页会改 page,不触发这里)
  $effect(() => {
    const key = `${filter}|${dateFilter}|${list.items.length}`;
    void key;
    page = 1;
  });

  // 当前页内容再按天分组(日期标题随页内实际内容;page 越界时落到最后一页,避免空帧)
  let groups = $derived.by(() => {
    const last = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const cur = Math.min(page, last);
    const start = (cur - 1) * PAGE_SIZE;
    const map = new Map();
    for (const s of filtered.slice(start, start + PAGE_SIZE)) {
      const label = dateFilter || dayLabel(s.updatedAt);
      if (!map.has(label)) map.set(label, { label, items: [] });
      map.get(label).items.push(s);
    }
    return [...map.values()];
  });

  async function onSave(meta) {
    error = "";
    try {
      const s = await createSession(meta);
      isCreating = false;
      goto(`/session/${s.id}`); // 创建后直接进入对话
    } catch (e) {
      error = String(e);
    }
  }

  async function onDelete(id, ev) {
    ev.stopPropagation();
    if (!(await ask("删除该会话？", "运行中的任务会被终止。", "删除"))) return;
    await removeSession(id);
  }

  // 编辑会话:保存名称/目录/参数等(运行中会话的改动在下次重开终端时生效)
  async function onEdit(meta) {
    editError = "";
    try {
      if (!editing) return;
      await updateSession(editing.id, meta);
      editing = null;
      await refreshList();
    } catch (e) {
      editError = String(e);
    }
  }
</script>

<section class="list-page">
  <header class="bar">
    <h1>工作空间</h1>
    <button class="primary" data-testid="create-btn" onclick={() => (isCreating = true)}>＋ 新建会话</button>
  </header>

  {#if isCreating}
    <div class="modal">
      <div class="card">
        <div class="card-hd">
          <h2>新建会话</h2>
          <button class="ghost" onclick={() => (isCreating = false)}>✕</button>
        </div>
        <SessionForm onSave={onSave} />
        {#if error}<div class="err">{error}</div>{/if}
      </div>
    </div>
  {/if}

  {#if editing}
    <div class="modal">
      <div class="card">
        <div class="card-hd">
          <h2>编辑会话</h2>
          <button class="ghost" onclick={() => (editing = null)}>✕</button>
        </div>
        <SessionForm initial={editing} onSave={onEdit} />
        {#if editing.running}<p class="note">该会话终端正在运行，改动将在下次重新打开终端时生效。</p>{/if}
        {#if editError}<div class="err">{editError}</div>{/if}
      </div>
    </div>
  {/if}

  <!-- 按天筛选:tabs + 任意日期选择 -->
  {#if list.items.length > 0}
    <div class="tabs">
      <button class:on={filter === "all" && !dateFilter} data-testid="filter-all" onclick={() => { filter = "all"; dateFilter = ""; }}>全部</button>
      <button class:on={filter === "today" && !dateFilter} data-testid="filter-today" onclick={() => { filter = "today"; dateFilter = ""; }}>今天</button>
      <button class:on={filter === "yesterday" && !dateFilter} data-testid="filter-yesterday" onclick={() => { filter = "yesterday"; dateFilter = ""; }}>昨天</button>
      <span class="dpick" title="按日期筛选(任意一天)">
        <input type="date" data-testid="date-picker" bind:value={dateFilter} onchange={() => { filter = "all"; }} />
        {#if dateFilter}<button class="clear" data-testid="date-clear" title="清除日期筛选" onclick={() => (dateFilter = "")}>✕</button>{/if}
      </span>
    </div>
  {/if}

  <div class="sessions">
    {#if !list.loaded}
      <p class="hint">加载中…</p>
    {:else if list.items.length === 0}
      <div class="empty">
        <h2>还没有会话</h2>
        <p>点右上角「新建会话」，设置工作目录与 claude 参数，开始对话。</p>
        <button class="primary" onclick={() => (isCreating = true)} data-testid="create-btn-empty">＋ 新建会话</button>
      </div>
    {:else if groups.length === 0}
      <p class="hint">该时间段内没有会话。</p>
    {:else}
      {#each groups as g (g.label)}
        <div class="gday">{g.label}<small>{g.items.length}</small></div>
        {#each g.items as s (s.id)}
          <div class="item" data-testid="session-item" onclick={() => goto(`/session/${s.id}`)}>
            <span class="dot {s.running ? 'run' : ''}"></span>
            <div class="info">
              <div class="title">{s.title}</div>
              <div class="sub">📁 {s.cwd}{s.skipPermissions ? "" : " · ⛔ 有权限确认"}</div>
              <div class="meta">
                <span title="创建时间">🕒 {fmtDT(s.createdAt)}</span>
                <span title="更新时间">✏️ {fmtDT(s.updatedAt)}</span>
                <span class:ctx-warn={s.ctxTok > contextLimitOf(s.model)} title="上下文长度（当前 / 估算上限）">{s.ctxTok.toLocaleString()} / {contextLimitOf(s.model).toLocaleString()} tokens</span>
              </div>
            </div>
            {#if s.running}<span class="running">运行中</span>{/if}
            <button class="gear" data-testid="edit-session" onclick={(ev) => { ev.stopPropagation(); editing = s; }} title="编辑会话（名称/目录/参数）">⚙</button>
            <button class="del" onclick={(ev) => onDelete(s.id, ev)} title="删除">🗑</button>
          </div>
        {/each}
      {/each}

      {#if filtered.length > PAGE_SIZE}
        <div class="pager" data-testid="list-pager">
          <button class="pg" disabled={page <= 1} data-testid="page-prev" onclick={() => (page--)}>← 上一页</button>
          <span class="pginfo">第 {page} / {totalPages} 页 · 共 {filtered.length} 条会话</span>
          <button class="pg" disabled={page >= totalPages} data-testid="page-next" onclick={() => (page++)}>下一页 →</button>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .list-page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
  .bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .bar h1 { font-size: 17px; margin: 0; }
  .primary { background: var(--btn-green); border: none; color: #fff; border-radius: 8px; padding: 9px 16px; cursor: pointer; font-weight: 600; }

  .tabs { display: flex; align-items: center; gap: 6px; padding: 10px 20px 0; flex: 0 0 auto; flex-wrap: wrap; }
  .tabs button { background: none; border: 1px solid transparent; color: var(--muted); border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 13px; }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { color: var(--text); border-color: var(--border-strong); background: var(--border); }
  .dpick { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; }
  .dpick input[type="date"] { background: var(--surface); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 4px 8px; font-size: 12px; color-scheme: inherit; }
  .dpick input[type="date"]:focus { outline: none; border-color: var(--accent); }
  .dpick .clear { background: none; border: none; color: var(--muted2); cursor: pointer; font-size: 12px; padding: 2px 4px; }
  .dpick .clear:hover { color: var(--danger); }

  .sessions { padding: 8px 20px 20px; display: flex; flex-direction: column; gap: 6px; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .pg { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .pg:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .pg:disabled { opacity: .45; cursor: not-allowed; }
  .pginfo { color: var(--muted); font-size: 12px; }
  .gday { margin-top: 10px; font-size: 12px; color: var(--muted); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .gday small { color: var(--muted2); font-weight: 400; }

  .item { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; cursor: pointer; }
  .item:hover { border-color: var(--border-strong); background: var(--hover); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); flex: 0 0 auto; }
  .dot.run { background: var(--ok); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  .info { flex: 1 1 auto; min-width: 0; }
  .title { font-weight: 600; color: var(--text); }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; gap: 12px; margin-top: 4px; color: var(--muted2); font-size: 11px; flex-wrap: wrap; }
  .meta .ctx-warn { color: var(--danger); }
  .running { color: var(--ok); font-size: 12px; flex: 0 0 auto; }
  .gear { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 15px; flex: 0 0 auto; padding: 4px; }
  .gear:hover { color: var(--accent); }
  .del { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 15px; flex: 0 0 auto; padding: 4px; }
  .del:hover { color: var(--danger); }
  .note { font-size: 12px; color: var(--muted); margin: 10px 0 0; }

  .empty { margin: 60px auto; text-align: center; color: var(--muted); }
  .empty h2 { color: var(--text); }
  .hint { color: var(--muted2); padding: 30px 20px; text-align: center; }

  .modal { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .card { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px; width: 560px; max-width: 92vw; max-height: 86vh; overflow-y: auto; padding: 18px 20px; }
  .card-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .card-hd h2 { font-size: 16px; margin: 0; }
  .ghost { background: none; border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .err { color: var(--danger); font-size: 13px; margin-top: 10px; }
</style>
