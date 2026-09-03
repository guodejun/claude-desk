// 配置管理两层：
// 1) 标准文件直编：settings.json / settings.local.json / CLAUDE.md(保持现状,直接改真实 claude 配置)
// 2) 命名配置模板：以「名字 + 内容」形式存进应用自己 userData 下的 config-templates.json,
//    全部 增/删/改/查 都在这份 JSON 里进行;「使用」时把模板内容一键写入 ~/.claude/settings.json。
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const WHITELIST = [
  { name: "settings.json", path: path.join(os.homedir(), ".claude", "settings.json") },
  { name: "settings.local.json", path: path.join(os.homedir(), ".claude", "settings.local.json") },
  { name: "CLAUDE.md", path: path.join(os.homedir(), ".claude", "CLAUDE.md") },
];

function entryOf(name) {
  const e = WHITELIST.find((x) => x.name === name);
  if (!e) throw new Error(`未知配置文件: ${name}`);
  return e;
}

function listConfigFiles() {
  return WHITELIST.map((e) => ({ name: e.name, path: e.path, exists: fs.existsSync(e.path) }));
}

function readConfig(name) {
  const e = entryOf(name);
  let content = "";
  try {
    content = fs.readFileSync(e.path, "utf8");
  } catch {
    content = "";
  }
  return { name: e.name, path: e.path, exists: content !== "" && fs.existsSync(e.path), content };
}

function writeConfig(name, content) {
  const e = entryOf(name);
  if (typeof content !== "string") throw new Error("内容必须为字符串");
  // .json 文件先做 JSON 合法性校验,非法直接拒绝
  if (e.name.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (err) {
      throw new Error(`JSON 格式非法: ${err.message}`);
    }
  }
  const dir = path.dirname(e.path);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${e.path}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, e.path);
  return true;
}

function deleteConfig(name) {
  const e = entryOf(name);
  if (!fs.existsSync(e.path)) return false;
  fs.rmSync(e.path);
  return true;
}

// ---- 命名配置模板(存应用 userData/config-templates.json) ----

let storeDir = null;
function init(userData) {
  storeDir = userData || os.homedir();
}
function templatesFile() {
  return path.join(storeDir, "config-templates.json");
}
function loadTemplates() {
  try {
    const arr = JSON.parse(fs.readFileSync(templatesFile(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveTemplates(list) {
  fs.mkdirSync(storeDir, { recursive: true });
  const file = templatesFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// 列表(不含内容,供下拉与展示)
function listTemplates() {
  return loadTemplates().map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt }));
}

function getTemplate(id) {
  return loadTemplates().find((t) => t.id === id) || null;
}

// 新增或修改:{ id?, name, content };name 非空且唯一
function saveTemplate(input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("请给配置起个名字");
  if (!String(input.content || "").length) throw new Error("配置内容不能为空");
  const list = loadTemplates();
  const now = Date.now();
  if (input.id) {
    const t = list.find((x) => x.id === input.id);
    if (!t) throw new Error("配置不存在");
    if (list.some((x) => x.id !== input.id && x.name === name)) throw new Error(`已存在同名配置: ${name}`);
    t.name = name;
    t.content = input.content;
    t.updatedAt = now;
    saveTemplates(list);
    return { ...t };
  }
  if (list.some((x) => x.name === name)) throw new Error(`已存在同名配置: ${name}`);
  const t = { id: crypto.randomUUID(), name, content: input.content, createdAt: now, updatedAt: now };
  list.push(t);
  saveTemplates(list);
  return { ...t };
}

function deleteTemplate(id) {
  const list = loadTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  saveTemplates(next);
  return true;
}

// 使用:把模板内容一键写入 ~/.claude/settings.json(JSON 先校验)
function applyTemplate(id) {
  const t = getTemplate(id);
  if (!t) throw new Error("配置不存在");
  let json;
  try {
    json = JSON.parse(t.content);
  } catch (err) {
    throw new Error(`模板内容不是合法 JSON,无法应用到 settings.json: ${err.message}`);
  }
  const target = entryOf("settings.json");
  const dir = path.dirname(target.path);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target.path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), "utf8");
  fs.renameSync(tmp, target.path);
  return { ok: true, name: t.name, path: target.path };
}

module.exports = {
  init,
  listConfigFiles,
  readConfig,
  writeConfig,
  deleteConfig,
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  applyTemplate,
};
