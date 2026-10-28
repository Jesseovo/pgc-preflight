// This is a representation for the reviewer, never executed HTML. Only encoded
// media payloads are shortened; minified event handlers and game logic remain.
export function reviewSource(html: string, max = 240000) {
  let omitted = 0;
  const compact = String(html || '').replace(/data:((?:image|audio|video|font)\/[a-z0-9.+-]+)(;[^\s"'<>`,)]*)?;base64,([a-z0-9+/=\r\n]+)/gi, (all, mime: string, _params: string, bytes: string) => {
    if (bytes.length < 256) return all;
    omitted += bytes.length;
    return `data:${mime};base64,[编码素材已省略，${bytes.replace(/\s/g, '').length}字符；画面以原始截图为准]`;
  });
  const note = omitted ? `/* 仅省略内嵌媒体编码 ${omitted} 字符，未改动可执行游戏逻辑；音频仍需人工听音。 */\n` : '';
  if (compact.length <= max) return note + compact;
  // Keep both initialization and end-of-file controls/restart handlers. The
  // explicit gap prevents the model from treating omitted code as absent.
  let head = Math.floor(max * 0.7), tail = max - head;
  if (/[\uD800-\uDBFF]/.test(compact[head - 1])) head--;
  if (/[\uDC00-\uDFFF]/.test(compact[compact.length - tail])) tail--;
  return note + compact.slice(0, head) + `\n/* 源码过长，中间 ${compact.length - head - tail} 字符已省略；未见实现不代表不存在。 */\n` + compact.slice(-tail);
}
