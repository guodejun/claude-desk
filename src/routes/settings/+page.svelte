<script>
  // 设置页:界面主题 + claude 可执行文件(动态版本/跨平台发现)
  //  + Claude 配置文件:标准三文件(settings.json / settings.local.json / CLAUDE.md)直接编辑(单编辑区+语法高亮+路径不换行)
  //  + 命名配置模板:存于应用 userData,新增/删除/修改/查询全走该 JSON;下拉选择后一键写入 settings.json
  import { onMount, onDestroy } from "svelte";
  import { ask } from "$lib/stores/dialog.svelte.js";
  import { appSettings, saveSettings, refreshConfigFiles, resolveClaude, deleteConfigFile, templates, refreshTemplates, getTemplate, saveTemplate, deleteTemplate, applyTemplate } from "$lib/stores/settings.svelte.js";

  const GUIDE_URL = "https://fpq5u8xh3h.feishu.cn/docx/CnHcd4IMQoRaifxRbgEcr3GBnKg?from=from_copylink";

  // ---- claude 可执行文件 ----
  let cur = $state({ bin: "", version: "", error: "" }); // 实际探测结果
  let pathMsg = $state("");
  let pathErr = $state("");
  let updating = $state(false);
  let updateMsg = $state("");

  // ---- 标准配置文件:单编辑区切换制 ----
  let editing = $state(null); // {name,path,content,exists}
  let cfgMsg = $state("");
  let saveMsg = $state("");

  // ---- 命名配置模板 ----
  let tplEdit = $state(null); // {id,name,content}
  let tplMsg = $state("");
  let tplSaveMsg = $state("");
  let applySel = $state(""); // 下拉选中的模板 id

  let theme = $state("dark");
  let preEl = $state(null);
  let taEl = $state(null);
  let logPath = $state(""); // 落盘日志路径(排查问题时展示给用户)
  let appVer = $state(""); // 应用自身版本(底部「关于」展示)

  // ---- 云连接(手机远程):配置 + 实时状态 ----
  let cloudCfg = $state({ serverUrl: "", token: "", deviceName: "桌面电脑", autoStart: false });
  let cloudSt = $state({ state: "off", reason: "", deviceId: "" });
  let cloudMsg = $state("");
  let unCloud = null;

  onMount(() => {
    refreshConfigFiles();
    refreshTemplates();
    autoResolve();
    loadCloud();
    window.claude.logPath().then((p) => (logPath = p || "")).catch(() => {});
    window.claude.appVersion().then((v) => (appVer = v || "")).catch(() => {});
    try {
      theme = localStorage.getItem("cd-theme") || "dark";
    } catch {}
  });
  onDestroy(() => { if (unCloud) unCloud(); });

  // 拉取云端配置 + 当前连接状态,并订阅状态变化实时刷新
  async function loadCloud() {
    const r = await window.claude.cloudGet().catch(() => null);
    if (r) {
      cloudCfg = { ...cloudCfg, ...(r.config || {}) };
      cloudSt = r.status || cloudSt;
    }
    if (unCloud) unCloud();
    unCloud = window.claude.onCloud((st) => {
      cloudSt = st || cloudSt;
      cloudMsg = "";
    });
  }

  // 保存并应用:on=true 立即连接 / on=false 断开
  async function saveCloud(on) {
    cloudMsg = on ? "正在连接…" : "正在断开…";
    const r = await window.claude.cloudSet({ ...cloudCfg, autoStart: !!on }).catch((e) => ({ status: null, error: String(e) }));
    if (r && r.status) {
      cloudSt = r.status;
      cloudMsg = "";
    } else if (r && r.error) {
      cloudMsg = `✗ ${r.error}`;
    }
  }
  // 状态文案(设置页徽标颜色随状态切换)
  const cloudBadge = $derived.by(() => {
    switch (cloudSt.state) {
      case "online": return { cls: "on", txt: "● 已上线", t: cloudSt.deviceId };
      case "connecting": return { cls: "ing", txt: "连接中…", t: cloudSt.reason || "" };
      case "error": return { cls: "off", txt: "连接失败", t: cloudSt.reason || "" };
      case "off": return { cls: "off", txt: "已断开（未开启）", t: "" };
      default: return { cls: "off", txt: cloudSt.state || "未知", t: "" };
    }
  });

  // 动态探测当前 claude 版本/路径(替代原来的硬编码 v2.1.247)
  async function autoResolve() {
    const r = await resolveClaude();
    cur = { bin: r?.bin || "", version: r?.version || "", error: r?.error || "" };
  }

  // 亮/暗主题切换(与 app.html 首屏一致用 localStorage "cd-theme");
  // 同时同步到窗口级(Win 系统标题栏深/浅跟随,见 main.cjs set-window-theme)
  function setTheme(t) {
    theme = t;
    try {
      localStorage.setItem("cd-theme", t);
      document.documentElement.dataset.theme = t;
      window.claude.setWindowTheme?.(t);
    } catch {}
  }

  async function testPath() {
    pathMsg = "测试中…";
    pathErr = "";
    const bin = (appSettings.claudePath || "").trim();
    const r = await window.claude.claudeVersion(bin);
    if (r.ok) {
      pathMsg = `✓ ${r.version}`;
      cur = { ...cur, version: r.version, error: "" };
    } else {
      pathMsg = "";
      pathErr = `✗ ${r.error}`;
    }
  }

  async function doUpdate() {
    updating = true;
    updateMsg = "正在执行 claude update…（可能耗时较长）";
    const r = await window.claude.claudeUpdate();
    updating = false;
    if (r.ok) {
      updateMsg = `✓ 更新完成：${r.output || "(无输出)"}`;
      autoResolve(); // 更新后立即刷新版本显示
    } else updateMsg = `✗ 更新失败：${r.error || r.output || `退出码 ${r.code}`}${logPath ? `\n日志：${logPath}` : ""}`;
  }

  // ---- 标准配置文件:点击列表项 → 载入中央编辑区(切换即替换) ----
  async function openEditor(name) {
    const c = await window.claude.configRead(name);
    editing = { name: c.name, path: c.path, content: c.content, exists: c.exists };
    tplEdit = null; // 只保留一个编辑区
    saveMsg = "";
    cfgMsg = "";
    setTimeout(() => taEl && taEl.focus(), 30);
  }

  async function onDeleteConfig(cfg, e) {
    e.stopPropagation();
    if (!(await ask(`删除配置文件 ${cfg.name}？`, cfg.path, "删除"))) return;
    try {
      await deleteConfigFile(cfg.name);
      cfgMsg = `✓ 已删除 ${cfg.name}`;
      if (editing && editing.name === cfg.name) editing = null;
    } catch (err) {
      cfgMsg = `✗ ${err}`;
    }
  }

  async function saveConfig() {
    try {
      await window.claude.configWrite(editing.name, editing.content);
      editing = { ...editing, exists: true };
      saveMsg = "✓ 已写入（底层 claude 下次调用即生效）";
      refreshConfigFiles();
    } catch (e) {
      saveMsg = `✗ ${e}`;
    }
  }

  function closeEditor() {
    editing = null;
    saveMsg = "";
  }

  // ---- 命名配置模板 ----
  function startTplNew() {
    editing = null;
    tplEdit = { id: null, name: "", content: "" };
    tplSaveMsg = "";
    setTimeout(() => taEl && taEl.focus(), 30);
  }

  // 编辑模板:列表项不含 content,需按 id 拉取完整内容再回显
  async function startTplEdit(t, e) {
    if (e) e.stopPropagation();
    editing = null;
    const target = t.id; // 防御竞态:快速连点其他模板时,过期响应不再覆盖当前面板
    tplEdit = { id: target, name: t.name, content: "" };
    tplSaveMsg = "";
    try {
      const full = await getTemplate(target);
      if (full && tplEdit && tplEdit.id === target) tplEdit = { id: full.id, name: full.name, content: full.content || "" };
    } catch {}
    setTimeout(() => taEl && taEl.focus(), 30);
  }

  async function saveTpl() {
    const name = (tplEdit.name || "").trim();
    if (!name) {
      tplSaveMsg = "✗ 请先给配置起个名字";
      return;
    }
    const r = await saveTemplate({ id: tplEdit.id, name, content: tplEdit.content });
    if (r && r.ok) {
      tplMsg = `✓ 已保存「${name}」`;
      tplEdit = null;
    } else {
      tplSaveMsg = `✗ ${(r && r.error) || "保存失败"}`;
    }
  }

  function closeTpl() {
    tplEdit = null;
    tplSaveMsg = "";
  }

  async function delTpl(t, e) {
    e.stopPropagation();
    if (!(await ask(`删除命名配置「${t.name}」？`, "", "删除"))) return;
    if (await deleteTemplate(t.id)) {
      tplMsg = `✓ 已删除「${t.name}」`;
      if (applySel === t.id) applySel = "";
      if (tplEdit && tplEdit.id === t.id) closeTpl();
    } else tplMsg = "✗ 删除失败";
  }

  async function useTpl(t, e) {
    if (e) e.stopPropagation();
    await doApply(t.id, t.name);
  }

  // 应用模板 → 写入 ~/.claude/settings.json
  async function doApply(id, displayName) {
    if (!id) return;
    tplMsg = `正在应用「${displayName || "…"}」…`;
    const r = await applyTemplate(id);
    if (r && r.ok) {
      tplMsg = `✓ 已写入 settings.json：${r.path}`;
      refreshConfigFiles();
    } else tplMsg = `✗ ${(r && r.error) || "应用失败"}`;
  }

  // ---- 语法高亮(透明 textarea 叠在高亮 <pre> 上,滚动同步;标准文件与模板共用) ----
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function hlJson(src) {
    let out = "";
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += m[2] ? `<span class="t-key">${esc(m[1])}</span><span class="t-p">${esc(m[2])}</span>` : `<span class="t-str">${esc(m[1])}</span>`;
      else if (m[3]) out += `<span class="t-lit">${esc(m[3])}</span>`;
      else out += `<span class="t-num">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  function hlLine(l) {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) return `<span class="t-h">${esc(h[1])} ${esc(h[2])}</span>`;
    if (/^\s*(```|~~~)/.test(l)) return `<span class="t-code">${esc(l)}</span>`;
    let out = "";
    const re = /(`[^`]*`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|!?\[([^\]]*)\]\(([^)]*)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(l))) {
      out += esc(l.slice(last, m.index));
      if (m[1]) out += `<span class="t-code">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="t-bold">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="t-em">${esc(m[3])}</span>`;
      else out += `<span class="t-link">${esc(m[4])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(l.slice(last));
  }

  function hlMd(src) {
    return String(src || "")
      .split("\n")
      .map(hlLine)
      .join("\n");
  }

  // 只允许同时开一个编辑区(标准文件 or 模板),高亮按名称类型自动选 JSON/Markdown
  let activeName = $derived(tplEdit ? tplEdit.name : editing ? editing.name : "");
  let activeContent = $derived(tplEdit ? tplEdit.content : editing ? editing.content : "");
  let hlHtml = $derived(activeContent ? (/\.md$/i.test(activeName) ? hlMd(activeContent) : hlJson(activeContent)) : "");

  function syncScroll() {
    if (preEl) {
      preEl.scrollTop = taEl.scrollTop;
      preEl.scrollLeft = taEl.scrollLeft;
    }
  }
  // 内容变化时高亮层跟随滚动位置(避免换行变化后错位)
  $effect(() => {
    void activeContent;
    syncScroll();
  });
</script>

<section class="settings-page">
  <div class="group">
    <h2>界面主题</h2>
    <div class="row theme-row">
      <button class="theme-btn {theme === 'dark' ? 'on' : ''}" data-testid="theme-dark" onclick={() => setTheme('dark')}>🌙 暗色</button>
      <button class="theme-btn {theme === 'light' ? 'on' : ''}" data-testid="theme-light" onclick={() => setTheme('light')}>☀️ 亮色</button>
    </div>
  </div>

  <div class="group">
    <h2>关闭行为</h2>
    <p class="desc">点窗口右上角 X（或 Alt+F4）时的行为：退出 = 关闭程序；缩到托盘 = 隐藏到系统托盘，随时点托盘图标重新打开。</p>
    <div class="row close-row">
      <button class="theme-btn {appSettings.closeAction !== 'tray' ? 'on' : ''}" data-testid="close-exit" onclick={() => { appSettings.closeAction = "exit"; saveSettings(); }}>退出</button>
      <button class="theme-btn {appSettings.closeAction === 'tray' ? 'on' : ''}" data-testid="close-tray" onclick={() => { appSettings.closeAction = "tray"; saveSettings(); }}>缩小到托盘</button>
    </div>
    {#if appSettings.closeAction === "tray"}
      <p class="tip">托盘模式下点 X 只会隐藏窗口：有运行中的终端也会继续跑；彻底退出请用托盘菜单「退出」。</p>
    {/if}
  </div>

  <div class="group">
    <h2>终端</h2>
    <p class="desc">真实 claude 终端（xterm）的显示字号，改动即时生效。</p>
    <div class="row font-row">
      <label class="fitem">
        <span>终端字体大小</span>
        <input type="number" min="10" max="24" step="1" data-testid="term-fontsize" bind:value={appSettings.terminalFontSize} onchange={() => saveSettings()} />
        <small>px（10–24，默认 13）</small>
      </label>
    </div>
  </div>

  <div class="group">
    <h2>claude 可执行文件</h2>
    <p class="desc">
      留空则自动发现 claude
      {#if cur.version}
        （当前为真实 claude v{cur.version}）
      {:else}
        （探测中…）
      {/if}
      。
      <code title={cur.bin || ""}>{cur.bin || "claude"}</code>
    </p>
    <div class="row">
      <input data-testid="s-path" bind:value={appSettings.claudePath} placeholder="例如 /home/wanji/.npm-global/bin/claude（Windows 常为 %APPDATA%\npm\claude.cmd）" />
      <button class="ghost" onclick={testPath}>测试</button>
      <button class="ghost" data-testid="s-update" onclick={doUpdate} disabled={updating}>更新</button>
      <button class="primary" data-testid="s-save-path" onclick={() => { saveSettings(); autoResolve(); }}>保存</button>
    </div>
    {#if pathMsg}<div class="ok">{pathMsg}</div>{/if}
    {#if pathErr}<div class="err">{pathErr}</div>{/if}
    {#if updateMsg}<div class="ok">{updateMsg}</div>{/if}
    <div class="guide">
      <button class="link" data-testid="guide-link" onclick={() => window.claude.openExternal(GUIDE_URL)}>📖 claude 安装指南</button>
      <!-- 日志图标:内联 SVG(🗎 U+1F5CE 属杂项符号,Ubuntu 常见字体缺字形会显示成异常) -->
      {#if logPath}<span class="log-ref" title="问题排查用"><svg class="log-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>日志：{logPath}</span>{/if}
    </div>
  </div>

  <div class="group">
    <h2>云连接（手机远程）</h2>
    <p class="desc">填好云中转服务地址与 token 后点「开启连接」，电脑即以设备身份上线；手机浏览器访问同样的地址（http://服务器IP:端口）可查看并远程操作本机 claude 会话，手机上发的消息会同步显示在电脑终端里。</p>
    <div class="cloud-grid">
      <label class="fitem">
        <span>服务器地址</span>
        <input data-testid="cloud-url" bind:value={cloudCfg.serverUrl} placeholder="ws://服务器IP:8123 或 ws://域名:端口" autocomplete="off" />
      </label>
      <label class="fitem">
        <span>token（验证密钥）</span>
        <input type="password" data-testid="cloud-token" bind:value={cloudCfg.token} placeholder="服务器 config.json 里的 token" autocomplete="off" />
      </label>
      <label class="fitem">
        <span>设备名称</span>
        <input data-testid="cloud-name" bind:value={cloudCfg.deviceName} placeholder="桌面电脑（手机上显示的名字）" autocomplete="off" />
      </label>
    </div>
    <div class="cloud-actions">
      <button class="primary" data-testid="cloud-on" onclick={() => saveCloud(true)}>开启连接</button>
      <button class="ghost" data-testid="cloud-off" onclick={() => saveCloud(false)}>断开</button>
      <span class="cloud-badge {cloudBadge.cls}" data-testid="cloud-status" title={cloudSt.reason || ""}><span class="dot"></span>{cloudBadge.txt}{#if cloudBadge.t}<code class="cid" title="设备ID（手机端不可见，仅供排查）">{cloudBadge.t}</code>{/if}</span>
    </div>
    {#if cloudMsg}<div class="msgline">{cloudMsg}</div>{/if}
    <p class="tip">连接后手机访问 <code>http://{cloudCfg.serverUrl ? cloudCfg.serverUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "") : "服务器IP:端口"}</code> ，填入同一 token 即可。手机指令直接落到电脑端真实终端，回复自动传回。</p>
  </div>

  <div class="group">
    <h2>命名配置模板</h2>
    <p class="desc">把常用配置存成「名字 + 内容」的模板（数据保存在应用自己的 userData json 里），通过下拉选择后一键写入 <code>~/.claude/settings.json</code> 并立即生效。</p>
    <div class="tmpl-bar">
      <button class="ghost" data-testid="tmpl-new" onclick={startTplNew}>＋ 新建命名配置</button>
      <span class="apply-row">
        <select data-testid="tmpl-select" bind:value={applySel}>
          <option value="">— 选择配置应用 —</option>
          {#each templates.items as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
        <button class="primary small" data-testid="tmpl-apply" onclick={() => { const t = templates.items.find((x) => x.id === applySel); doApply(applySel, t && t.name); }} disabled={!applySel}>应用 → settings.json</button>
      </span>
    </div>
    {#if tplMsg}<div class="msgline">{tplMsg}</div>{/if}

    <div class="tmpls">
      {#if !templates.loaded}
        <p class="hint">加载中…</p>
      {:else if templates.items.length === 0}
        <p class="hint">还没有命名配置，点左上「新建命名配置」创建一个，或在下拉中直接选用已有模板。</p>
      {:else}
        {#each templates.items as t (t.id)}
          <div class="tmpl" data-testid="tmpl-item">
            <div class="tmpl-main">
              <div class="name">{t.name}</div>
            </div>
            <span class="cfg-actions">
              <button class="ghost small use" data-testid="tmpl-use" onclick={(e) => useTpl(t, e)}>使用</button>
              <button class="ghost small" data-testid="tmpl-edit" onclick={(e) => startTplEdit(t, e)}>编辑</button>
              <button class="ghost small danger" data-testid="tmpl-del" onclick={(e) => delTpl(t, e)}>删除</button>
            </span>
          </div>
        {/each}
      {/if}
    </div>

    {#if tplEdit}
      <div class="edwrap" data-testid="tmpl-editor-panel">
        <div class="edhd">
          <div class="edname">
            <span>配置名称：</span>
            <input class="tname" data-testid="tmpl-name" bind:value={tplEdit.name} placeholder="如：我的常用环境（含 hooks/MCP）" />
          </div>
          <button class="ghost small" onclick={closeTpl}>收起 ✕</button>
        </div>
        <div class="edarea edit-h">
          <pre class="hl" bind:this={preEl} aria-hidden="true">{@html hlHtml}</pre>
          <textarea
            class="editor"
            data-testid="tmpl-editor"
            bind:this={taEl}
            bind:value={tplEdit.content}
            spellcheck="false"
            placeholder={'填写配置内容（JSON，保存后应用时会整份校验并写入 settings.json）'}
            onscroll={syncScroll}
          ></textarea>
        </div>
        <div class="edft">
          <span class="msg">{tplSaveMsg}</span>
          <span class="actions">
            <button class="ghost small" onclick={closeTpl}>取消</button>
            <button class="primary small" data-testid="tmpl-save" onclick={saveTpl}>保存</button>
          </span>
        </div>
      </div>
    {/if}
  </div>

  <div class="group">
    <h2>Claude 配置文件（直接编辑）</h2>
    <p class="desc">直接编辑真实 claude 的配置，保存后下次调用立即生效。点击列表项载入编辑区。</p>
    <div class="configs">
      {#each appSettings.configFiles as cfg (cfg.name)}
        <div class="cfg {editing && editing.name === cfg.name ? 'on' : ''}" data-testid="config-item" onclick={() => openEditor(cfg.name)}>
          <div class="cfg-main">
            <div class="name">{cfg.name}{cfg.exists ? "" : "（未创建）"}</div>
            <div class="path" title={cfg.path}>{cfg.path}</div>
          </div>
          <span class="cfg-actions">
            {#if cfg.exists}
              <button class="ghost small danger" data-testid="config-del" onclick={(e) => onDeleteConfig(cfg, e)}>删除</button>
            {/if}
          </span>
        </div>
      {/each}
    </div>
    {#if cfgMsg}<div class="msgline">{cfgMsg}</div>{/if}

    {#if editing}
      <div class="edwrap" data-testid="cfg-editor-panel">
        <div class="edhd">
          <div class="edname">
            <span>编辑：{editing.name}{editing.exists ? "" : "（将新建）"}</span>
            <div class="path" title={editing.path}>{editing.path}</div>
          </div>
          <button class="ghost small" onclick={closeEditor}>收起 ✕</button>
        </div>
        <div class="edarea edit-h">
          <pre class="hl" bind:this={preEl} aria-hidden="true">{@html hlHtml}</pre>
          <textarea
            class="editor"
            data-testid="cfg-editor"
            bind:this={taEl}
            bind:value={editing.content}
            spellcheck="false"
            onscroll={syncScroll}
          ></textarea>
        </div>
        <div class="edft">
          <span class="msg">{saveMsg}</span>
          <span class="actions">
            <button class="ghost small" onclick={closeEditor}>取消</button>
            <button class="primary small" data-testid="save-config" onclick={saveConfig}>保存{editing.exists ? "" : "（新建）"}</button>
          </span>
        </div>
      </div>
    {/if}
  </div>
  <!-- 应用版本 / 关于 -->
  <footer class="ver">
    <span class="logo">Claude <b>Desk</b></span>
    <span data-testid="app-version">v{appVer || "…"}</span>
  </footer>
</section>

<style>
  .settings-page { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 24px 28px; }
  /* 底部「关于」:应用名 + 版本号 */
  .ver { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
  .ver b { color: var(--accent); font-weight: 700; }
  .group { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
  .group h2 { font-size: 15px; margin: 0 0 4px; }
  .desc { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .tip { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
  .close-row { margin-top: 4px; }
  .desc code { background: var(--bg); padding: 1px 6px; border-radius: 4px; color: var(--accent); white-space: nowrap; max-width: 360px; display: inline-block; vertical-align: bottom; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; gap: 8px; }
  .theme-btn { background: var(--bg); border: 1px solid var(--border-strong); color: var(--muted); border-radius: 8px; padding: 8px 18px; cursor: pointer; }
  .theme-btn.on { color: var(--text); border-color: var(--accent); background: var(--border); }
  .row input, .tmpl-bar select { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 9px 12px; font: inherit; }
  .row input:focus, .tmpl-bar select:focus { outline: none; border-color: var(--accent); }
  .row > input { flex: 1; min-width: 0; }
  .font-row { align-items: flex-end; }
  .fitem { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .fitem input { width: 120px; background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 9px 12px; font: inherit; }
  .fitem input:focus { outline: none; border-color: var(--accent); }
  .fitem small { font-size: 11px; }

  /* 云连接 */
  .cloud-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .cloud-grid .fitem input { width: 100%; }
  .cloud-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cloud-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; margin-left: 4px; }
  .cloud-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted2); display: inline-block; }
  .cloud-badge.on .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .cloud-badge.ing .dot { background: #d29922; }
  .cloud-badge.off .dot { background: var(--danger); }
  .cloud-badge.on { color: var(--ok); }
  .cloud-badge.ing { color: #d29922; }
  .cloud-badge.off { color: var(--danger); }
  .cloud-badge .cid { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); font-weight: 400; background: var(--bg); padding: 1px 6px; border-radius: 4px; }
  .primary { background: var(--btn-green); border: none; color: #fff; border-radius: 8px; padding: 9px 16px; cursor: pointer; font-weight: 600; }
  .primary.small { font-size: 12px; padding: 6px 12px; }
  .ghost { background: var(--border); border: 1px solid var(--border-strong); color: var(--text); border-radius: 8px; padding: 8px 14px; cursor: pointer; }
  .ghost.small { padding: 5px 10px; font-size: 12px; }
  .ghost.danger { color: var(--danger); }
  .ghost.use { color: var(--ok); }
  .ok { color: var(--ok); font-size: 13px; margin-top: 8px; }
  .err { color: var(--danger); font-size: 13px; margin-top: 8px; }
  .guide { margin-top: 12px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .log-ref { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; display: inline-flex; align-items: center; gap: 4px; }
  .log-ref .log-ico { width: 13px; height: 13px; flex: 0 0 auto; }
  .link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 0; }
  .link:hover { text-decoration: underline; }

  /* 命名配置模板 */
  .tmpl-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .apply-row { display: flex; gap: 6px; align-items: center; }
  .apply-row select { min-width: 220px; padding: 7px 10px; font-size: 13px; }
  .tmpls { display: flex; flex-direction: column; gap: 8px; }
  .tmpl { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg); border: 1px dashed var(--border-strong); border-radius: 8px; padding: 10px 14px; }
  .tmpl:hover { border-color: var(--accent); }
  .tmpl-main { min-width: 0; }
  .tmpl .name { font-weight: 600; color: var(--text); font-size: 13px; }
  .hint { color: var(--muted2); font-size: 13px; padding: 6px 0; }

  /* 配置文件列表:路径不换行,超出省略 */
  .configs { display: flex; flex-direction: column; gap: 8px; }
  .cfg { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; cursor: pointer; }
  .cfg:hover { border-color: var(--border-strong); }
  .cfg.on { border-color: var(--accent); background: var(--sel-bg); }
  .cfg-main { flex: 1 1 auto; min-width: 0; }
  .name { font-weight: 600; color: var(--text); font-size: 13px; }
  .path { color: var(--muted2); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cfg-actions { display: flex; gap: 6px; flex: 0 0 auto; }
  .msgline { color: var(--muted); font-size: 12px; margin-top: 8px; }

  /* 单编辑区(中央 textarea) */
  .edwrap { margin-top: 14px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 12px; background: var(--code-bg); }
  .edhd { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .edname { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .edname > span { font-weight: 600; color: var(--text); font-size: 13px; }
  .edname .path { max-width: 100%; }
  .edname .tname { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 100%; }
  .edname .tname:focus { outline: none; border-color: var(--accent); }
  .edarea { position: relative; border: 1px solid var(--border); border-radius: 8px; background: var(--code-bg); }
  .edit-h { height: 260px; }
  .hl, .editor { position: absolute; inset: 0; margin: 0; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; tab-size: 2; overflow: auto; }
  .hl { color: var(--text2); pointer-events: none; }
  .editor { z-index: 1; width: 100%; height: 100%; background: transparent; color: transparent; caret-color: var(--accent); border: none; resize: none; outline: none; }
  .editor::placeholder { color: var(--muted2); }
  .editor::selection { background: var(--sel-strong); }
  /* 高亮配色:走主题变量(--t-*,见 app.html),亮暗主题各自适配。
     注意 .t-* 类只由 hlJson/hlMd 在 JS 里拼接生成、模板中无静态使用,
     Svelte 会把这类"未使用"规则直接剔除(编译成 (unused) 注释,产物里没有颜色),
     必须用 :global 显式标记保留,否则高亮只有 span 结构没有颜色 */
  :global(.t-key) { color: var(--t-key); }
  :global(.t-str) { color: var(--t-str); }
  :global(.t-num) { color: var(--t-num); }
  :global(.t-lit) { color: var(--t-lit); }
  :global(.t-p) { color: var(--muted2); }
  :global(.t-h) { color: var(--accent); font-weight: 700; }
  :global(.t-bold) { color: var(--text); font-weight: 700; }
  :global(.t-em) { color: var(--text2); font-style: italic; }
  :global(.t-link) { color: var(--accent); text-decoration: underline; }
  :global(.t-code) { color: var(--t-code); background: rgba(56, 139, 253, .12); border-radius: 3px; }
  .edft { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; gap: 12px; }
  .msg { color: var(--muted); font-size: 12px; min-width: 0; }
  .actions { display: flex; gap: 8px; }
</style>
