import { Fragment, type ReactNode } from 'react';
import { Table } from '../../components/ui';

const heading = /^(#{1,6})\s+(.+)$/;
const item = /^\s*([-*+]|\d+[.)])\s+(.+)$/;
const separator = /^\s*\|?\s*:?-{3,}/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

function inline(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) => part.startsWith('`') && part.endsWith('`')
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}

function Markdown({text}: {text: string}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = index++;
    const section = line.match(heading);
    const firstItem = line.match(item);
    if (!line.trim()) continue;
    if (section) {
      const Tag = section[1].length < 3 ? 'h3' : 'h4';
      blocks.push(<Tag key={key}>{inline(section[2])}</Tag>);
    } else if (/^\s*```/.test(line)) {
      const content: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<pre className="creator-code" key={key}><code>{content.join('\n')}</code></pre>);
    } else if (line.includes('|') && separator.test(lines[index] || '')) {
      const header = cells(line);
      const rows: string[][] = [];
      index++;
      while (index < lines.length && lines[index].includes('|')) rows.push(cells(lines[index++]));
      blocks.push(<Table key={key}><thead><tr>{header.map((value, n) => <th key={n}>{inline(value)}</th>)}</tr></thead><tbody>
        {rows.map((row, n) => <tr key={n}>{row.map((value, cell) => <td key={cell}>{inline(value)}</td>)}</tr>)}
      </tbody></Table>);
    } else if (firstItem) {
      const ordered = /^\d/.test(firstItem[1]);
      const items = [firstItem[2]];
      for (let next = lines[index]?.match(item); next && ordered === /^\d/.test(next[1]); next = lines[index]?.match(item)) {
        items.push(next[2]);
        index++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={key}>{items.map((value, n) => <li key={n}>{inline(value)}</li>)}</List>);
    } else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key}/>);
    } else {
      const paragraph = [line];
      while (lines[index]?.trim() && !heading.test(lines[index]) && !item.test(lines[index]) && !/^\s*```/.test(lines[index]) && !separator.test(lines[index + 1] || '')) paragraph.push(lines[index++]);
      blocks.push(<p key={key}>{paragraph.map((part, n) => <Fragment key={n}>{n > 0 && <br/>}{inline(part)}</Fragment>)}</p>);
    }
  }
  return <article className="creator-document">{blocks}</article>;
}

export function BriefDocument({text}: {text: string}) {
  const designStart = text.search(/^#{1,3}\s+F[.．、\s]/m);
  const design = designStart > 0 ? text.slice(designStart) : text;
  return <><Markdown text={design}/>{designStart > 0 && <details className="creator-disclosure"><summary>通用制作规范</summary><Markdown text={text.slice(0, designStart)}/></details>}</>;
}
