import {gamePlayer} from './game-player.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inline=value=>escape(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');

// Model text is data. Only these small Markdown constructs produce markup;
// raw HTML and arbitrary links remain escaped, including inside tables.
export function renderMarkdown(value){
  const lines=String(value??'').replace(/\r\n/g,'\n').split('\n'),out=[];
  let paragraph=[],list='',code=null;
  const flush=()=>{if(paragraph.length){out.push('<p>'+paragraph.map(inline).join('<br>')+'</p>');paragraph=[];}if(list){out.push('</'+list+'>');list='';}};
  const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(v=>v.trim());
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*```/.test(line)){flush();if(code){out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');code=null;}else code=[];continue;}
    if(code){code.push(line);continue;}
    if(!line.trim()){flush();continue;}
    if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
      flush();const headers=cells(line);i++;const rows=[];
      while(i+1<lines.length&&lines[i+1].includes('|'))rows.push(cells(lines[++i]));
      out.push('<div class="brief-table"><table><thead><tr>'+headers.map(v=>'<th>'+inline(v)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(v=>'<td>'+inline(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)$/),item=line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if(heading){flush();const level=Math.min(heading[1].length+1,6);out.push(`<h${level}>${inline(heading[2])}</h${level}>`);}
    else if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){flush();out.push('<hr>');}
    else if(item){if(paragraph.length)flush();const type=/^\s*\d/.test(line)?'ol':'ul';if(list!==type){if(list)out.push('</'+list+'>');out.push('<'+type+'>');list=type;}out.push('<li>'+inline(item[1])+'</li>');}
    else{if(list)flush();paragraph.push(line);}
  }
  flush();if(code)out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');return out.join('');
}

export function briefDocument(text){
  const value=String(text??''),start=value.search(/^#{1,3}\s+F[.．、\s]/m);
  // The shared contract is useful for export; lead the reader with this game's
  // generated design instead of repeating the same A–G checklist every time.
  const design=start>0?value.slice(start):value,contract=start>0?value.slice(0,start).trim():'';
  return '<article class="brief-document">'+renderMarkdown(design)+(contract?'<details class="brief-contract"><summary>通用制作规范</summary>'+renderMarkdown(contract)+'</details>':'')+'</article>';
}

export function versionDocument(version,topicId){
  const previewUrl=`/api/forge/topics/${topicId}/versions/${encodeURIComponent(version.id)}/preview`;
  if(['game','product'].includes(version.kind))return gamePlayer(previewUrl,'历史游戏版本');
  if(['assets','preview'].includes(version.kind))return `<iframe class="assets-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="历史版本预览" src="${previewUrl}"></iframe>`;
  if(version.kind==='brief')return briefDocument(version.content);
  if(version.kind==='expand'){
    let data=version.content;try{if(typeof data==='string')data=JSON.parse(data);}catch{}
    if(data&&typeof data==='object')return '<article class="brief-document">'+[['title','标题'],['logline','一句话'],['twist','新机制'],['core_loop','核心循环'],['controls','操作'],['art_direction','美术'],['progression','节奏'],['audio','音频'],['why_addictive','吸引点'],['risks','风险']].filter(([key])=>data[key]).map(([key,label])=>'<section><h3>'+label+'</h3><p>'+escape(data[key])+'</p></section>').join('')+'</article>';
  }
  return '<article class="brief-document">'+renderMarkdown(typeof version.content==='string'?version.content:JSON.stringify(version.content,null,2))+'</article>';
}
