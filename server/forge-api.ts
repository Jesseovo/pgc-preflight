// @ts-nocheck
// Migrated PGC Forge backend. Its data transforms are intentionally kept close to the original implementation.
import { SEED_GAMES, SEED_VOCAB } from "./forge/seed.js";
import { DEFAULT_SETTINGS, DEFAULT_REDLINES, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_F } from "./forge/defaults.js";
import { DIMS, drawCombos, exampleSets, learnedFactors, factorFor, norm } from "./forge/logic.js";
import { complete, providerStatus, activeModel, routedModel, LLMError } from "./forge-llm";
import { activeModelProfile } from './settings';
import { identity } from './members';
import { enqueueReview, getReviewJob, listReviewJobs, processReviewJob, updateReviewProgress } from './review-jobs';
import { generateReview } from './review-generation';
import type { MemberStore } from './members';
import type { AppSecrets, ConfigStore } from './settings';
import {
  expandSystem, expandUser, EXPAND_SCHEMA, PREVIEW_SYSTEM, previewUser,
  briefSystem, briefUser, ASSETS_SYSTEM, assetsUser, tagSystem, tagUser, TAG_SCHEMA, suggestSystem, suggestUser, SUGGEST_SCHEMA,
  reviewSystem, GAME_SYSTEM, gameUser,
} from "./forge/prompts.js";
import { cleanGameHtml } from './game-generation';

const TEXT_DEFAULTS = { redlines: DEFAULT_REDLINES, template: DEFAULT_TEMPLATE, template_f: DEFAULT_TEMPLATE_F };
// Model credentials and model selection belong to /admin. Forge only stores
// its own workflow settings; keeping the old provider fields out of this
// surface prevents a second, misleading configuration source.
const FORGE_DEFAULTS = { draw_size: DEFAULT_SETTINGS.draw_size, expand_batch: DEFAULT_SETTINGS.expand_batch };
const SETTING_KEYS = new Set([...Object.keys(FORGE_DEFAULTS), ...Object.keys(TEXT_DEFAULTS)]);
const TOPIC_STATUSES = new Set(["new", "dup", "liked", "rejected", "made"]);
const GAME_FIELDS = ["title", "descr", "status", "score", "aes", "ease", "play", "revisions", "feedback", "source", ...DIMS];

export async function forgeApi(request: Request, env: ForgeEnv, route: string[], members: MemberStore, ctx?: { waitUntil(promise: Promise<unknown>): void }) {
  try {
    const user = await identity(request.headers.get('Cookie'), members, env);
    if (!user) return json({ error: '请先登录。' }, 401);
    const reviewOnly = route[0] === 'review' || route[0] === 'reviews';
    if (user.role !== 'admin' && !reviewOnly) return json({ error: '成员账号只开放 AI 模拟审核。' }, 403);
    if (user.role !== 'admin' && !user.canReview) return json({ error: '当前账号未开通 AI 模拟审核权限，请联系管理员。' }, 403);
    const res = await dispatch(request.method, route, request, env, user.id, ctx);
    return res instanceof Response ? res : json(res);
  } catch (err) {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    return json({ error: err.message || String(err) }, status);
  }
}

export interface ForgeEnv {
  DB: any;
  ADMIN_PASSWORD: string;
  SETTINGS_KEY: string;
  modelStore: ConfigStore;
  FORGE_QUEUE?: { send(message: ForgeJob): Promise<void> };
  REVIEW_QUEUE?: { send(message: { type: 'review'; id: string }): Promise<void> };
  captureReview?: (html: string) => Promise<unknown>;
}

export type ForgeJob = { type: 'expand'; ids: number[] } | { type: 'brief'; id: number } | { type: 'assets'; id: number } | { type: 'game'; id: number; requestId: string } | { type: 'review'; id: string };

// Per-topic background jobs share one claim/lease/recovery path.
type TopicJobKind = 'brief' | 'assets';
const TOPIC_JOBS = {
  brief: { status: 'brief_status', error: 'brief_error', output: 'brief_md' },
  assets: { status: 'assets_status', error: 'assets_error', output: 'assets_html' },
} as const;

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

// Generated files are always downloaded, never rendered in the app origin.
function attachment(content, type, topic, suffix) {
  const filename = `${String(topic.data.title || 'pgc').replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${suffix}`;
  return new Response(content, { headers: {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="pgc-${suffix}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  } });
}

async function dispatch(method, route, request, env, ownerId, ctx) {
  const [a, b, c] = route;
  if (a === 'review' && b === 'probe' && !c && method === 'POST') {
    const input = await readReviewBody(request);
    if (!env.captureReview) throw new HttpError(503, '浏览器采集服务尚未启用。');
    return env.captureReview(input.html);
  }
  if (a === 'review' && b === 'jobs') {
    if (method === 'GET' && !c) return listReviewJobs(env, ownerId);
    if (method === 'GET' && c) return getReviewJob(env, c, ownerId);
    if (method === 'POST' && !c) {
      const input = await readReviewBody(request);
      const job = await enqueueReview(env, { ...input, html: trimSource(input.html) }, ownerId);
      return json(job, 202);
    }
    throw new HttpError(405, '审核任务不支持这个操作。');
  }
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
    case "POST expand": return expand(env, await body(request), ctx);
    case "GET topics": return listTopics(env, new URL(request.url).searchParams);
    case "GET products": return listProducts(env);
    case "GET topics/:id": {
      const topic = await getTopic(env, id);
      return { ...topic, brief_export: composeBrief(topic) };
    }
    case "GET topics/:id/brief": {
      const topic = await getTopic(env, id);
      if (!topic.brief_md?.trim()) throw new HttpError(409, "简报尚未生成，请稍后再下载。");
      return attachment(composeBrief(topic), 'text/markdown; charset=utf-8', topic, 'brief.md');
    }
    case "GET topics/:id/assets": {
      const topic = await getTopic(env, id);
      if (!topic.assets_html?.trim()) throw new HttpError(409, "资产尚未生成，请稍后再下载。");
      return attachment(topic.assets_html, 'text/html; charset=utf-8', topic, 'assets.html');
    }
    case "GET topics/:id/product": {
      const topic = await getTopic(env, id);
      if (!topic.product_html?.trim()) throw new HttpError(409, "成品尚未生成。");
      return json({ id, html: topic.product_html });
    }
    case "GET topics/:id/game": {
      let topic = await getTopic(env, id);
      const interrupted = topic.product_status === 'running' && Date.now() - Date.parse(topic.updated_at) > 15 * 60 * 1000;
      const expired = topic.product_status === 'queued' && Date.now() - Date.parse(topic.updated_at) > 24 * 60 * 60 * 1000;
      if (interrupted || expired) {
        await run(env, "UPDATE topics SET product_status = 'error', product_error = '制作任务已中断或过期，请重新制作。', updated_at = ? WHERE id = ? AND updated_at = ?", now(), id, topic.updated_at);
        topic = await getTopic(env, id);
      }
      return { id, product_status: topic.product_status || '', product_error: topic.product_error || '', has_product: Boolean(topic.product_html?.trim()), updated_at: topic.updated_at };
    }
    case "GET topics/:id/product-preview": {
      const topic = await getTopic(env, id);
      if (!topic.product_html?.trim()) throw new HttpError(409, "成品尚未生成。");
      return new Response(topic.product_html, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'",
        'Referrer-Policy': 'no-referrer',
      } });
    }
    case "GET topics/:id/product-file": {
      const topic = await getTopic(env, id);
      if (!topic.product_html?.trim()) throw new HttpError(409, "成品尚未生成。");
      return attachment(topic.product_html, 'text/html; charset=utf-8', topic, 'game.html');
    }
    case "PATCH topics/:id": return patchTopic(env, id, await body(request));
    case "POST topics/:id/preview": return preview(env, id);
    case "POST topics/:id/brief": return brief(env, id, ctx, new URL(request.url).searchParams.get('regenerate') === '1');
    case "POST topics/:id/assets": return startTopicJob(env, 'assets', id, ctx, new URL(request.url).searchParams.get('regenerate') === '1', assetsJob);
    case "POST topics/:id/game": return startGameJob(env, id);
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
  const s = { ...FORGE_DEFAULTS, ...TEXT_DEFAULTS };
  for (const r of rows) if (SETTING_KEYS.has(r.key)) s[r.key] = r.value;
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
    purpose: 'vocab',
    user: suggestUser(dim, count, [...new Set(existing)]),
    schema: SUGGEST_SCHEMA,
    maxTokens: 12000,
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

// Accepts the JSON produced by the PGC export snippet (see the 导入 page), and
// the head reviewer's spreadsheet converted in the browser (match: "title":
// no platform IDs, no descriptions).
async function importWorks(env, { works }) {
  if (!Array.isArray(works)) throw new HttpError(400, "缺少 works 数组");
  const existing = await all(env, "SELECT id, ext_id, title, source FROM games");
  const byExt = new Map(existing.filter((g) => g.ext_id).map((g) => [g.ext_id, g]));
  const byTitle = new Map(existing.filter((g) => !g.ext_id).map((g) => [norm(g.title), g]));
  const byTitleSource = new Map(existing.map((g) => [norm(g.title) + "|" + g.source, g]));
  let inserted = 0, updated = 0;
  const stmts = [];
  for (const w of works) {
    if (!w || !w.id || !w.title) continue;
    const versions = [...(w.versions || [])].sort((x, y) => x.r - y.r);
    const scored = [...versions].reverse().find((v) => v.s || v.ps);
    const parts = scored ? String(scored.s || scored.ps).split("/").map(Number) : [null, null, null];
    const score = parts.every((x) => Number.isFinite(x)) ? parts[0] + parts[1] + parts[2] : null;
    const feedback = versions.flatMap((v) => [v.pfb, v.fb]).filter(Boolean).map((t) => t.replace(/\s+/g, " ").trim()).join(" / ").slice(0, 1200);
    const status = mapStatus(w.status, w.deleted);
    const revisions = versions.length ? Math.max(...versions.map((v) => v.r)) : 1;
    const descr = String(w.desc || "").replace(/\s+/g, " ").slice(0, 300);
    const source = w.source === "peer" ? "peer" : "mine";
    const hit = byExt.get(w.id)
      || (w.match === "title" ? byTitleSource.get(norm(w.title) + "|" + source) : null)
      || byTitle.get(norm(w.title));
    if (hit) {
      // Keep a real platform ID over a spreadsheet one, and an existing description over an empty one.
      const extId = w.match === "title" && hit.ext_id ? hit.ext_id : w.id;
      stmts.push(env.DB.prepare(
        `UPDATE games SET ext_id = ?, title = ?, descr = COALESCE(NULLIF(?, ''), descr), status = ?, score = ?, aes = ?, ease = ?, play = ?, revisions = ?, feedback = ?, source = ?, updated_at = ? WHERE id = ?`,
      ).bind(extId, w.title, descr, status, score, parts[0], parts[1], parts[2], revisions, feedback, source, now(), hit.id));
      updated++;
    } else {
      stmts.push(env.DB.prepare(
        `INSERT INTO games (ext_id, title, descr, status, score, aes, ease, play, revisions, feedback, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(w.id, w.title, descr, status, score, parts[0], parts[1], parts[2], revisions, feedback, source, now()));
      inserted++;
    }
    // Two rows in one file for the same game must not both insert.
    const row = hit || { id: null, ext_id: w.id, title: w.title, source };
    byExt.set(w.id, row);
    byTitleSource.set(norm(w.title) + "|" + source, row);
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
  const out = await complete(env, cfg, { system: tagSystem(byDim), user: tagUser(games), schema: TAG_SCHEMA, maxTokens: 8000, purpose: 'tags' });
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
      preview_svg IS NOT NULL AS has_preview, brief_md IS NOT NULL AS has_brief, brief_status, brief_error,
      assets_html IS NOT NULL AS has_assets, assets_status, assets_error,
      product_html IS NOT NULL AS has_product, product_status, product_error
    FROM topics WHERE status IN (${marks}) ORDER BY score DESC, id DESC LIMIT ?`, ...statuses, limit);
  return rows.map(hydrate);
}

async function listProducts(env) {
  const rows = await all(env, `SELECT id, subject, medium, gesture, structure, mood, status, data, score, note, updated_at,
      product_html IS NOT NULL AS has_product, product_status, product_error
    FROM topics WHERE product_html IS NOT NULL OR product_status IN ('queued', 'running', 'error')
    ORDER BY updated_at DESC, id DESC LIMIT 300`);
  return rows.map(hydrate);
}

async function getTopic(env, id) {
  const t = hydrate(await first(env, "SELECT * FROM topics WHERE id = ?", id));
  if (!t) throw new HttpError(404, "选题不存在");
  return t;
}

// Cloudflare may end a long waitUntil task while the upstream model is still
// working. Keep a short lease on async jobs so a later browser poll can take
// over a task that was left in `running` forever.
const JOB_LEASE_MS = 75_000;
function staleJobBefore() {
  return new Date(Date.now() - JOB_LEASE_MS).toISOString();
}
async function withTopicLease<T>(env, ids: number[], statusColumn: 'expand_status' | 'brief_status' | 'assets_status' | 'product_status', work: () => Promise<T>): Promise<T> {
  const marks = ids.map(() => "?").join(",");
  const touch = () => run(env, `UPDATE topics SET updated_at = ? WHERE id IN (${marks}) AND ${statusColumn} = 'running'`, now(), ...ids).catch(() => {});
  const timer = setInterval(() => { void touch(); }, 20_000);
  try { return await work(); }
  finally { clearInterval(timer); }
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

async function expand(env, { ids }, ctx) {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "缺少 ids");
  const marks = ids.map(() => "?").join(",");
  const topics = (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
  if (!topics.length) throw new HttpError(404, "选题不存在");
  // A browser/proxy may lose the response after the model has already
  // completed and persisted the topic. Make retries idempotent: return the
  // saved result instead of generating it a second time.
  const pending = topics.filter((topic) => !topic.data?.title);
  if (!pending.length) return topics;
  if (env.FORGE_QUEUE || ctx?.waitUntil) {
    const claimed = [];
    const staleBefore = staleJobBefore();
    for (const topic of pending) {
      const result = await run(env, "UPDATE topics SET expand_status = 'running', expand_error = '', updated_at = ? WHERE id = ? AND json_extract(data, '$.title') IS NULL AND (expand_status = '' OR expand_status = 'error' OR (expand_status = 'running' AND updated_at < ?))", now(), topic.id, staleBefore);
      if (result.meta?.changes) claimed.push(topic.id);
    }
    if (claimed.length) {
      if (env.FORGE_QUEUE) await env.FORGE_QUEUE.send({ type: 'expand', ids: claimed });
      else ctx.waitUntil(expandBatch(env, claimed).catch(async error => {
        await run(env, `UPDATE topics SET expand_status = 'error', expand_error = ?, updated_at = ? WHERE id IN (${claimed.map(() => "?").join(",")})`, String(error?.message || error).slice(0, 500), now(), ...claimed).catch(() => {});
      }));
    }
    const current = (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
    return { pending: true, topics: current };
  }
  return expandBatch(env, ids);
}

async function expandBatch(env, ids) {
  const marks = ids.map(() => "?").join(",");
  const topics = (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
  const pending = topics.filter((topic) => !topic.data?.title);
  if (!pending.length) return topics;
  const slowModel = /opus|claude/i.test(routedModel(await env.modelStore.get(), 'expand'));
  const [cfg, games, prior] = await Promise.all([
    getSettings(env),
    all(env, "SELECT * FROM games ORDER BY id"),
    all(env, "SELECT data, subject FROM topics WHERE status IN ('new', 'liked', 'made') ORDER BY id"),
  ]);
  const { positives, negatives } = exampleSets(games);
  const existing = games.map((g) => `- ${g.title}｜${g.descr}｜${g.gesture}`)
    .concat(prior.map((p) => JSON.parse(p.data || "{}")).filter((d) => d.title).map((d) => `- ${d.title}｜${d.logline}（已抽过的选题）`))
    .slice(-260);
  let out;
  try {
    out = await withTopicLease(env, pending.map((topic) => topic.id), 'expand_status', () => complete(env, cfg, {
        system: expandSystem({ redlines: cfg.redlines, positives, negatives }),
        purpose: 'expand',
        user: expandUser({ existing, combos: pending }),
        schema: EXPAND_SCHEMA,
        // Allow room for thinking as well as the completed topic JSON.
        maxTokens: 16000,
        // Opus can spend more than 90 seconds reasoning before its first
        // useful chunk. Queue jobs are allowed to run longer than an HTTP
        // request, so keep the relay open long enough for the model stream to
        // make progress instead of recording a false timeout.
        timeoutMs: slowModel ? 300000 : 150000,
      idempotencyKey: `pgc-expand-${pending.map((topic) => topic.id).join('-')}-${Date.now()}`,
      onWait: message => run(env, `UPDATE topics SET expand_error = ? WHERE id IN (${pending.map(() => '?').join(',')}) AND expand_status = 'running'`, message, ...pending.map(topic => topic.id)),
      }));
  } catch (error) {
    // Riffle returns 409 when another tab is already processing the same
    // idempotent request. Wait for that request to persist its result instead
    // of surfacing a false failure or starting a duplicate model call.
    if (/返回 409|409/.test(String(error?.message || error))) {
      const recovered = await waitForExpanded(env, ids, 130000);
      if (recovered) return recovered;
    }
    throw error;
  }
  const stmts = [];
  for (const item of out.items || []) {
    const t = pending[item.idx];
    if (!t) continue;
    const score = [item.aes, item.ease, item.play].map((x) => Math.max(1, Math.min(3, Number(x) || 1))).reduce((s, x) => s + x, 0);
    const status = item.dup_of && item.dup_of.trim() ? "dup" : "new";
    stmts.push(env.DB.prepare("UPDATE topics SET data = ?, score = ?, status = ?, expand_status = '', expand_error = '', updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(item), score, status, now(), t.id));
  }
  await runBatch(env, stmts);
  return (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
}

async function waitForExpanded(env, ids, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const marks = ids.map(() => "?").join(",");
    const rows = (await all(env, `SELECT * FROM topics WHERE id IN (${marks}) ORDER BY id`, ...ids)).map(hydrate);
    if (rows.length === ids.length && rows.every((topic) => topic.data?.title)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 3500));
  }
  return null;
}

async function preview(env, id) {
  const t = await getTopic(env, id);
  if (!t.data.title) throw new HttpError(409, "这个选题还没扩写");
  const cfg = await getSettings(env);
  // A retry may have different topic context or model settings. Reusing a
  // completed key makes Riffle reject the request as IDEMPOTENCY_CONFLICT.
  const text = await complete(env, cfg, { system: PREVIEW_SYSTEM, user: previewUser(t), maxTokens: 16000, idempotencyKey: `pgc-preview-${id}-${Date.now()}`, purpose: 'preview' });
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

async function readReviewBody(request) {
  if (Number(request.headers.get('Content-Length')) > 13 * 1024 * 1024) throw new HttpError(413, '审核文件过大。');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 13 * 1024 * 1024) throw new HttpError(413, '审核文件过大。');
  let input;
  try { input = JSON.parse(text); } catch { throw new HttpError(400, '审核内容不是合法 JSON。'); }
  if (typeof input?.html !== 'string' || !input.html.trim()) throw new HttpError(400, '缺少游戏源码。');
  if (new TextEncoder().encode(input.html).length > 8 * 1024 * 1024) throw new HttpError(413, '单个 HTML 不能超过 8 MB。');
  return input;
}

// Long minified/base64 lines carry no reviewable logic and cost many tokens.
function trimSource(html, max = MAX_SOURCE) {
  const lines = String(html || "").split("\n").map((l) => (l.length > 3000 ? `/* [省略一行 ${l.length} 字符] */` : l));
  let out = lines.join("\n");
  if (out.length > max) out = out.slice(0, max) + `\n/* [源码过长，后面 ${out.length - max} 字符已省略] */`;
  return out;
}

async function review(env, { title, topic_id, html, probe, shots }, ownerId, jobId = null) {
  if (!html || typeof html !== "string") throw new HttpError(400, "缺少游戏源码");
  const images = (Array.isArray(shots) ? shots : []).filter((s) => s && /^data:image\/(jpeg|png|webp);base64,/.test(s.data)).slice(0, 6);
  const [cfg, games] = await Promise.all([getSettings(env), all(env, "SELECT * FROM games ORDER BY id")]);
  // The calibration set is for the scoring scale, not for recalling this
  // game's own past result: a known score would anchor (or leak) the verdict.
  const { positives, borderline, negatives } = exampleSets(games.filter((g) => !sameGame(g.title, title)));
  // Old reviewer notes mix verified defects with subjective observations this
  // preflight cannot test (feel, listening, sustained play). Keep the real
  // historical scores as anchors, but do not teach those unsupported claims.
  const supportedNegatives = negatives.map((game) => ({ ...game, feedback: '' }));
  let design = "";
  if (topic_id) {
    const t = hydrate(await first(env, "SELECT * FROM topics WHERE id = ?", topic_id));
    if (t && t.data.title) design = `【原定设计】${t.data.title}：${t.data.logline}\n新机制：${t.data.twist}\n节奏：${t.data.progression}\n美术：${t.data.art_direction}\n`;
  }
  const parts = [];
  for (const s of images) parts.push({ type: "text", text: `截图：${s.label}` }, { type: "image", data: s.data });
  // Keep the source bounded; thinking and report tokens share an output budget.
  const reviewConfig = await env.modelStore.get();
  const smallModel = ['review', 'review_verify'].some(purpose => /deepseek/i.test(routedModel(reviewConfig, purpose)));
  const captureNote = probe?.captureMethod === 'browser-viewport-v1'
    ? '图片是浏览器完整视口截图；操作范围以采集记录为准。'
    : '警告：这是旧版采集。截图可能只包含最大 Canvas，漏掉 DOM/CSS 和其他图层，不能用白屏、画布覆盖率或色块占比判定作品画面缺陷。音频和机器人数字不是实际听感或完整试玩证据。';
  parts.push({ type: "text", text: `游戏名：${title || "未命名"}\n${design}\n【采集方法与限制】\n${captureNote}\n【运行采集记录】\n${JSON.stringify(probe || {}, null, 1)}\n\n【源码】\n${trimSource(html, smallModel ? 120000 : MAX_SOURCE)}` });
  const result = await generateReview(env, cfg, {
    system: reviewSystem({ redlines: cfg.redlines, positives, borderline, negatives: supportedNegatives }),
    user: parts,
    maxTokens: 16000,
    idempotencyKey: `pgc-review-${jobId || crypto.randomUUID()}`,
    onWait: jobId ? message => updateReviewProgress(env, jobId, message) : undefined,
  });
  const score = result.aes + result.ease + result.play;
  result.verdict = consistentVerdict(result.verdict, score);
  const r = await run(env, "INSERT OR IGNORE INTO reviews (owner_id, title, topic_id, score, result, probe, shots, created_at, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ownerId || 'admin', String(title || "未命名").slice(0, 120), topic_id || null, score, JSON.stringify(result), JSON.stringify(probe || {}), JSON.stringify(images), now(), jobId);
  const persisted = jobId ? await first(env, 'SELECT id FROM reviews WHERE job_id = ?', jobId) : null;
  return getReview(env, persisted?.id || r.meta.last_row_id, ownerId);
}

// The pass line is arithmetic (total ≥ 7); the verdict text must agree with it.
export function consistentVerdict(verdict, score) {
  const text = String(verdict || '').trim();
  const passed = score >= 7;
  if ((passed ? /^(模拟)?通过/ : /^(模拟)?打回/).test(text)) return text;
  return `${passed ? '通过' : '打回'}（${score}/9）${text ? '。' + text : ''}`;
}

// "UMBRA" and "UMBRA — Shadow Theatre" are the same game; very short keys
// must match exactly so "Up" does not swallow every title containing it.
export function sameGame(a, b) {
  const key = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const x = key(a), y = key(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
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

function brief(env, id, ctx, regenerate = false) {
  return startTopicJob(env, 'brief', id, ctx, regenerate, briefJob);
}

async function startGameJob(env: ForgeEnv, id: number) {
  const topic = await getTopic(env, id);
  if (topic.product_html?.trim()) return { id, status: 'done', has_product: true };
  if (!topic.data?.title || !['liked', 'made'].includes(topic.status)) throw new HttpError(409, "请先把已扩写的选题加入候选，再开始制作。");
  const model = activeModelProfile(await env.modelStore.get(), 'game');
  if (!model?.profile.enabled || !model.profile.encryptedKey) {
    throw new HttpError(409, "游戏制作必须使用 Claude Opus 5.5，请在管理页保存并启用对应配置。");
  }
  if (['queued', 'running'].includes(topic.product_status)) return { id, status: 'pending' };
  const requestId = crypto.randomUUID();
  const claim = await run(env, "UPDATE topics SET product_status = 'queued', product_error = '等待后台制作队列…', product_request_id = ?, updated_at = ? WHERE id = ? AND product_status IN ('', 'error')", requestId, now(), id);
  if (!claim.meta?.changes) return { id, status: 'pending' };
  try {
    if (!env.FORGE_QUEUE) throw new HttpError(503, "后台制作队列尚未就绪，请稍后重试。");
    await env.FORGE_QUEUE.send({ type: 'game', id, requestId });
  } catch (error) {
    await run(env, "UPDATE topics SET product_status = 'error', product_error = ?, updated_at = ? WHERE id = ? AND product_request_id = ?", String(error?.message || error).slice(0, 500), now(), id, requestId);
    throw new HttpError(503, "制作任务未能进入后台队列，请重试。");
  }
  return { id, status: 'pending' };
}

async function startTopicJob(env, kind: TopicJobKind, id, ctx, regenerate, job: (env, id, t) => Promise<unknown>) {
  const k = TOPIC_JOBS[kind];
  const t = await getTopic(env, id);
  if (!t.data.title) throw new HttpError(409, "这个选题还没扩写");
  if (kind === 'assets' && !t.brief_md?.trim()) throw new HttpError(409, "先生成简报（细纲），资产要按它来做。");
  // A previous request may have completed after the browser lost its
  // connection. Return the persisted result instead of generating it again.
  const staleBefore = staleJobBefore();
  if (t[k.status] === 'running' && !(String(t.updated_at || '') < staleBefore)) return { id, status: 'pending' };
  if (!regenerate && typeof t[k.output] === "string" && t[k.output].trim()) return { id, [kind]: t[k.output] };
  if (env.FORGE_QUEUE || ctx?.waitUntil) {
    const claim = await run(env, `UPDATE topics SET ${k.status} = 'running', ${k.error} = '', updated_at = ? WHERE id = ? AND (${k.status} = '' OR ${k.status} = 'error' OR (${k.status} = 'running' AND updated_at < ?))`, now(), id, staleBefore);
    if (!claim.meta?.changes) return { id, status: 'pending' };
    if (env.FORGE_QUEUE) await env.FORGE_QUEUE.send({ type: kind, id });
    else ctx.waitUntil(job(env, id, t).catch(error => markTopicJobError(env, kind, id, error)));
    return { id, status: 'pending' };
  }
  return job(env, id, t);
}

function markTopicJobError(env, kind: TopicJobKind, id, error, onlyIfRunning = false) {
  const k = TOPIC_JOBS[kind];
  return run(env, `UPDATE topics SET ${k.status} = 'error', ${k.error} = ?, updated_at = ? WHERE id = ?${onlyIfRunning ? ` AND ${k.status} = 'running'` : ''}`,
    String(error?.message || error).slice(0, 500), now(), id).catch(() => {});
}

export async function processForgeJob(env: ForgeEnv, job: ForgeJob) {
  if (job.type === 'review') return processReviewJob(env, job.id, (payload, ownerId, jobId) => review(env, payload, ownerId, jobId));
  if (job.type === 'game') return produceGame(env, job.id, job.requestId);
  if (job.type === 'expand') {
    try { return await expandBatch(env, job.ids); }
    catch (error) {
      await run(env, `UPDATE topics SET expand_status = 'error', expand_error = ?, updated_at = ? WHERE id IN (${job.ids.map(() => "?").join(",")}) AND expand_status = 'running'`, String(error?.message || error).slice(0, 500), now(), ...job.ids).catch(() => {});
      throw error;
    }
  }
  const run_ = job.type === 'assets' ? assetsJob : briefJob;
  try { return await run_(env, job.id, await getTopic(env, job.id)); }
  catch (error) {
    await markTopicJobError(env, job.type, job.id, error, true);
    throw error;
  }
}

// ---------- assets ----------

const ASSET_SECTION = `

## H. 美术资产（必须使用）
- 本简报附带同名的 assets.html（在工作台候选卡片里下载），用浏览器打开就能看到全部资产和一张合成的游戏画面。
- 把其中 <script id="game-assets"> 整段原样复制进游戏，所有角色、敌人、道具、背景、HUD 和特效都调用 GAME_ASSETS 里的绘制函数，不要重新设计造型和配色。
- sprites / ui 的 draw 以 (0, 0) 为中心、单位是逻辑像素；状态和动画由参数里的 t、state、frame 控制；backgrounds 铺满 (0, 0, w, h)；fx 用进度 p。
- 资产里没有的元素，按 meta.style 的风格规范和同一套配色补画，并在交付自检里列出补了哪些。
`;

export function composeBrief(t) {
  if (!t?.brief_md?.trim()) return '';
  return t.assets_html?.trim() ? t.brief_md.trimEnd() + ASSET_SECTION : t.brief_md;
}

// The F part (from "## F.") is the design the assets must cover; the fixed
// A–G platform rules before it are not needed for drawing.
function designPart(md) {
  const text = String(md || '');
  const at = text.search(/^##\s*F[.．、\s]/m);
  // Keep long production tables out of the asset prompt so adaptive
  // thinking leaves room for the actual drawing library.
  return (at >= 0 ? text.slice(at) : text).slice(0, 9000);
}

export function cleanAssetsHtml(text) {
  const raw = String(text || '').replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = raw.search(/<!doctype html|<html[\s>]/i);
  const end = raw.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < start) throw new LLMError('模型没有返回完整的资产 HTML（可能输出被截断），请重新生成。', 502);
  const html = raw.slice(start, end + 7)
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed)\b[\s\S]*?(<\/\1>|\/>)/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/@import[^;]*;/gi, '');
  if (!/<script\b[^>]*\bid\s*=\s*["']game-assets["']/i.test(html) || !/GAME_ASSETS/.test(html)) {
    throw new LLMError('资产 HTML 里缺少 <script id="game-assets"> 和 GAME_ASSETS，请重新生成。', 502);
  }
  if (html.length > 400_000) throw new LLMError('资产 HTML 超过 400KB，请重新生成。', 502);
  return html;
}

async function assetsJob(env, id, t) {
  const cfg = await getSettings(env);
  const slowModel = /opus|claude/i.test(routedModel(await env.modelStore.get(), 'assets'));
  try {
    const text = await withTopicLease(env, [id], 'assets_status', () => complete(env, cfg, {
      system: ASSETS_SYSTEM,
      purpose: 'assets',
      user: assetsUser(t, designPart(t.brief_md), t.preview_svg || ''),
      // Thinking and HTML share this budget. Keep the artifact compact and
      // make this a single paid attempt: a truncated asset pack is not safely
      // repairable by replaying the whole request with a fresh key.
      // Opus adaptive thinking and the asset library share this budget. The
      // provider advertises a 64k output ceiling; use it once rather than
      // paying for blind retries after a thinking-only truncation.
      maxTokens: 64000,
      timeoutMs: slowModel ? 600000 : 180000,
      maxAttempts: 1,
      outputEffort: 'low',
      idempotencyKey: `pgc-assets-${id}-${Date.now()}`,
      onWait: message => run(env, "UPDATE topics SET assets_error = ? WHERE id = ? AND assets_status = 'running'", message, id),
    }));
    const html = cleanAssetsHtml(text);
    await run(env, "UPDATE topics SET assets_html = ?, assets_status = '', assets_error = '', updated_at = ? WHERE id = ?", html, now(), id);
    return { id, assets: html };
  } catch (error) {
    await markTopicJobError(env, 'assets', id, error);
    throw error;
  }
}

async function produceGame(env: ForgeEnv, id: number, requestId: string) {
  const claim = await run(env, "UPDATE topics SET product_status = 'running', product_error = '正在准备制作材料…', updated_at = ? WHERE id = ? AND product_request_id = ? AND product_status = 'queued'", now(), id, requestId);
  if (!claim.meta?.changes) return { id, status: 'ignored' };
  const deadline = Date.now() + 12 * 60 * 1000;
  const stage = (message: string) => run(env, "UPDATE topics SET product_error = ?, updated_at = ? WHERE id = ? AND product_request_id = ? AND product_status = 'running'", message, now(), id, requestId);
  return withTopicLease(env, [id], 'product_status', async () => {
  try {
    const topic = await getTopic(env, id);
    if (topic.product_html?.trim()) return { id, status: 'done' };
    const model = activeModelProfile(await env.modelStore.get(), 'game');
    if (!model?.profile.enabled || !model.profile.encryptedKey) throw new HttpError(409, "游戏制作必须使用 Claude Opus 5.5，请在管理页保存并启用对应配置。");
    const cfg = await getSettings(env);
    // Expanded topics already contain the playable core. A full production
    // brief could exhaust the model before any HTML is made; keep it optional.
    await stage('模型正在编写完整 HTML 游戏…');
    const text = await withTopicLease(env, [id], 'product_status', () => complete(env, cfg, {
      system: GAME_SYSTEM,
      user: gameUser(topic, composeBrief(topic), topic.assets_html),
      maxTokens: 32768,
      timeoutMs: 300000,
      deadline, idempotencyKey: `pgc-game-${requestId}`, outputFormat: 'html',
      purpose: 'game', requiredProfile: 'opus', maxAttempts: 1, outputEffort: 'low',
      onWait: message => stage(message || '模型正在编写完整 HTML 游戏…'),
      onProgress: characters => stage(characters ? `模型正在编写游戏，已接收 ${characters.toLocaleString('en-US')} 个字符…` : '模型正在准备游戏代码…'),
    }));
    const html = cleanGameHtml(text);
    await run(env, "UPDATE topics SET product_html = ?, product_status = '', product_error = '', status = 'made', updated_at = ? WHERE id = ? AND product_request_id = ? AND product_status = 'running'", html, now(), id, requestId);
    return { id, status: 'done' };
  } catch (error) {
    const message = String(error?.message || error);
    const reason = /模型响应超时/.test(message) ? '模型未能在制作时限内返回完整游戏，本次未保存成品；请稍后重试。'
      : /长度上限/.test(message) ? '模型达到本次游戏生成的输出额度，未返回完整 HTML；未保存成品，也未自动重复制作。可点击重试制作。' : message;
    await run(env, "UPDATE topics SET product_status = 'error', product_error = ?, updated_at = ? WHERE id = ? AND product_request_id = ? AND product_status = 'running'", reason.slice(0, 500), now(), id, requestId).catch(() => {});
    throw error;
  }
  });
}

async function briefJob(env, id, t) {
  const cfg = await getSettings(env);
  const slowModel = /opus|claude/i.test(routedModel(await env.modelStore.get(), 'brief'));
  try {
    const md = await withTopicLease(env, [id], 'brief_status', () => complete(env, cfg, {
        system: briefSystem({ templateF: cfg.template_f, redlines: cfg.redlines }),
        purpose: 'brief',
        user: briefUser(t),
        // Reserve room for both thinking and the complete production brief.
        maxTokens: 24000,
        timeoutMs: slowModel ? 300000 : 180000,
        idempotencyKey: `pgc-brief-${id}-${Date.now()}`,
        onWait: message => run(env, "UPDATE topics SET brief_error = ? WHERE id = ? AND brief_status = 'running'", message, id),
      }));
    const body = String(md).trim();
    if (!body) throw new LLMError("模型没有返回简报内容", 502);
    const full = cfg.template + body + "\n";
    await run(env, "UPDATE topics SET brief_md = ?, brief_status = '', brief_error = '', status = CASE WHEN status = 'made' THEN status ELSE 'liked' END, updated_at = ? WHERE id = ?", full, now(), id);
    return { id, brief: full };
  } catch (error) {
    await run(env, "UPDATE topics SET brief_status = 'error', brief_error = ?, updated_at = ? WHERE id = ?", String(error?.message || error).slice(0, 500), now(), id).catch(() => {});
    throw error;
  }
}
