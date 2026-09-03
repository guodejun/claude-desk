// 上下文压测驱动(CD_CTX_AUTOTEST=1):持续对一个【真实后端】会话喂消息,
// 观察 contextState 统计值全程是否跟得住 jsonl 真实 usage、到顶后 claude 自动压缩
// 是否被统计正确反映(used 高位突然回落 = compact)。
// 用法:
//   CD_CTX_AUTOTEST=1 CD_CTX_DIR=<目录> [CD_CTX_ROUNDS=0 无限直到 compact | N 固定轮数]
//   [CD_CTX_QUICK=1 快捷验证模式:只跑几轮确认 jsonl 精确源在增长] [CD_CTX_TIMEOUT_MIN=120]
// 注意:必须用「会写真实 usage 的后端」目录(/tmp 那个后端不写计数,测不了精确);
// 每轮以唯一 marker 结尾判定本轮回答完成(轮询 jsonl 出现该 marker)。
const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");

module.exports = async function runCtxDrive(win) {
  const exec = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cwd = process.env.CD_CTX_DIR || "/media/wanji/data1TB3/gdj/ctxstress";
  const quick = process.env.CD_CTX_QUICK === "1";
  const rounds = Number(process.env.CD_CTX_ROUNDS || 0); // 0=跑到 compact
  const cycleMs = Number(process.env.CD_CTX_CYCLE_MS || 300000); // 单轮最长等待
  const timeoutMin = Number(process.env.CD_CTX_TIMEOUT_MIN || 180);

  const log = (s) => console.log(s);
  const ctx = require("./contextmon.cjs");
  const pty = require("./pty.cjs"); // 提交通道参照:主进程直写(队列 tunnel 同款,已验证可提交)
  const persistence = require("./persistence.cjs");
  // 会话锚:自造 claude sessionId 并用 --resume <该 id> 显式创建/复用,jsonl 文件名=该 id、
  // 固定落在 <cwd slug>/<id>.jsonl —— 统计/扫描/锁定全程共用同一 id,不依赖 mtime 扫描,
  // 也不受 claude 自动 resume「最近会话」的污染(那是之前锁到旧会话文件的根因)。
  const ptySid = randomUUID();
  let sid = null, sObj = null;
  // 诊断:dump 终端屏幕文本(前 n 字符),看输入框状态/提交与否
  function dumpScreen(tag) {
    return exec(`(() => {
      const x = document.querySelector('.xterm');
      if (!x) return "NO_XTERM";
      let s = x.textContent.replace(/\\u0000/g, "").trim();
      return (${JSON.stringify(tag + " >> ")}) + s.slice(-400);
    })()`).catch(() => null).then((t) => log(String(t)));
  }
  // jsonl 权威值:最后一次 usage 的 in/out(与 contextState 同源,用于打印核对)
  function lastUsage() {
    const r = ctx.scanJsonl(sid, sObj);
    return { in: r.in, out: r.out, file: r.file };
  }
  // 提交:分帧模拟打字(小块+节奏+回车)。实测一次性把整段文本写进 pty 时,超过十几个字符后
  // claude TUI 会把输入吞进输入行但不提交(或整段丢弃),短文本却全部成功——分帧可绕开这个坑。
  async function typeText(text) {
    const STEP = 8, GAP = 80;
    for (let i = 0; i < text.length; i += STEP) {
      pty.write(sid, text.slice(i, i + STEP));
      await wait(GAP);
    }
    pty.write(sid, "\r");
  }

  // 本轮完成判定:jsonl 是否出现本轮专属 marker;顺带探测 compact(压缩记录/行)
  // 本轮完成判定:jsonl 是否出现本轮专属 marker;顺带探测 compact(压缩记录/行)
  // 锁定规则:查找范围【始终限定 CD_CTX_DIR 的 slug 目录】,全盘扫会命中宿主 Claude Code
  // 会话(本进程 cwd 的 slug)与其它项目,不可控。交互 attach 的 claude 会 resume cwd 最近的
  // 活跃会话(本项目实测会粘到游离 claude 的 97d898d7),所以:
  //   - 初始:mtime 最新(lazy)
  //   - 迁移:每轮在该目录内找「含本轮 marker」的文件,命中即锁定并写回 persistence
  //     (contextState 与驱动共用同一 jsonl 锚,统计才一致)
  let lockedFile = null;
  function listCandJsonls() {
    try {
      return fs.readdirSync(ctx.projectDirOf(cwd))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ p: path.join(ctx.projectDirOf(cwd), f), mt: fs.statSync(path.join(ctx.projectDirOf(cwd), f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
    } catch { return []; }
  }
  function writeBackSessionId() {
    try {
      const ps = persistence.getSession(sid);
      if (ps && ps.claudeSessionId !== sObj.claudeSessionId) {
        ps.claudeSessionId = sObj.claudeSessionId || null;
        persistence.flush(sid);
      }
    } catch {}
  }
  function lockAttach() {
    const c = listCandJsonls()[0];
    if (c) {
      lockedFile = c.p;
      sObj.claudeSessionId = path.basename(c.p, ".jsonl");
      writeBackSessionId();
      log("CTXDRIVE 锁定 jsonl: " + lockedFile);
      return true;
    }
    log("CTXDRIVE 警告: slug 目录无 jsonl");
    return false;
  }
  function roundState(marker) {
    let hasMarker = false, compact = false;
    // 每轮在受限目录内核对/迁移锁定:marker 出现在哪个文件就用哪个(已含 marker 的旧文件保持)
    const cands = listCandJsonls();
    let pick = null;
    if (marker && cands.length) {
      for (const c of cands) {
        try {
          if (fs.readFileSync(c.p, "utf8").includes(marker)) { pick = c.p; break; }
        } catch {}
      }
    }
    if (!pick && cands.length) pick = cands[0].p;
    if (pick && pick !== lockedFile) {
      lockedFile = pick;
      sObj.claudeSessionId = path.basename(pick, ".jsonl");
      writeBackSessionId();
      log("CTXDRIVE 锁定 jsonl: " + lockedFile);
    }
    try {
      if (lockedFile) {
        const txt = fs.readFileSync(lockedFile, "utf8");
        hasMarker = marker ? txt.includes(marker) : false;
        const r = ctx.scanJsonl(sid, sObj); // 内置压缩识别(chars 也会在压缩后重置)
        compact = r.compacted;
      }
    } catch {}
    return { hasMarker, compact };
  }
  // 调试:全盘扫 jsonl 是否出现某段文本(判定输入是否真的提交,而非只进输入框)
  function dumpSentinel(tag, needle) {
    const base = path.join(os.homedir(), ".claude", "projects");
    const hits = [];
    try {
      for (const d of fs.readdirSync(base)) {
        if (d.startsWith(".")) continue;
        for (const f of fs.readdirSync(path.join(base, d))) {
          if (!f.endsWith(".jsonl")) continue;
          const p = path.join(base, d, f);
          const txt = fs.readFileSync(p, "utf8");
          if (txt.includes(needle)) hits.push(path.basename(p) + "#" + txt.lastIndexOf(needle));
        }
      }
    } catch {}
    log(tag + " sentinel=" + JSON.stringify(needle) + " -> " + (hits.length ? "HIT " + hits.join(" | ") : "NONE"));
  }

  try {
    // 1. 等首屏
    for (let i = 0; i < 150; i++) {
      if (await exec(`!!document.querySelector("[data-testid=create-btn]")`).catch(() => false)) break;
      await wait(100);
    }
    // 2. 建会话(真实后端;acceptEdits 保持 TUI 正常提交——skip-permissions 会让 claude
    //    进 manual mode,输入被暂停不提交;新目录信任已在 ~/.claude.json 预登记)。
    //    注意:不能加 --resume <自造id>(claude 对不存在的 id 直接报错退出);attach 是否
    //    resume 旧会话由 claude 自己决定,锁定走 slug 目录内的 marker 迁移。
    const created = JSON.parse(await exec(`window.claude.sessionCreate({ cwd: ${JSON.stringify(cwd)}, argText:"--permission-mode acceptEdits" }).then(x => JSON.stringify(x))`));
    sid = created.id;
    sObj = { id: sid, cwd, model: null, messages: [] };
    log("CTXDRIVE 建会话 " + sid + " @ " + cwd);
    await win.loadURL(global.__baseUrl + "session/" + sid);
    let ready = false;
    for (let i = 0; i < 300; i++) {
      const err = await exec(`(document.querySelector('[data-testid=term-err]')||{textContent:""}).textContent`).catch(() => "");
      if (err && err.trim()) { log("CTXDRIVE 终端打开失败: " + err); await wait(8000); break; }
      const bytes = Number(await exec(`window.__termBytes || 0`).catch(() => 0));
      if (bytes > 200) { ready = true; break; }
      await wait(300);
    }
    if (!ready) { log("CTXDRIVE_FAIL 终端未就绪(bytes 未增长)"); return; }
    log("CTXDRIVE 终端就绪,开始压测…");
    lockAttach(); // 现在就锁定 attach 的 jsonl(sObj.claudeSessionId 尽早生效,stat 源立刻精确)
    // 预热:attach claude 启动后「bytes>200 就绪」≠「输入可提交」,过早发送会进输入框但不提交。
    // 发一条短握手,轮询 jsonl 出现预热独有回文「压测就绪」= 它真被处理过 → 之后才开闸。
    await wait(5000);
    pty.write(sid, "预热：只回复四字『压测就绪』\r");
    log("CTXDRIVE 预热握手已发送,等待就位…");
    let warmOk = false;
    for (let i = 0; i < 20; i++) {
      await wait(2000);
      try {
        const txt = fs.readFileSync(roundState(null) && lockedFile, "utf8");
        if (txt.includes("压测就绪")) { warmOk = true; log("CTXDRIVE 预热确认(jsonl 出现回文)"); break; }
      } catch {}
      if (lastUsage().in > 0) { warmOk = true; log("CTXDRIVE 预热确认(usage 出现 in>0)"); break; }
    }
    await wait(4000); // claude 可能仍在输出首屏/开场白,再给其完全安定(spinner/光标就绪)才可提交
    await wait(3000); // 再给一段安定,确保 claude 从上条回答中解脱

    // 调试模式:双通道对照发送 —— A 走渲染层 terminalWrite(与用户手打同路径),
    // B 走主进程 pty 直写(队列 tunnel 同款,已验证能提交)。看哪条能真正提交(判据:
    // jsonl 出现 sentinel / 屏幕出现 ❯ 行)。同时确认“文本进输入框但回车没提交”的现象。
    if (process.env.CD_CTX_DEBUG === "1") {
      await wait(3000); // 比之前多等一拍,排除“claude 还在开场白、输入模式未就绪”的影响
      await dumpScreen("[手前]");
      const ctxt = await pty.command(sid, "/context\r").catch((e) => String(e));
      log("CTXDRIVE[/context] >> " + (ctxt && ctxt.text ? ctxt.text.replace(/\n+/g, " | ").slice(0, 400) : JSON.stringify(ctxt)));
      await exec(`window.claude.terminalWrite(${JSON.stringify(sid)}, ${JSON.stringify("只回复：握手A\r")})`).catch(() => log("A write err"));
      await wait(6000);
      await dumpScreen("[A_6s]");
      dumpSentinel("[dan]", "握手A");
      pty.write(sid, "只回复：握手B\r");
      await wait(6000);
      await dumpScreen("[B_6s]");
      dumpSentinel("[dbn]", "握手B");
      await wait(8000);
      await dumpScreen("[B_14s]");
      dumpSentinel("[dbx]", "握手B");
    }

    const start = Date.now();
    const deadline = start + timeoutMin * 60000;
    let i = 0, compactSeen = false, extra = 0;
    let prevUsed = null, prevSrc = null;
    const totalRounds = quick
      ? (rounds > 0 ? Math.min(rounds, 4) : 4)
      : (rounds > 0 ? rounds : Infinity);
    const samples = [];

    while (i < totalRounds) {
      if (Date.now() > deadline) { log("CTXDRIVE_TIMEOUT 达时长上限,结束观察"); break; }
      const round = (i + 1);
      const marker = "__CD_STRESS_" + Date.now() + "_" + round + "__";
      // 每轮指令:输出尽量长的正文(拉高每轮上下文增量),以唯一 marker 收尾
      const topics = ["云计算","操作系统","网络协议","数据库索引","编译原理","分布式系统","人工智能训练","内存管理"];
      const topic = topics[(round - 1) % topics.length];
      // 提示词保持【短】(实测 >45 字符的 prompt 经 pty 提交不可靠,短的全部正常);
      // 回答长度用「约N字」参数控制 —— 提交靠短 prompt,上下文增长靠长回答。
      // marker 放回答末尾(放 prompt 里的话提交瞬间 jsonl 就有 marker,失去"回答完成"判定意义)
      const prompt = `请用一段约${quick ? "300" : "600"}字中文科普正文介绍${topic},连续直接输出,回答末尾写 ${marker}。`;
      // 手动压缩开关:CD_CTX_COMPACT_AT=N,到第 N 轮发 /compact 验证统计回落(attach 后端窗口
      // 1M,真实 auto-compact 不可达,用 /compact 触发同一压缩标记机制等价验证)。
      if (process.env.CD_CTX_COMPACT_AT && round === Number(process.env.CD_CTX_COMPACT_AT)) {
        log("CTXDRIVE_MANUAL_COMPACT 第 " + round + " 轮触发 /compact");
        await pty.compact(sid);
        await wait(6000);
      }
      // 发送:分帧模拟打字(prompt 虽短也要分帧——TUI 对一次性大写入不可靠,长回答由
      // claude 自己输出,不受影响);之后的 marker 循环负责等「回答完成」。
      await typeText(prompt);
      // 等本轮 marker 出现在 jsonl,或超时
      const cycleStart = Date.now();
      while (Date.now() - cycleStart < cycleMs) {
        const st = roundState(marker);
        if (st.hasMarker) break;
        await wait(1500);
      }
      // 记录统计
      const cs = ctx.contextState(sid);
      const ju = lastUsage();
      const growth = prevUsed === null ? null : cs.used - prevUsed;
      const line =
        `CTXDRIVE n=${round} used=${cs.used} max=${cs.max} pct=${(cs.pct * 100).toFixed(1)}% ` +
        `src=${cs.source} jsonl_in=${ju ? ju.in : "-"} out=${ju ? ju.out : "-"} ` +
        `delta=${growth === null ? "-" : growth} src_prev=${prevSrc || "-"}` +
        ` manual=${cs.manual ? "Y" : "n"} hit=${cs.hitRate ? Math.round(cs.hitRate * 100) + "%" : "0"} ` +
        (cs.note ? `note="${cs.note}"` : "");
      log(line);
      samples.push({ n: round, used: cs.used, src: cs.source, pct: cs.pct });
      prevUsed = cs.used; prevSrc = cs.source;

      // 探测 compact:used 高位骤降(jsonl 出现压缩记录也可);触发后再跑 3 轮观察回落稳定
      const rSt = roundState(null);
      if (rSt.compact && !compactSeen) { compactSeen = true; log("CTXDRIVE_COMPACT 检测到自动压缩标记 !!"); }
      if (compactSeen) {
        extra++;
        if (extra >= 3) { log("CTXDRIVE_END 压缩后已观察 " + extra + " 轮,数据见上"); break; }
      }
      i++;
      await wait(2500); // 节奏:等 claude 完全停笔再发下轮(过早发送会被 TUI 吞输入,不改行不行)
    }

    // 总结
    const spent = Math.round((Date.now() - start) / 1000);
    const first = samples[0], last = samples[samples.length - 1];
    log(`CTXDRIVE_SUMMARY rounds=${samples.length} ${spent}s used ${first ? first.used : 0} -> ${last ? last.used : 0} (${last ? ((last.used - first.used) / 1000).toFixed(0) : 0}K) src=${last ? last.src : "?"} compact=${compactSeen ? "YES" : "not-yet"}`);
    log("CTXDRIVE_DONE");
    try { await exec(`(() => { if (window.claude && window.claude.terminalClose) return window.claude.terminalClose(${JSON.stringify(sid)}); })()`); } catch {}
  } catch (e) {
    log("CTXDRIVE_FAIL EXCEPTION " + String((e && e.stack) || e));
  }
};
