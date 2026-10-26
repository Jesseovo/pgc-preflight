// Reads the head reviewer's "版本审核记录" xlsx export in the browser and turns
// it into the { works } shape accepted by POST import. Member names are only
// used here to tell "mine" from "peer"; they are never sent to the server.

const HEADERS = {
  member: (h) => h === "组员",
  title: (h) => h === "游戏名称",
  version: (h) => h === "版本",
  stage: (h) => h === "审核阶段",
  decision: (h) => h === "审核结果",
  aes: (h) => h.startsWith("美学"),
  ease: (h) => h.startsWith("易玩性"),
  play: (h) => h.startsWith("可玩性"),
  feedback: (h) => h.startsWith("审核意见"),
};

const NO_FEEDBACK = /^（?无审核意见）?$/;

// ---------- xlsx (zip + XML) ----------

// Element names may carry a namespace prefix (<x:row> from the OpenXML SDK).
const P = "(?:[\\w.-]+:)?";
const tag = (name, flags = "g") => new RegExp(`<${P}${name}\\b[^>]*>([\\s\\S]*?)<\\/${P}${name}>`, flags);

export async function readXlsxRows(buffer) {
  const files = await unzip(new Uint8Array(buffer));
  const text = (name) => (files.has(name) ? new TextDecoder().decode(files.get(name)) : "");
  const shared = [...text("xl/sharedStrings.xml").matchAll(tag("si"))].map((m) => xmlText(m[1]));
  const firstSheet = new RegExp(`<${P}sheet\\b[^>]*\\br:id="([^"]+)"`).exec(text("xl/workbook.xml"));
  let path = "xl/worksheets/sheet1.xml";
  if (firstSheet) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet[1]}"[^>]*\\bTarget="([^"]+)"`).exec(text("xl/_rels/workbook.xml.rels"))
      || new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheet[1]}"`).exec(text("xl/_rels/workbook.xml.rels"));
    if (rel) path = "xl/" + rel[1].replace(/^\/?xl\//, "");
  }
  const sheet = text(path);
  if (!sheet) throw new Error("表格里没有找到工作表");
  const rows = [];
  for (const row of sheet.matchAll(tag("row"))) {
    const cells = [];
    for (const c of row[1].matchAll(new RegExp(`<${P}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}c>)`, "g"))) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1]);
      const type = (/\bt="([^"]+)"/.exec(c[1]) || [])[1];
      const body = c[2] || "";
      const v = (tag("v", "").exec(body) || [])[1];
      let value = null;
      if (type === "s") value = shared[Number(v)] ?? null;
      else if (type === "inlineStr") value = xmlText(body);
      else if (v != null) value = decodeXml(v);
      cells[ref ? colIndex(ref[1]) : cells.length] = value;
    }
    rows.push(Array.from(cells, (x) => (x === undefined ? null : x)));
  }
  return rows;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xmlText(fragment) {
  return [...fragment.matchAll(tag("t"))].map((m) => decodeXml(m[1])).join("");
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

// Minimal zip reader: central directory + stored/deflate entries.
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx 文件");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("xlsx 文件已损坏");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(sharedStrings|workbook)\.xml$|^xl\/_rels\/workbook\.xml\.rels$|^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
    else throw new Error(`xlsx 使用了不支持的压缩方式（${method}）`);
  }
  return files;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- rows → works ----------

export function findColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const header = rows[i].map((h) => String(h ?? "").trim());
    const cols = {};
    for (const [key, test] of Object.entries(HEADERS)) {
      const idx = header.findIndex((h) => h && test(h));
      if (idx >= 0) cols[key] = idx;
    }
    if (cols.title != null && cols.stage != null && cols.decision != null) return { headerRow: i, cols };
  }
  throw new Error("没有找到表头：需要「游戏名称」「审核阶段」「审核结果」这几列");
}

export function listMembers(rows) {
  const { headerRow, cols } = findColumns(rows);
  if (cols.member == null) return [];
  return [...new Set(rows.slice(headerRow + 1).map((r) => String(r[cols.member] ?? "").trim()).filter(Boolean))];
}

// self: the member name to mark as "mine"; everyone else becomes "peer".
export function sheetToWorks(rows, { self = "" } = {}) {
  const { headerRow, cols } = findColumns(rows);
  const cell = (r, k) => (cols[k] == null ? "" : String(r[cols[k]] ?? "").trim());
  const groups = new Map();
  for (const r of rows.slice(headerRow + 1)) {
    const title = cell(r, "title");
    if (!title) continue;
    const member = cell(r, "member");
    const key = member + "\u0000" + title;
    if (!groups.has(key)) groups.set(key, { member, title, versions: new Map() });
    const g = groups.get(key);
    const rev = Number.parseInt(cell(r, "version"), 10) || 1;
    if (!g.versions.has(rev)) g.versions.set(rev, { r: rev });
    const v = g.versions.get(rev);
    const scores = ["aes", "ease", "play"].map((k) => Number.parseInt(cell(r, k), 10));
    const s = scores.every((x) => Number.isFinite(x)) ? scores.join("/") : null;
    const fb = NO_FEEDBACK.test(cell(r, "feedback")) ? "" : cell(r, "feedback");
    const stage = cell(r, "stage");
    const decision = cell(r, "decision");
    if (stage === "最终审核") Object.assign(v, { s, fb, final: decision });
    else if (stage.includes("初审")) Object.assign(v, { ps: s, pfb: fb, first: decision });
  }
  return [...groups.values()].map((g) => {
    const versions = [...g.versions.values()].sort((a, b) => a.r - b.r);
    return {
      id: "sheet-" + hash(g.member + "|" + g.title.toLowerCase()),
      title: g.title,
      desc: "",
      status: workStatus(versions),
      source: self && g.member === self ? "mine" : "peer",
      match: "title",
      versions: versions.map(({ r, s = null, ps = null, fb = "", pfb = "" }) => ({ r, s, ps, fb, pfb })),
    };
  });
}

// The newest version that received any decision sets the status.
function workStatus(versions) {
  for (const v of [...versions].reverse()) {
    if (v.final) return v.final.includes("通过") ? "approved" : v.final.includes("退回") ? "rejected" : "pending";
    if (v.first) return v.first.includes("通过") ? "preapproved" : "rejected";
  }
  return "pending";
}

function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
