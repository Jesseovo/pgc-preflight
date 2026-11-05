import {ModelOutputError} from './model';
import {parseRootJson} from './forge-llm';

// Keep source bytes out of JSON escaping while preserving an exact structured
// stage contract. This only decodes framing; it never repairs or invents fields.
export function parseProductionOutput(text:string){
  const source=text.trim();
  const markers=['<PGC_HTML>','</PGC_HTML>','<PGC_RECORD>','</PGC_RECORD>'];
  const match=/^<PGC_HTML>\r?\n([\s\S]+?)\r?\n<\/PGC_HTML>\s*<PGC_RECORD>\r?\n([\s\S]+?)\r?\n<\/PGC_RECORD>$/.exec(source);
  if(!match||markers.some(marker=>source.split(marker).length!==2)){
    throw new ModelOutputError('制作阶段未交付完整且唯一的 HTML 与制作记录分段；没有提取代码片段或自动重试。','format');
  }
  const record=parseRootJson(match[2]);
  if(!record||typeof record!=='object'||Array.isArray(record)||Object.hasOwn(record,'html')){
    throw new ModelOutputError('制作记录必须是独立 JSON 对象，不能重复声明 HTML。','format');
  }
  return {html:match[1],...record};
}
