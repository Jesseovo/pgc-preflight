// @ts-nocheck
// Migrated PGC Forge backend. Its data transforms are intentionally kept close to the original implementation.
import { SEED_GAMES, SEED_VOCAB } from "./forge/seed.js";
import { DEFAULT_SETTINGS, DEFAULT_REDLINES, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_F } from "./forge/defaults.js";
import { DIMS, drawCombos, exampleSets, learnedFactors, factorFor, norm } from "./forge/logic.js";
import { complete, providerStatus, activeModel, LLMError } from "./forge-llm";
import { identity } from './members';
import type { MemberStore } from './members';
import type { AppSecrets, ConfigStore } from './settings';
import {
  expandSystem, expandUser, EXPAND_SCHEMA, PREVIEW_SYSTEM, previewUser,
  briefSystem, briefUser, tagSystem, tagUser, TAG_SCHEMA, suggestSystem, suggestUser, SUGGEST_SCHEMA,
  reviewSystem, REVIEW_SCHEMA,
} from "./forge/prompts.js";

const TEXT_DEFAULTS = { redlines: DEFAULT_REDLINES, template: DEFAULT_TEMPLATE, template_f: DEFAULT_TEMPLATE_F };
const SETTING_KEYS = new Set([...Object.keys(DEFAULT_SETTINGS), ...Object.keys(TEXT_DEFAULTS)]);
const TOPIC_STATUSES = new Set(["new", "dup", "liked", "rejected", "made"]);
const GAME_FIELDS = ["title", "descr", "status", "score", "aes", "ease", "play", "revisions", "feedback", "source", ...DIMS];

export async function forgeApi(request: Request, env: ForgeEnv, route: string[], members: MemberStore) {
  try {
    const user = await identity(request.headers.get('Cookie'), members, env);
    if (!user) return json({ error: '请先登录。' }, 401);
    const reviewOnly = route[0] === 'review' || route[0] === 'reviews';
    if (user.role !== 'admin' && !reviewOnly) return json({ error: '成员账号只开放 AI 模拟审核。' }, 403);
    if (user.role !== 'admin' && !user.canReview) return json({ error: '当前账号未开通 AI 模拟审核权限，请联系管理员。' }, 403);
    const res = await dispatch(request.method, route, request, env, user.id);
    return res instanceof Response ? res : json(res);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof LLMError ? err.status : 500;
    return json({ error: err.message || String(err) }, status);
  }
}

export interface ForgeEnv {
  DB: any;
  ADMIN_PASSWORD: string;
  SETTINGS_KEY: string;
  modelStore: ConfigStore;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

const now = () => new Date().toISOString();
const all = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];
const first = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const run = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).run();

async function runBatch(env, statements) {
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

async function dispatch(method, route, request, env, ownerId) {
  const [a, b, c] = route;
  const id = b != null ? Number(b) : null;
  switch (`${method} ${a}${c ? "/:id/" + c : b != null ? "/:id" : ""}`) {
    case "GET state": return getState(env);
    case "POST seed": return seed(env);
    case "GET vocab": return listVocab(env);
    case "POST vocab": return addVocab(env, await body(request));
    case "POST suggest": return suggestVocab(env, await body(request));
    case "PATCH vocab/:id": return patchRow(env, "vocab", id, await body(request), ["word", "note", "base", "enabled"]);
    case "DELETE vocab/:id": return deleteRow(env, "vocab", id);
    case "GET games": return all(env, "SELECT * FROM games ORDER BY id DESC");
    case "POST games": return addGame(env, await body(request));
    case "PATCH games/:id": return patchRow(env, "games", id, await body(request), GAME_FIELDS);
    case "DELETE games/:id": return deleteRow(env, "games", id);
    case "POST import": return importWorks(env, await body(request));
    case "POST tag": return tagGames(env);
    case "POST draw": return draw(env, await body(request));
    case "POST expand": return expand(env, await body(request));
    case "GET topics": return listTopics(env, new URL(request.url).searchParams);
    case "GET topics/:id": return getTopic(env, id);
    case "PATCH topics/:id": return patchTopic(env, id, await body(request));
    case "POST topics/:id/preview": return preview(env, id);
    case "POST topics/:id/brief": return brief(env, id);
    case "POST review": return review(env, await body(request), ownerId);
    case "GET reviews": return listReviews(env, ownerId);
    case "GET reviews/:id": return getReview(env, id, ownerId);
    case "DELETE reviews/:id": return deleteReview(env, id, ownerId);
    case "GET settings": return getSettings(env);
    case "PUT settings": return putSettings(env, await body(request));
    case "GET export": return exportAll(env);
    default: throw new HttpError(404, `没有这个接口：${method} /api/${route.join("/")}`);
  }
}

// ---------- settings ----------

async function getSettings(env) {
  const rows = await all(env, "SELECT id AS key, value FROM settings WHERE id != 'model'");
  const s = { ...DEFAULT_SETTINGS, ...TEXT_DEFAULTS };
  for (const r of rows) if (SETTING_KEYS.has(r.key)) s[r.key] = r.value;
  // The platform keeps the active provider key encrypted in /admin. Mirror
  // that effective model into Forge's original settings shape so the Forge
  // UI and its status line describe the model that its calls actually use.
  const configured = await env.modelStore?.get?.();
  if (configured) {
    s.provider = 'openai';
    s.openai_model = configured.model || s.openai_model;
    s.openai_vision = '1';
  }
  return s;
}

async function putSettings(env, data) {
  const stmts = [];
  for (const [k, v] of Object.entries(data || {})) {
    if (!SETTING_KEYS.has(k)) throw new HttpError(400, `未知设置项：${k}`);
    stmts.push(env.DB.prepare("INSERT INTO settings (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, String(v), now()));
  }
  if (stmts.length) await runBatch(env, stmts);
  return getSettings(env);
}

// ---------- state / seed / export ----------

async function getState(env) {
  const [games, vocab, topics, fresh] = await Promise.all([
    first(env, "SELECT COUNT(*) AS n FROM games"),
    first(env, "SELECT COUNT(*) AS n FROM vocab"),
    all(env, "SELECT status, COUNT(*) AS n FROM topics GROUP BY status"),
    first(env, `SELECT COUNT(*) AS n FROM vocab v WHERE v.dim = 'subject' AND v.enabled = 1
      AND lower(trim(v.word)) NOT IN (SELECT lower(trim(subject)) FROM games UNION SELECT lower(trim(subject)) FROM topics)`),
  ]);
  const s = await getSettings(env);
  const model = await env.modelStore.get();
  return {
    games: games.n,
    vocab: vocab.n,
    fresh_subjects: fresh.n,
    topics: Object.fromEntries(topics.map((r) => [r.status, r.n])),
    providers: { anthropic: false, anthropic_compat: false, openai: Boolean(model?.enabled && model?.encryptedKey) },
    provider: 'openai',
    model: model?.model || "（未配置）",
  };
}

async function seed(env) {
  const g = await first(env, "SELECT COUNT(*) AS n FROM games");
  const v = await first(env, "SELECT COUNT(*) AS n FROM vocab");
  if (g.n || v.n) throw new HttpError(409, "数据库里已经有数据，不会重复初始化");
  const stmts = [];
  for (const [dim, words] of Object.entries(SEED_VOCAB)) {
    for (const [word, note = "", base = 1] of words) {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO vocab (dim, word, note, base) VALUES (?, ?, ?, ?)").bind(dim, word, note, base));
    }
  }
  for (const row of SEED_GAMES) {
    const [title, descr, status, aes, ease, play, revisions, feedback, subject, medium, gesture, structure, mood, source] = row;
    const score = aes != null ? aes + ease + play : null;
    stmts.push(env.DB.prepare(
      `INSERT INTO games (title, descr, status, score, aes, ease, play, revisions, feedback, subject, medium, gesture, structure, mood, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(title, descr, status, score, aes, ease, play, revisions, feedback, subject, medium, gesture, structure, mood, source, now()));
  }
  await runBatch(env, stmts);
  return getState(env);
}

async function exportAll(env) {
  const [vocab, games, topics, settings, reviews] = await Promise.all([
    all(env, "SELECT * FROM vocab"), all(env, "SELECT * FROM games"),
    all(env, "SELECT * FROM topics"), all(env, "SELECT id AS key, value, updated_at FROM settings WHERE id != 'model'"),
    all(env, "SELECT id, title, topic_id, score, result, probe, created_at FROM reviews"),
  ]);
  return { exported_at: now(), vocab, games, topics, settings, reviews };
}

// ---------- generic rows ----------

async function patchRow(env, table, id, data, allowed) {
  const keys = Object.keys(data || {}).filter((k) => allowed.includes(k));
  if (!keys.length) throw new HttpError(400, "没有可更新的字段");
  const extra = table === "games" ? ", updated_at = ?" : "";
  const vals = keys.map((k) => data[k]);
  if (table === "games") vals.push(now());
  await run(env, `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")}${extra} WHERE id = ?`, ...vals, id);
  return first(env, `SELECT * FROM ${table} WHERE id = ?`, id);
}

async function deleteRow(env, table, id) {
  await run(env, `DELETE FROM ${table} WHERE id = ?`, id);
  return { ok: true };
}

async function deleteReview(env, id, ownerId) {
  if (ownerId === 'admin') {
    await run(env, "DELETE FROM reviews WHERE id = ?", id);
  } else {
    await run(env, "DELETE FROM reviews WHERE id = ? AND owner_id = ?", id, ownerId);
  }
  return { ok: true };
}

// ---------- vocab ----------

async function listVocab(env) {
  const [vocab, games, topics] = await Promise.all([
    all(env, "SELECT * FROM vocab ORDER BY dim, id"),
    all(env, "SELECT * FROM games"),
    all(env, "SELECT subject, medium, gesture, structure, mood, status FROM topics"),
  ]);
  const factors = learnedFactors(games, topics);
  const usedSubjects = new Set(games.concat(topics).map((x) => norm(x.subject)));
  return vocab.map((v) => {
    const f = factorFor(factors, v.dim, v.word);
    return { ...v, factor: f.factor, avg: f.avg, n: f.n, likes: f.likes, rejects: f.rejects, used: v.dim === "subject" && usedSubjects.has(norm(v.word)) };
  });
}

async function addVocab(env, { dim, word, note = "", base = 1 }) {
  if (!DIMS.includes(dim)) throw new HttpError(400, "维度不对");
  const w = String(word || "").trim();
  if (!w) throw new HttpError(400, "词不能为空");
  await run(env, "INSERT OR IGNORE INTO vocab (dim, word, note, base) VALUES (?, ?, ?, ?)", dim, w, note, Number(base) || 1);
  return first(env, "SELECT * FROM vocab WHERE dim = ? AND word = ?", dim, w);
}

async function suggestVocab(env, { dim, n = 30 }) {
  if (dim !== "subject" && dim !== "medium") throw new HttpError(400, "只支持补充题材和美术媒介");
  const count = Math.min(Math.max(Number(n) || 30, 5), 60);
  const [cfg, vocab, games] = await Promise.all([
    getSettings(env),
    all(env, "SELECT word FROM vocab WHERE dim = ? ORDER BY id", dim),
    all(env, "SELECT * FROM games ORDER BY id"),
  ]);
  const existing = vocab.map((v) => v.word).concat(dim === "subject" ? games.map((g) => g.subject).filter(Boolean) : []);
  const { positives } = exampleSets(games);
  const out = await complete(env, cfg, {
    system: suggestSystem({ redlines: cfg.redlines, positives }),
    user: suggestUser(dim, count, [...new Set(existing)]),
    schema: SUGGEST_SCHEMA,
    maxTokens: 8000,
  });
  const seen = new Set(existing.map(norm));
  const fresh = (out.words || []).filter((w) => w.word && !seen.has(norm(w.word)) && seen.add(norm(w.word)));
  await runBatch(env, fresh.map((w) =>
    env.DB.prepare("INSERT OR IGNORE INTO vocab (dim, word, note, base) VALUES (?, ?, ?, 1)").bind(dim, w.word.trim(), "AI 补充：" + (w.note || ""))));
  return { added: fresh.length, words: fresh.map((w) => w.word) };
}

// ---------- games ----------

async function addGame(env, data) {
  const title = String(data.title || "").trim();
  if (!title) throw new HttpError(400, "标题不能为空");
  const g = { descr: "", status: "local", revisions: 1, feedback: "", ...Object.fromEntries(DIMS.map((d) => [d, ""])), ...data, title };
  const scores = ["aes", "ease", "play"].map((k) => (g[k] === "" || g[k] == null ? null : Number(g[k])));
  const score = scores.every((x) => x != null) ? scores[0] + scores[1] + scores[2] : null;
  const r = await run(env,
    `INSERT INTO games (title, descr, status, score, aes, ease, play, revisions, feedback, subject, medium, gesture, structure, mood, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    g.title, g.descr, g.status, score, scores[0], scores[1], scores[2], Number(g.revisions) || 1, g.feedback,
    g.subject, g.medium, g.gesture, g.structure, g.mood, g.source === "peer" ? "peer" : "mine", now());
  return first(env, "SELECT * FROM games WHERE id = ?", r.meta.last_row_id);
}

// Accepts the JSON produced by the PGC export snippet (see the 导入 page).
async function importWorks(env, { works }) {
  if (!Array.isArray(works)) throw new HttpError(400, "缺少 works 数组");
  const existing = await all(env, "SELECT id, ext_id, title FROM games");
  const byExt = new Map(existing.filter((g) => g.ext_id).map((g) => [g.ext_id, g]));
  const byTitle = new Map(existing.filter((g) => !g.ext_id).map((g) => [norm(g.title), g]));
  let inserted = 0, updated = 0;
  const stmts = [];
  for (const w of works) {
    if (!w || !w.id || !w.title) continue;
    const versions = [...(w.versions || [])].sort((x, y) => x.r - y.r);
    const scored = [...versions].reverse().find((v) => v.s || v.ps);
    const parts = scored ? String(scored.s || scored.ps).split("/").map(Number) : [null, null, null];
    const score = parts.every((x) => Number.isFinite(x)) ? parts[0] + parts[1] + parts[2] : null;
    const feedback = versions.map((v) => v.fb || v.pfb).filter(Boolean).map((t) => t.replace(/\s+/g, " ").trim()).join(" / ").slice(0, 1200);
    const status = mapStatus(w.status, w.deleted);
    const revisions = versions.length ? Math.max(...versions.map((v) => v.r)) : 1;
    const descr = String(w.desc || "").replace(/\s+/g, " ").slice(0, 300);
    const source = w.source === "peer" ? "peer" : "mine";
    const hit = byExt.get(w.id) || byTitle.get(norm(w.title));
    if (hit) {
      stmts.push(env.DB.prepare(
        `UPDATE games SET ext_id = ?, title = ?, descr = ?, status = ?, score = ?, aes = ?, ease = ?, play = ?, revisions = ?, feedback = ?, source = ?, updated_at = ? WHERE id = ?`,
      ).bind(w.id, w.title, descr, status, score, parts[0], parts[1], parts[2], revisions, feedback, source, now(), hit.id));
      updated++;
    } else {
      stmts.push(env.DB.prepare(
        `INSERT INTO games (ext_id, title, descr, status, score, aes, ease, play, revisions, feedback, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(w.id, w.title, descr, status, score, parts[0], parts[1], parts[2], revisions, feedback, source, now()));
      inserted++;
    }
  }
  await runBatch(env, stmts);
  const untagged = await first(env, "SELECT COUNT(*) AS n FROM games WHERE gesture = '' OR medium = ''");
  return { inserted, updated, untagged: untagged.n };
}

function mapStatus(s, deleted) {
  if (s === "approved" || s === "preapproved" || s === "rejected" || s === "pending") return s;
  if (s === "draft" && deleted) return "dropped";
  return s === "draft" ? "local" : "pending";
}

async function tagGames(env) {
  const games = await all(env, "SELECT * FROM games WHERE gesture = '' OR medium = '' ORDER BY id LIMIT 15");
  if (!games.length) return { tagged: 0, remaining: 0 };
  const vocab = await all(env, "SELECT dim, word FROM vocab WHERE enabled = 1 ORDER BY dim, id");
  const byDim = Object.fromEntries(DIMS.map((d) => [d, vocab.filter((v) => v.dim === d).map((v) => v.word)]));
  const cfg = await getSettings(env);
  const out = await complete(env, cfg, { system: tagSystem(byDim), user: tagUser(games), schema: TAG_SCHEMA, maxTokens: 4000 });
  const ids = new Set(games.map((g) => g.id));
  const stmts = (out.items || []).filter((t) => ids.has(t.id)).map((t) =>
    env.DB.prepare("UPDATE games SET subject = ?, medium = ?, gesture = ?, structure = ?, mood = ?, updated_at = ? WHERE id = ?")
      .bind(t.subject, t.medium, t.gesture, t.structure, t.mood, now(), t.id));
  await runBatch(env, stmts);
  const rest = await first(env, "SELECT COUNT(*) AS n FROM games WHERE gesture = '' OR medium = ''");
  return { tagged: stmts.length, remaining: rest.n };
}

// ---------- topics ----------

function hydrate(t) {
  return t ? { ...t, data: JSON.parse(t.data || "{}") } : t;
}

async function listTopics(env, params) {
  const statuses = (params.get("status") || "new,liked").split(",").filter(Boolean);
  const limit = Math.min(Number(params.get("limit")) || 100, 500);
  const marks = statuses.map(() => "?").join(",");
  const rows = await all(env, `SELECT id, batch, subject, medium, gesture, structure, mood, status, data, score, note, created_at, updated_at,
      preview_svg IS NOT NULL AS has_preview, brief_md IS NOT NULL AS has_brief
    FROM topics WHERE status IN (${marks}) ORDER BY score DESC, id DESC LIMIT ?`, ...statuses, limit);
  return rows.map(hydrate);
}

async function getTopic(env, id) {
  const t = hydrate(await first(env, "SELECT * FROM topics WHERE id = ?", id));
  if (!t) throw new HttpError(404, "选题不存在");
  return t;
}

async function patchTopic(env, id, data) {
  const t = await getTopic(env, id);
  const status = data.status ?? t.status;
  if (data.status != null && !TOPIC_STATUSES.has(data.status)) throw new HttpError(400, "状态不对");
  await run(env, "UPDATE topics SET status = ?, note = ?, updated_at = ? WHERE id = ?", status, data.note ?? t.note, now(), id);
  return getTopic(env, id);
}

async function draw(env, { n, locks = {} } = {}) {
  const cfg = await getSettings(env);
  const size = Math.min(Math.max(Number(n) || Number(cfg.draw_size) || 12, 1), 40);
  const [vocab, games, topics] = await Promise.all([
    all(env, "SELECT * FROM vocab"),
    all(env, "SELECT * FROM games"),
    all(env, "SELECT subject, medium, gesture, structure, mood, status FROM topics"),
  ]);
  const cleanLocks = Object.fromEntries(Object.entries(locks).filter(([d, w]) => DIMS.includes(d) && w));
  const combos = drawCombos({ vocab, games, topics, n: size, locks: cleanLocks });
  if (!combos.length) throw new HttpError(409, "抽不出新组合了：词库可能用完了，去词库加一些新词");
  const batch = now();
  const stmts = combos.map((c) => env.DB.prepare(
    "INSERT INTO topics (batch, subject, medium, gesture, structure, mood, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'drawn', ?, ?)",
  ).bind(batch, c.subject, c.medium, c.gesture, c.structure, c.mood, batch, batch));
  await runBatch(env, stmts);
  return (await all(env, "SELECT * FROM topics WHERE batch = ? ORDER BY id", batch)).map(hydrate);
}

async function expand(env, { ids }) {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "缺少 ids");
  const marks = ids.map(() => "?").join(",");
  const topics = (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
  if (!topics.length) throw new HttpError(404, "选题不存在");
  const [cfg, games, prior] = await Promise.all([
    getSettings(env),
    all(env, "SELECT * FROM games ORDER BY id"),
    all(env, "SELECT data, subject FROM topics WHERE status IN ('new', 'liked', 'made') ORDER BY id"),
  ]);
  const { positives, negatives } = exampleSets(games);
  const existing = games.map((g) => `- ${g.title}｜${g.descr}｜${g.gesture}`)
    .concat(prior.map((p) => JSON.parse(p.data || "{}")).filter((d) => d.title).map((d) => `- ${d.title}｜${d.logline}（已抽过的选题）`))
    .slice(-260);
  const out = await complete(env, cfg, {
    system: expandSystem({ redlines: cfg.redlines, positives, negatives }),
    user: expandUser({ existing, combos: topics }),
    schema: EXPAND_SCHEMA,
    maxTokens: 4000 + 2200 * topics.length,
  });
  const stmts = [];
  for (const item of out.items || []) {
    const t = topics[item.idx];
    if (!t) continue;
    const score = [item.aes, item.ease, item.play].map((x) => Math.max(1, Math.min(3, Number(x) || 1))).reduce((s, x) => s + x, 0);
    const status = item.dup_of && item.dup_of.trim() ? "dup" : "new";
    stmts.push(env.DB.prepare("UPDATE topics SET data = ?, score = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(item), score, status, now(), t.id));
  }
  await runBatch(env, stmts);
  return (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
}

async function preview(env, id) {
  const t = await getTopic(env, id);
  if (!t.data.title) throw new HttpError(409, "这个选题还没扩写");
  const cfg = await getSettings(env);
  const text = await complete(env, cfg, { system: PREVIEW_SYSTEM, user: previewUser(t), maxTokens: 12000 });
  const svg = sanitizeSvg(text);
  await run(env, "UPDATE topics SET preview_svg = ?, updated_at = ? WHERE id = ?", svg, now(), id);
  return { id, svg };
}

export function sanitizeSvg(text) {
  const m = String(text).match(/<svg[\s\S]*<\/svg>/i);
  if (!m) throw new LLMError("模型没有返回 SVG", 502);
  return m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<image\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href\s*=\s*)("|')\s*(javascript:|https?:)[^"']*\2/gi, '$1$2#$2')
    .replace(/@import[^;]*;/gi, "");
}

// ---------- mock review ----------

const MAX_SOURCE = 240000;

// Long minified/base64 lines carry no reviewable logic and cost many tokens.
function trimSource(html) {
  const lines = String(html || "").split("\n").map((l) => (l.length > 3000 ? `/* [省略一行 ${l.length} 字符] */` : l));
  let out = lines.join("\n");
  if (out.length > MAX_SOURCE) out = out.slice(0, MAX_SOURCE) + `\n/* [源码过长，后面 ${out.length - MAX_SOURCE} 字符已省略] */`;
  return out;
}

async function review(env, { title, topic_id, html, probe, shots }, ownerId) {
  if (!html || typeof html !== "string") throw new HttpError(400, "缺少游戏源码");
  const images = (Array.isArray(shots) ? shots : []).filter((s) => s && /^data:image\/(jpeg|png|webp);base64,/.test(s.data)).slice(0, 6);
  const [cfg, games] = await Promise.all([getSettings(env), all(env, "SELECT * FROM games ORDER BY id")]);
  const { positives, negatives } = exampleSets(games);
  let design = "";
  if (topic_id) {
    const t = hydrate(await first(env, "SELECT * FROM topics WHERE id = ?", topic_id));
    if (t && t.data.title) design = `【原定设计】${t.data.title}：${t.data.logline}\n新机制：${t.data.twist}\n节奏：${t.data.progression}\n美术：${t.data.art_direction}\n`;
  }
  const parts = [];
  for (const s of images) parts.push({ type: "text", text: `截图：${s.label}` }, { type: "image", data: s.data });
  parts.push({ type: "text", text: `游戏名：${title || "未命名"}\n${design}\n【自动体检报告】\n${JSON.stringify(probe || {}, null, 1)}\n\n【源码】\n${trimSource(html)}` });
  const result = await complete(env, cfg, {
    system: reviewSystem({ redlines: cfg.redlines, positives, negatives }),
    user: parts,
    schema: REVIEW_SCHEMA,
    maxTokens: 16000,
  });
  for (const k of ["aes", "ease", "play"]) result[k] = Math.max(1, Math.min(3, Number(result[k]) || 1));
  const score = result.aes + result.ease + result.play;
  const r = await run(env, "INSERT INTO reviews (owner_id, title, topic_id, score, result, probe, shots, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ownerId || 'admin', String(title || "未命名").slice(0, 120), topic_id || null, score, JSON.stringify(result), JSON.stringify(probe || {}), JSON.stringify(images), now());
  return getReview(env, r.meta.last_row_id, ownerId);
}

async function listReviews(env, ownerId) {
  const isAdmin = ownerId === 'admin';
  const rows = isAdmin
    ? await all(env, "SELECT id, title, topic_id, score, json_extract(result, '$.verdict') AS verdict, created_at FROM reviews ORDER BY id DESC LIMIT 100")
    : await all(env, "SELECT id, title, topic_id, score, json_extract(result, '$.verdict') AS verdict, created_at FROM reviews WHERE owner_id = ? ORDER BY id DESC LIMIT 100", ownerId);
  return rows;
}

async function getReview(env, id, ownerId = 'admin') {
  const r = ownerId === 'admin'
    ? await first(env, "SELECT * FROM reviews WHERE id = ?", id)
    : await first(env, "SELECT * FROM reviews WHERE id = ? AND owner_id = ?", id, ownerId);
  if (!r) throw new HttpError(404, "审核记录不存在");
  return { ...r, result: JSON.parse(r.result), probe: JSON.parse(r.probe), shots: JSON.parse(r.shots) };
}

async function brief(env, id) {
  const t = await getTopic(env, id);
  if (!t.data.title) throw new HttpError(409, "这个选题还没扩写");
  const cfg = await getSettings(env);
  const md = await complete(env, cfg, {
    system: briefSystem({ templateF: cfg.template_f, redlines: cfg.redlines }),
    user: briefUser(t),
    maxTokens: 16000,
  });
  const full = cfg.template + String(md).trim() + "\n";
  await run(env, "UPDATE topics SET brief_md = ?, status = CASE WHEN status = 'made' THEN status ELSE 'liked' END, updated_at = ? WHERE id = ?", full, now(), id);
  return { id, brief: full };
}
