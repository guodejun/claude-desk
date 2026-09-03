<script>
  // 对话页:顶部多会话 tab 栏 + 主体 = 真实 claude 终端(+可选右侧纪要面板)
  // 点会话/新建即在此目录、带会话参数,直接起/附着真实交互 claude——对话效果与终端 100% 一致
  // 关键:整体用 {#key id} —— 会话页内「＋新建/切 tab」是同路由参数变化,SvelteKit 复用组件实例
  // 不重跑 onMount;key 强制重挂,新会话的 TerminalView 才会去开新终端(附着式 replay 无缝回放)
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { list, createSession, refreshList } from "$lib/stores/sessions.svelte.js";
  import { tabs, openTab, updateTabTitle, closeTab } from "$lib/stores/tabs.svelte.js";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import SessionForm from "$lib/components/SessionForm.svelte";
  import SummaryPanel from "$lib/components/SummaryPanel.svelte";
  import MonitorPanel from "$lib/components/MonitorPanel.svelte";
  import { ask } from "$lib/stores/dialog.svelte.js";

  const id = $derived(page.params.id);
  let meta = $derived(list.items.find((s) => s.id === id));
  let isNewOpen = $state(false);
  let newError = $state("");

  // 右侧面板:''(收起) | 'summary'(纪要) | 'monitor'(工具);默认工具面板,偏好记 localStorage
  let panel = $state("monitor");
  try {
    panel = localStorage.getItem("cd-right-panel") || "monitor";
  } catch {}

  // —— tab 呼吸灯:判定 忙碌(绿闪)/空闲(黄)/未运行(灰) ——
  // 关键:不能用「最近输出时刻是否够近」判定 —— claude TUI 空闲时每几秒会吐一小段
  // 状态栏字节(几十一字节),会把灯频繁拉回绿色、稳定不下来。
  // 改用「滑动窗口内累计输出字节量」:短时间持续输出大量字节才算 claude 正在回答,
  // 空闲期的零星小刷新(几十字节)不算工作,灯稳定保持黄色。
  const WORK_MS = 3000; // 统计窗口(ms)
  const WORK_BYTES = 100; // 窗口内达到该字节量 → 判定 claude 工作中(真实回答一开即远超)
  let work = $state({}); // sessionId -> [{t: 输出时刻, n: 本块字节数}]
  let nowTick = $state(Date.now()); // 每秒刷新一次,驱动灯态随时间滑动

  // tab 灯态:未运行=灰;运行中且窗口内输出量达标=绿闪(工作中);否则黄(空闲等输入/已答完)
  function dotCls(tid) {
    if (!isRunning(tid)) return "";
    const arr = work[tid];
    if (!arr) return "idle";
    let sum = 0;
    for (let i = arr.length - 1; i >= 0 && nowTick - arr[i].t <= WORK_MS; i--) sum += arr[i].n;
    return sum >= WORK_BYTES ? "run" : "idle";
  }

  function setPanel(p) {
    panel = p;
    try {
      localStorage.setItem("cd-right-panel", p);
    } catch {}
  }

  function toggleSummary() {
    setPanel(panel === "summary" ? "" : "summary");
  }

  function toggleMonitor() {
    setPanel(panel === "monitor" ? "" : "monitor");
  }

  onMount(() => {
    // 终端打开/退出事件会改列表 running 状态,实时刷新;
    // 记录每个 tab 终端输出的字节块(带时间戳),供呼吸灯按滑动窗口判定 忙碌/空闲
    const un = window.claude.onTerminal((ev) => {
      if (ev && ev.id) {
        if (ev.type === "data") {
          const n = (ev.data || "").length || 0;
          const w = (work[ev.id] || []).filter((x) => Date.now() - x.t <= WORK_MS);
          w.push({ t: Date.now(), n });
          work[ev.id] = w;
        } else if (ev.type === "exit") {
          delete work[ev.id];
        }
      }
      // open/exit 会改任一会话的 running 状态,无论哪个 tab 都要刷新(灯随运行态同步变灰/变灯)
      if (ev && (ev.type === "open" || ev.type === "exit")) refreshList();
    });
    // 每秒跳动 nowTick + 清掉滑出窗口的旧块,让灯态随时间自然滑变
    const ticker = setInterval(() => {
      nowTick = Date.now();
      for (const k in work) {
        const w = work[k].filter((x) => nowTick - x.t <= WORK_MS);
        if (w.length !== work[k].length) work[k] = w;
      }
    }, 1000);
    return () => {
      un();
      clearInterval(ticker);
    };
  });

  // id 变化也要登记 tab(onMount 在同路由变化时不重跑;$effect 兜底)
  $effect(() => {
    if (id) openTab(id);
  });

  // 标题同步到 tab
  $effect(() => {
    if (meta?.title) updateTabTitle(id, meta.title);
  });

  function isRunning(tid) {
    return !!list.items.find((s) => s.id === tid)?.running;
  }

  // 结束终端:确认后关掉 claude 进程并关闭该会话标签页(会话记录保留)
  function onStopTerminal() {
    ask("结束终端？", "将结束该会话正在运行的 claude，并关闭其标签页。会话记录保留，可随时重开。", "结束").then((ok) => {
      if (!ok) return;
      window.claude.terminalClose(id);
      closeTab(id);
      goto("/");
    });
  }

  async function onCloseTab(tid, e) {
    e.stopPropagation();
    const msg = isRunning(tid)
      ? "该会话终端仍在运行中，关闭标签不会结束终端进程，可在会话列表继续查看。"
      : "关闭后可在会话列表重新打开。";
    if (!(await ask("关闭标签页？", msg, "关闭"))) return;
    closeTab(tid);
    if (tid === id) goto("/"); // 关闭当前 → 回列表
  }

  async function onSaveNew(form) {
    newError = "";
    try {
      const s = await createSession(form);
      isNewOpen = false;
      openTab(s.id, s.title);
      goto(`/session/${s.id}`);
    } catch (err) {
      newError = String(err);
    }
  }
</script>

<section class="session-page">
  <!-- 多会话 tab 栏:首位固定「工作空间」入口(跳回列表),其后为已打开的会话 tab -->
  <div class="tabbar">
    <div class="tabs">
      <button
        class="tab ws"
        data-testid="tab-workspace"
        onclick={() => goto('/')}
        title="回到工作空间(会话列表)"
      >◧ 工作空间</button>
      {#each tabs.items as t (t.id)}
        <button
          class="tab {t.id === id ? 'on' : ''}"
          data-testid="session-tab"
          onclick={() => goto(`/session/${t.id}`)}
          title={t.title}
        >
          <span class="tdot {dotCls(t.id)}"></span>
          <span class="tlabel">{t.title}</span>
          <span class="x" onclick={(e) => onCloseTab(t.id, e)}>✕</span>
        </button>
      {/each}
    </div>
    <button class="newtab" data-testid="new-session-tab" onclick={() => (isNewOpen = true)} title="新建对话(复用当前工作目录)">＋ 新建</button>
  </div>

  <header class="bar">
    <button class="ghost" onclick={() => goto('/')}>⇤ 会话</button>
    <div class="title">
      <span class="name">{meta?.title || '…'}</span>
      <span class="cwd">📁 {meta?.cwd || ''}</span>
    </div>
    <div class="spacer"></div>
    {#if isRunning(id)}
      <span class="running">运行中</span>
      <button class="ghost danger" data-testid="term-stop" onclick={onStopTerminal} title="结束终端(先确认,并关闭该标签页)">■ 结束终端</button>
    {:else}
      <button class="ghost" data-testid="term-reconnect-top" onclick={() => window.dispatchEvent(new CustomEvent("cd-reconnect", { detail: { id } }))} title="终端已退出,重新打开并连接该会话">⟳ 重连</button>
    {/if}
    <button class="ghost {panel === 'monitor' ? 'on' : ''}" data-testid="toggle-tools" onclick={toggleMonitor} title="右侧面板切换为常用命令工具(点击向终端发送斜杠命令,在主窗口执行)">🧰 工具</button>
    <button class="ghost {panel === 'summary' ? 'on' : ''}" data-testid="toggle-summary" onclick={toggleSummary} title="展开/收起右侧会话纪要">📋 纪要</button>
  </header>

  <!-- 主体:key 随会话 id 变化,强制重挂终端与右侧面板(同路由导航不复用旧终端)
       右侧 1/3 默认工具面板,点「纪要」切到纪要;两者共用同一列宽 -->
  {#key id}
    <div class="main-row {panel ? 'with-panel' : ''}">
      <div class="term-col">
        <TerminalView id={id} panelOpen={!!panel} />
      </div>
      {#if panel === 'summary'}
        <div class="summary-col">
          <SummaryPanel {id} />
        </div>
      {:else if panel === 'monitor'}
        <div class="summary-col">
          <MonitorPanel {id} />
        </div>
      {/if}
    </div>
  {/key}
</section>

{#if isNewOpen}
  <div class="modal">
    <div class="card">
      <div class="card-hd">
        <h2>新建会话</h2>
        <button class="ghost" onclick={() => (isNewOpen = false)}>✕</button>
      </div>
      <!-- 关键细节:新建时 cwd 默认沿用当前会话 -->
      <SessionForm initial={{ cwd: meta?.cwd || "" }} onSave={onSaveNew} />
      {#if newError}<div class="err">{newError}</div>{/if}
    </div>
  </div>
{/if}

<style>
  .session-page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

  /* tab 栏 */
  .tabbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface); flex: 0 0 auto; }
  .tabs { display: flex; gap: 6px; min-width: 0; overflow-x: auto; }
  .tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 6px 5px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--muted); cursor: pointer; white-space: nowrap; font-size: 13px; }
  .tab:hover { color: var(--text); }
  .tab.on { color: var(--text); border-color: var(--accent); background: var(--border); }
  .tab.ws { color: var(--accent); border: 1px dashed var(--border-strong); }
  .tab.ws:hover { border-color: var(--accent); background: var(--hover); }
  .tdot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); flex: 0 0 auto; }
  .tdot.run { background: var(--ok); animation: pulse 1.4s ease-in-out infinite; }
  .tdot.idle { background: var(--warn); }
  @keyframes pulse { 50% { opacity: .4; } }
  .tlabel { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .tab .x { color: var(--muted2); padding: 0 4px; border-radius: 4px; font-size: 11px; }
  .tab .x:hover { color: var(--danger); }
  .newtab { background: none; border: 1px dashed var(--border-strong); color: var(--muted); border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 13px; white-space: nowrap; flex: 0 0 auto; }
  .newtab:hover { color: var(--text); border-color: var(--accent); }

  .bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex: 0 0 auto; }
  .ghost { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
  .ghost.danger { color: var(--danger); }
  .ghost.on { color: var(--accent); border-color: var(--accent); }
  .title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .name { font-weight: 600; color: var(--text); font-size: 14px; }
  .cwd { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 38vw; }
  .spacer { flex: 1; }
  .running { color: var(--ok); font-size: 12px; }

  /* 主体:终端占满剩余高度 + 可选右侧纪要(1/4) */
  .main-row { flex: 1 1 auto; min-height: 0; display: flex; }
  .term-col { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
  .main-row.with-panel .term-col { flex-basis: 72%; }
  .summary-col { flex: 0 0 28%; min-width: 260px; max-width: 520px; border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }

  .modal { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: 60; }
  .card { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px; width: 560px; max-width: 92vw; max-height: 86vh; overflow-y: auto; padding: 18px 20px; }
  .card-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .card-hd h2 { font-size: 16px; margin: 0; }
  .err { color: var(--danger); font-size: 13px; margin-top: 10px; }
</style>
