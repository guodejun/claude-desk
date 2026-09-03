<script>
  // 全局中文确认弹窗:按钮「取消 / 确定(可自定义如「删除」)」,Esc 取消、Enter 确认
  import { dialog, confirmDialog, cancelDialog } from "$lib/stores/dialog.svelte.js";
</script>

<svelte:window
  onkeydown={(e) => {
    if (!dialog.open) return;
    if (e.key === "Escape") cancelDialog();
    else if (e.key === "Enter") confirmDialog();
  }}
/>

{#if dialog.open}
  <div
    class="mask"
    role="presentation"
    data-testid="confirm-dialog"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancelDialog();
    }}
  >
    <div class="box" role="alertdialog" aria-modal="true">
      <div class="title" data-testid="dlg-title">{dialog.title}</div>
      {#if dialog.message}<div class="msg">{dialog.message}</div>{/if}
      <div class="actions">
        <button class="ghost" data-testid="dlg-cancel" onclick={cancelDialog}>{dialog.cancelText}</button>
        <button class="danger" data-testid="dlg-ok" onclick={confirmDialog}>{dialog.confirmText}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .mask {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .box {
    min-width: 300px;
    max-width: 460px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    padding: 18px 20px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .title { font-size: 15px; font-weight: 700; color: var(--text); }
  .msg { margin-top: 8px; font-size: 13px; color: var(--muted); line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
  .ghost { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 8px 16px; cursor: pointer; font: inherit; }
  .ghost:hover { color: var(--text); border-color: var(--text); }
  .danger { background: var(--danger); border: none; color: #fff; border-radius: 8px; padding: 8px 16px; cursor: pointer; font: inherit; font-weight: 600; }
  .danger:hover { filter: brightness(1.1); }
</style>
