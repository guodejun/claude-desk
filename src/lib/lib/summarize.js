// 纯函数:把会话 messages 整理成本地纪要(不调 claude,即时)
// rounds = [{ user, pending, claude:{ texts, tools, errors }, charCount }]
// - user:该轮我发的第一条文本
// - claude.texts:该轮 assistant 的 text 块(纪要正文)
// - claude.tools/errors:工具名列表/报错
// - pending:发问后尚无人回复
export function summarize(messages) {
  const rounds = [];
  let pendingUser = null;

  const pushPending = () => {
    if (pendingUser === null) return;
    rounds.push({ user: pendingUser, pending: true, claude: { texts: [], tools: [], errors: [] }, charCount: 0 });
    pendingUser = null;
  };

  for (const m of messages || []) {
    if (m.role === "user") {
      pushPending();
      pendingUser = m.text || "";
    } else if (m.role === "assistant") {
      const blocks = m.blocks || [];
      const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
      const tools = blocks.filter((b) => b.type === "tool").map((b) => b.name);
      const errors = blocks.filter((b) => b.type === "error").map((b) => b.text);
      if (pendingUser !== null) {
        rounds.push({
          user: pendingUser,
          pending: false,
          claude: { texts, tools, errors },
          charCount: texts.join("\n").length,
        });
        pendingUser = null;
      } else if (rounds.length) {
        // 无对应用户消息的 assistant(续写/流式分多条):并入上一轮
        const r = rounds[rounds.length - 1];
        r.claude.texts = [...r.claude.texts, ...texts];
        r.claude.tools = Array.from(new Set([...r.claude.tools, ...tools]));
        r.claude.errors = [...r.claude.errors, ...errors];
        r.charCount = r.claude.texts.join("\n").length;
      }
    }
  }
  pushPending();
  return rounds;
}

// 去掉 Markdown 记号,取一句"要点"
function firstPoint(text, max = 60) {
  let s = (text || "")
    .replace(/```[\s\S]*?```/g, " ") // 代码块
    .replace(/`/g, "")
    .replace(/[*_~#>|]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-+•]\s*/, "")
    .replace(/!?\[(.*?)\]\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 总结式纪要(非问答式):对整段对话做分类 Markdown 总结(本地即时)
export function summarizeDoc(messages) {
  const userMsgs = [];
  const roundPoints = []; // 每轮 Claude 回答的首个要点
  const toolCount = new Map();
  const pendings = [];
  let msgCount = 0;
  let chars = 0;
  let pendingUser = null;
  let lastPending = true;

  const flushUser = () => {
    if (pendingUser !== null && lastPending) pendings.push(pendingUser);
    pendingUser = null;
  };

  for (const m of messages || []) {
    msgCount++;
    if (m.role === "user") {
      pendingUser = m.text || "";
      userMsgs.push(pendingUser);
      lastPending = true;
    } else if (m.role === "assistant") {
      const blocks = m.blocks || [];
      const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
      for (const b of blocks) {
        if (b.type === "tool") toolCount.set(b.name, (toolCount.get(b.name) || 0) + 1);
      }
      if (texts.length) {
        roundPoints.push(firstPoint(texts.join("\n")));
        lastPending = false;
        for (const t of texts) chars += t.length;
      }
    }
    if (m.role === "user") chars += (m.text || "").length;
  }
  flushUser();

  const topic = userMsgs[0] ? userMsgs[0].slice(0, 160) : "";

  const lines = [];
  lines.push(`## 🎯 对话主题`);
  lines.push(topic ? `> ${topic}` : `> （暂无内容）`);
  lines.push("");
  lines.push(`## 💡 结论要点`);
  if (roundPoints.length) {
    roundPoints.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  } else {
    lines.push("（尚无 Claude 回复）");
  }
  lines.push("");
  lines.push(`## 🧰 用到的工具`);
  const tools = [...toolCount.entries()].map(([n, c]) => `${n}（${c}次）`).join("、");
  lines.push(tools ? tools : "（无工具调用）");
  lines.push("");
  lines.push(`## ⚠️ 待办 / 未解决`);
  lines.push(pendings.length ? pendings.map((p) => `- ${p.slice(0, 80)}`).join("\n") : "（无待处理）");
  lines.push("");
  lines.push(`## 📦 上下文`);
  const tok = Math.round(chars / 4);
  lines.push(`共 ${msgCount} 条消息 · ${chars.toLocaleString()} 字符 · ≈${tok.toLocaleString()} tok`);

  return lines.join("\n");
}
