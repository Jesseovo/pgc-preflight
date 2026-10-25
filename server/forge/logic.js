// Pure functions: weight learning, weighted draw, dedup. No I/O here.

export const DIMS = ["subject", "medium", "gesture", "structure", "mood"];
export const DIM_LABEL = { subject: "题材", medium: "美术媒介", gesture: "手势", structure: "挑战结构", mood: "情绪基调" };

const SCORED = new Set(["approved", "preapproved", "rejected"]);

// A game's "topic quality" signal: final score, minus friction for each extra
// round of fixes (a topic that needed 4 rounds was harder to get right).
export function gameSignal(g) {
  if (!SCORED.has(g.status) || g.score == null) return null;
  return g.score - 0.3 * Math.max(0, (g.revisions || 1) - 1);
}

// Learned multiplier per (dim, word), from review scores and the user's own
// like/reject clicks on drawn topics.
export function learnedFactors(games, topics) {
  const acc = {};
  const key = (d, w) => d + "\u0000" + w;
  for (const g of games) {
    const s = gameSignal(g);
    if (s == null) continue;
    for (const d of ["medium", "gesture", "structure", "mood"]) {
      if (!g[d]) continue;
      const k = key(d, g[d]);
      (acc[k] ||= { sum: 0, n: 0, likes: 0, rejects: 0 }).sum += s;
      acc[k].n += 1;
    }
  }
  for (const t of topics) {
    if (t.status !== "liked" && t.status !== "made" && t.status !== "rejected") continue;
    for (const d of DIMS) {
      const k = key(d, t[d]);
      const a = (acc[k] ||= { sum: 0, n: 0, likes: 0, rejects: 0 });
      if (t.status === "rejected") a.rejects += 1; else a.likes += 1;
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) {
    let f = 1;
    let avg = null;
    if (a.n) {
      avg = a.sum / a.n;
      f = 1 + (avg - 6.6) * 0.45 * Math.min(a.n, 3) / 3;
    }
    f *= Math.pow(1.06, a.likes) * Math.pow(0.88, a.rejects);
    out[k] = { factor: clamp(f, 0.35, 1.8), avg, n: a.n, likes: a.likes, rejects: a.rejects };
  }
  return out;
}

export function factorFor(factors, dim, word) {
  return factors[dim + "\u0000" + word] || { factor: 1, avg: null, n: 0, likes: 0, rejects: 0 };
}

// Everything already made or already drawn must not come back.
export function usedSets(games, topics) {
  const subjects = new Set();
  const triples = new Set();
  const pairs = new Set();
  for (const x of [...games, ...topics]) {
    if (x.subject) subjects.add(norm(x.subject));
    if (x.gesture && x.structure && x.medium) triples.add(tripleKey(x));
    if (x.subject && x.medium) pairs.add(norm(x.subject) + "|" + norm(x.medium));
  }
  return { subjects, triples, pairs };
}

export function tripleKey(x) {
  return [x.gesture, x.structure, x.medium].map(norm).join("|");
}

// Draw n combos. locks: { dim: word } pins a dimension.
export function drawCombos({ vocab, games, topics, n, locks = {}, rng = Math.random }) {
  const factors = learnedFactors(games, topics);
  const used = usedSets(games, topics);
  const pools = {};
  for (const d of DIMS) {
    pools[d] = vocab
      .filter((v) => v.dim === d && v.enabled)
      .map((v) => ({ word: v.word, w: Math.max(0, v.base) * factorFor(factors, d, v.word).factor }))
      .filter((v) => v.w > 0);
  }
  // A subject that is already used is never drawn again.
  pools.subject = pools.subject.filter((v) => !used.subjects.has(norm(v.word)));

  const out = [];
  const seenBatch = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 60) {
    const c = {};
    for (const d of DIMS) {
      c[d] = locks[d] || pickWeighted(pools[d], rng, d === "subject" ? seenBatch : null);
      if (!c[d]) return out; // a pool is empty
    }
    if (!locks.subject && used.subjects.has(norm(c.subject))) continue;
    if (used.triples.has(tripleKey(c))) continue;
    if (seenBatch.has(norm(c.subject)) && !locks.subject) continue;
    seenBatch.add(norm(c.subject));
    out.push(c);
  }
  return out;
}

function pickWeighted(pool, rng, exclude) {
  const items = exclude ? pool.filter((p) => !exclude.has(norm(p.word))) : pool;
  const total = items.reduce((s, p) => s + p.w, 0);
  if (!items.length || total <= 0) return null;
  let r = rng() * total;
  for (const p of items) {
    r -= p.w;
    if (r <= 0) return p.word;
  }
  return items[items.length - 1].word;
}

// Few-shot material for the prompts: deterministic order so the prompt prefix
// stays byte-identical between calls (prompt caching).
export function exampleSets(games) {
  const scored = games.filter((g) => gameSignal(g) != null);
  const byScore = (a, b) => (b.score - a.score) || ((a.revisions || 1) - (b.revisions || 1)) || a.title.localeCompare(b.title);
  const positives = scored.filter((g) => g.status !== "rejected" && g.score >= 8).sort(byScore).slice(0, 24);
  const negatives = scored
    .filter((g) => g.status === "rejected" || (g.revisions || 1) >= 3)
    .filter((g) => g.feedback)
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, 36);
  return { positives, negatives };
}

export function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
