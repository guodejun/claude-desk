<script>
  // 全局布局:顶部导航 + 事件总线初始化 + 列表/设置预热
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { initBus } from "$lib/stores/chat.svelte.js";
  import { refreshList } from "$lib/stores/sessions.svelte.js";
  import { loadSettings } from "$lib/stores/settings.svelte.js";
  import { initTabs } from "$lib/stores/tabs.svelte.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { ask } from "$lib/stores/dialog.svelte.js";

  let { children } = $props();

  // 全屏开关状态(主进程 toggleFullscreen / F11 会广播回传,按钮图标据此切换)
  let fs = $state(false);
  let unFs = null;
  function onFullscreen() {
    window.claude.toggleFullscreen?.();
  }

  // 退出确认:主进程拦截 close(有运行中终端时)发 close-request 过来,
  // 在这里用全局 ConfirmDialog(ask)弹应用风格的确认框,结果回传主进程真正关闭/取消
  let unCloseReq = null;
  async function onCloseReq(ev) {
    const n = (ev && ev.n) || 0;
    const ok = await ask(
      "退出确认",
      `还有 ${n} 个终端正在运行\n关闭 Claude Desk 会终止这些运行中的终端会话(真实 claude 进程),确定退出吗?`,
      "确定关闭"
    );
    if (ok) window.claude.confirmClose?.();
    else window.claude.cancelClose?.();
  }

  onMount(() => {
    initBus();
    initTabs();
    refreshList();
    loadSettings();
    unFs = window.claude.onFullscreen?.((v) => (fs = !!v));
    unCloseReq = window.claude.onCloseConfirm?.(onCloseReq);
  });
  onDestroy(() => {
    if (unFs) unFs();
    if (unCloseReq) unCloseReq();
  });

  // 主题应用(readTheme/setTheme 与设置页共用 localStorage "cd-theme");
  // 同时同步到窗口级(Win 系统标题栏深/浅跟随,见 main.cjs set-window-theme)
  function applyTheme() {
    try {
      const t = localStorage.getItem("cd-theme") || "dark";
      document.documentElement.dataset.theme = t;
      window.claude.setWindowTheme?.(t);
    } catch {}
  }
  onMount(applyTheme);
</script>

<svelte:head><title>Claude Desk</title></svelte:head>

<div class="wrap">
  <nav class="nav">
    <span class="logo"><img class="logo-img" src="/screenshot-20260903-084503.png" alt="logo" /> Claude Desk</span>
    <div class="links">
      <button class="link {page.url.pathname === '/' ? 'on' : ''}" onclick={() => goto('/')}>工作空间</button>
      <button class="link {page.url.pathname.startsWith('/settings') ? 'on' : ''}" onclick={() => goto('/settings')}>设置</button>
      <!-- 全屏/还原:内联 SVG(⛶ U+26F6 在 Ubuntu 常见字体缺字形,会显示成异常,改用字体无关的矢量图标) -->
      <button class="link fs" data-testid="toggle-fullscreen" onclick={onFullscreen} title="全屏 / 退出全屏 (F11)">
        {#if fs}
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6H6v4M14 6h4v4M10 18H6v-4M14 18h4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>还原
        {:else}
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3H3v7M14 3h7v7M10 21H3v-7M14 21h7v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>全屏
        {/if}
      </button>
    </div>
  </nav>
  <main class="body">{@render children()}</main>
</div>

<ConfirmDialog />

<style>
  :global(*) { box-sizing: border-box; }
  /* 外层禁止滚动,滚动交给各内容容器(对话区/列表/设置页)自己处理 */
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; background: var(--bg); font-family: ui-sans-serif, system-ui, sans-serif; color: var(--text); }

  .wrap { display: flex; flex-direction: column; height: 100vh; }
  .nav { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex: 0 0 auto; }
  .logo { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .5px; }
  .logo-img { height: 22px; width: auto; max-width: 22px; border-radius: 5px; object-fit: cover; }
  /* 冗余元素隐藏:左侧 logo 图标 + "Claude Desk" 文字、全屏按钮(全屏仍可用 F11) */
  .nav .logo, .nav .link.fs { display: none; }
  .links { display: flex; gap: 6px; }
  .link { background: none; border: 1px solid transparent; color: var(--muted); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
  .fs { display: inline-flex; align-items: center; gap: 5px; }
  .fs .ico { width: 13px; height: 13px; }
  .link:hover { color: var(--text); }
  .link.on { color: var(--text); border-color: var(--border-strong); background: var(--border); }
  .body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
</style>
