export function cleanGameHtml(text) {
  const raw = String(text || '').trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = raw.search(/<!doctype html|<html[\s>]/i);
  const end = raw.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < start) throw new Error('Opus 没有返回完整的 HTML 游戏文件，请重试。');
  const html = raw.slice(start, end + 7)
    .replace(/<script\b[^>]*\bsrc\s*=\s*[^>]*>\s*<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed)\b[\s\S]*?(<\/\1>|\/>)/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/@import[^;]*;/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/)[^)]*\)/gi, 'none')
    .replace(/\s(?:src|href|poster|srcset)\s*=\s*(["'])\s*(?:https?:|\/\/)[^"']*\1/gi, '');
  if (!/<meta\b[^>]*name\s*=\s*(["'])viewport\1/i.test(html)) throw new Error('生成的游戏缺少手机 viewport 配置，请重试。');
  if (!/<script\b[\s\S]*?<\/script>/i.test(html)) throw new Error('生成的游戏缺少可运行脚本，请重试。');
  if (html.length > 600_000) throw new Error('生成的单文件 HTML 超过 600KB，请重试并减少素材。');
  return html;
}
