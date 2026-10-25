import { DIRECTION } from "./defaults.js";
import { DIMS, DIM_LABEL } from "./logic.js";

function gameLine(g) {
  const s = g.score != null ? `${g.score}/9 (${g.aes}/${g.ease}/${g.play})` : g.status;
  const rev = (g.revisions || 1) > 1 ? `，改了 ${g.revisions} 版` : "";
  const tags = [g.subject, g.medium, g.gesture, g.structure].filter(Boolean).join(" · ");
  return `- ${g.title}｜${g.descr}｜${tags}｜${s}${rev}`;
}

// Stable part of the expansion prompt. Only changes when the knowledge base changes.
export function expandSystem({ redlines, positives, negatives }) {
  return `你是 PGC 游戏平台的资深选题策划。你的任务：把随机抽到的"种子组合"扩写成能拿 7 分以上的竖屏小游戏选题，并且像审核员一样苛刻地给它们预估打分。

${DIRECTION}

${redlines}

【高分正例（≥ 8 分，数据来自真实审核）】
${positives.map(gameLine).join("\n")}

【反例与驳回意见（真实审核原话摘要）】
${negatives.map((g) => gameLine(g) + `\n    驳回意见：${g.feedback}`).join("\n")}

【扩写要求】
- 种子组合 = 题材 × 美术媒介 × 手势 × 挑战结构 × 情绪基调。题材和美术媒介必须保留；手势、结构、基调可以微调到更合适的近似项，但要在 twist 里说明为什么。
- 手势必须和题材"同构"：玩家的触摸动作就是角色在故事里做的动作（盖戳就是点、斩击就是划、撑住就是按住）。
- 必须有一个能一句话说出来的新机制（twist），让它和市面上同类小游戏明显不同。
- progression 写清 0–30 秒、30–60 秒、60 秒后分别出现什么新元素，以及难度如何增长、什么会杀死玩家。
- art_direction 写出这个媒介的具体视觉特征（线条、纹理、配色、动效），让人一读就能想象画面；palette 给 5 个 hex。
- 预估分数要真实：美学看媒介是否独特且能用 Canvas 画漂亮；易玩性看手势是否熟悉宽容、规则 5 秒能懂；可玩性看是否有刷分欲望、30 秒内是否有新东西。不确定就给 2，绝大多数组合是 2/2/2。
- 如果和"已有作品清单"里任何一款的核心玩法或题材明显相似，dup_of 填那款的标题，否则填空字符串。
- title 用英文 1–2 个词，有记忆点；其他字段用中文。`;
}

export function expandUser({ existing, combos }) {
  return `【已有作品清单（不要和它们撞题）】
${existing.join("\n")}

【本次种子组合】
${combos.map((c, i) => `${i}. ` + DIMS.map((d) => `${DIM_LABEL[d]}=${c[d]}`).join("，")).join("\n")}

为每个组合输出一项，idx 对应组合编号。`;
}

const str = { type: "string" };
const int = { type: "integer" };

export const EXPAND_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idx: int,
          title: str,
          logline: str,
          core_loop: str,
          controls: str,
          twist: str,
          progression: str,
          art_direction: str,
          palette: { type: "array", items: str },
          audio: str,
          why_addictive: str,
          risks: str,
          aes: int,
          ease: int,
          play: int,
          dup_of: str,
        },
        required: ["idx", "title", "logline", "core_loop", "controls", "twist", "progression", "art_direction", "palette", "audio", "why_addictive", "risks", "aes", "ease", "play", "dup_of"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const PREVIEW_SYSTEM = `你是游戏美术总监，为竖屏手机小游戏画一张 9:16 的风格样板图（key art）。
输出要求：
- 一个完整的 SVG 文档，viewBox="0 0 540 960"，width 和 height 不写。
- 只用基础图形、路径、渐变和 pattern；不要 <script>、<foreignObject>、<image>、外部链接、事件属性和 CSS @import。
- 体现指定的美术媒介特征（线条、纹理、配色），画出主角、一个敌人或障碍、背景场景，顶部留出 HUD 区域的示意。
- 唯一的文字是游戏标题（英文），放在顶部 HUD 区下方。
- 文件不超过 9000 个字符。只输出 SVG 本身。`;

export function previewUser(topic) {
  const d = topic.data || {};
  return `游戏：${d.title}
一句话：${d.logline}
美术媒介：${topic.medium}
美术方向：${d.art_direction}
配色：${(d.palette || []).join(" ")}
核心玩法：${d.core_loop}`;
}

export function briefSystem({ templateF, redlines }) {
  return `你是资深游戏策划。根据给定选题，填写游戏设计文档的 F 部分，供另一个 AI 一次性写出完整游戏代码。

${DIRECTION}

${redlines}

要求：
- 严格按下面的 F 部分结构逐节填写，表格要填满，数值要具体（秒、像素、次数）。
- 第一个新元素在 30 秒内出现，之后每 30–60 秒一个；写清防偷懒设计。
- 文案全部英文；其余说明用中文。
- 只输出填好的 F 部分 Markdown，不要前言和总结。

${templateF}`;
}

export function briefUser(topic) {
  const d = topic.data || {};
  return `选题：
- 名称：${d.title}
- 题材：${topic.subject}；美术媒介：${topic.medium}；手势：${topic.gesture}；结构：${topic.structure}；基调：${topic.mood}
- 一句话：${d.logline}
- 核心循环：${d.core_loop}
- 操作：${d.controls}
- 新机制：${d.twist}
- 节奏：${d.progression}
- 美术：${d.art_direction}（配色 ${(d.palette || []).join(" ")}）
- 音频：${d.audio}
- 风险提示：${d.risks}
${topic.note ? "- 我的补充要求：" + topic.note : ""}`;
}

// Mock review of a finished game. The real review history is the calibration set.
export function reviewSystem({ redlines, positives, negatives }) {
  return `你是 PGC 游戏平台的审核员。你要像真实审核员一样体验并评分一款即将提交的竖屏小游戏，在它被真正打回之前找出问题。

${DIRECTION}

评分维度（每项 1–3 分）：
- 美学：画面与风格是否好看、协调，视觉反馈是否清楚。
- 易玩性：规则易懂，操控顺手，新玩家能快速开始。
- 可玩性：玩法有趣，有继续游玩或反复挑战的动力。

${redlines}

【真实审核的校准样本：通过的（≥ 8 分）】
${positives.map(gameLine).join("\n")}

【真实审核的校准样本：打回的及原话】
${negatives.map((g) => gameLine(g) + `\n    审核原话：${g.feedback}`).join("\n")}

【你会拿到】
- 截图：手机竖屏实际运行画面，图片前会标明是哪种屏幕比例、开局前还是开局后几秒。整张图就是手机屏幕，图里的黑边或色块就是玩家会看到的黑边。
- 自动体检报告：报错、画布覆盖率、边缘色块、音频节点启动次数（判断有没有 BGM）、偷懒策略机器人的存活时间。机器人存活到上限时间说明"不操作/乱点也死不了"。
- 源码（过长的行已省略）。

【要求】
- 打分和真实审核员一样严格：2/2/2 是常态，只有确实出彩才给 3；有明显违反平台方向或雷区的项给 1。总分 ≥ 7 才算通过。
- 问题必须有证据：引用截图里看到的、体检报告里的数字，或源码里的具体位置（函数名、TUNING 字段）。不要泛泛而谈。
- 按严重程度排序：会直接导致打回的为"高"。
- reviewer_comment 用真实审核员的口吻写一两句最可能的审核意见。
- fix_prompt 是一段可以直接发给写代码的 AI 的中文修改指令：逐条列出要改什么、改成什么、改到什么程度（给数值），不要重写整个游戏，不要改动没问题的部分。`;
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    aes: int,
    ease: int,
    play: int,
    verdict: str,
    reviewer_comment: str,
    strengths: { type: "array", items: str },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: { severity: str, area: str, problem: str, evidence: str, fix: str },
        required: ["severity", "area", "problem", "evidence", "fix"],
        additionalProperties: false,
      },
    },
    fix_prompt: str,
  },
  required: ["aes", "ease", "play", "verdict", "reviewer_comment", "strengths", "issues", "fix_prompt"],
  additionalProperties: false,
};

export function suggestSystem({ redlines, positives }) {
  return `你帮 PGC 小游戏选题库补充新词。

${DIRECTION}

${redlines}

【高分正例】
${positives.map(gameLine).join("\n")}

题材（subject）要求：具体、可视觉化、有天然动作的物件/职业/民俗/自然现象/历史场景，2–6 个字，例如"灯塔守护人""金缮修复""舞狮"。避免抽象概念和大众烂题材（水果、太空射击、跑酷小人）。
美术媒介（medium）要求：现实中存在、有鲜明视觉特征、能用 Canvas 程序化画出来的媒介或风格，2–8 个字，例如"泥金手抄本""卢布克木版画""飞机安全须知卡"。
每个词附一句备注，说明它为什么适合做竖屏挑战小游戏。`;
}

export function suggestUser(dim, n, existing) {
  return `请为维度"${DIM_LABEL[dim]}"（${dim}）提出 ${n} 个新词，不要和下面已有的词重复或近义：
${existing.join("、")}`;
}

export const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: { type: "object", properties: { word: str, note: str }, required: ["word", "note"], additionalProperties: false },
    },
  },
  required: ["words"],
  additionalProperties: false,
};

export function tagSystem(vocabByDim) {
  return `你给小游戏打标签。题材（subject）用 2–6 个字自由概括这款游戏的具体题材；其余每个维度只能从给定词表里选一个最贴近的词，词表里实在没有就填空字符串。

${DIMS.filter((d) => d !== "subject").map((d) => `${DIM_LABEL[d]}（${d}）：${vocabByDim[d].join("、")}`).join("\n")}`;
}

export function tagUser(games) {
  return games.map((g) => `id=${g.id}｜${g.title}｜${g.descr}`).join("\n");
}

export const TAG_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: int, subject: str, medium: str, gesture: str, structure: str, mood: str },
        required: ["id", "subject", "medium", "gesture", "structure", "mood"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};
