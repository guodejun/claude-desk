<script>
  // 新建/编辑会话表单:可选名称 + 本地工作目录 + claude --参数 + 权限开关
  let { initial = null, onSave = () => {} } = $props();
  let title = $state(initial?.title || "");
  let cwd = $state(initial?.cwd || "");
  let argText = $state(initial?.argText || "");
  let skipPermissions = $state(initial ? !!initial.skipPermissions : true);

  async function pickDir() {
    const p = await window.claude.pickDirectory();
    if (p) cwd = p;
  }

  function submit() {
    onSave({ title: title.trim(), cwd: cwd.trim(), argText, skipPermissions });
  }
</script>

<form class="form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <label>
    <span>名称（可选）</span>
    <input data-testid="f-title" bind:value={title} placeholder="留空则发送第一条消息后自动生成" />
  </label>

  <label>
    <span>本地工作目录 (cwd)</span>
    <div class="cwd-row">
      <input data-testid="f-cwd" bind:value={cwd} placeholder="claude 在此目录运行,如 /media/wanji/proj" />
      <button type="button" class="ghost" onclick={pickDir}>选择…</button>
    </div>
  </label>

  <label>
    <span>Claude 参数 (每行一个 --flag 值,支持引号与 # 注释)</span>
    <textarea class="args" data-testid="f-args" bind:value={argText} rows="4"
      placeholder={"--model claude-sonnet-5\n--allowedTools \"Bash\" \"Read\"\n# 以下参数已由系统管理:-p / --resume / --output-format"}></textarea>
  </label>

  <label class="check">
    <input type="checkbox" data-testid="f-skip" bind:checked={skipPermissions} />
    <span>--dangerously-skip-permissions（跳过权限确认，允许 claude 自动执行工具）</span>
  </label>

  <div class="actions">
    <button type="submit" class="primary" data-testid="f-save" disabled={false}>
      {initial ? "保存修改" : "创建并进入对话"}
    </button>
  </div>
</form>

<style>
  .form { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; }
  .note { margin: 0; color: var(--muted); font-size: 12px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text2); }
  input[type="text"], input:not([type]) { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 10px 12px; font: inherit; }
  textarea { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 10px 12px; font: inherit; resize: vertical; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .cwd-row { display: flex; gap: 8px; }
  .cwd-row input { flex: 1; }
  .ghost { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 0 12px; cursor: pointer; white-space: nowrap; }
  .check { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
  .check input { width: 16px; height: 16px; }
  .actions { display: flex; justify-content: flex-end; }
  .primary { background: var(--btn-green); border: none; color: #fff; border-radius: 8px; padding: 10px 18px; cursor: pointer; font-weight: 600; }
  .primary:disabled { opacity: .5; cursor: not-allowed; }
</style>
