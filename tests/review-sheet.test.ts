import {describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {readXlsxRows,listMembers,sheetToWorks} from '../public/forge/review-sheet.js';
import {forgeApi} from '../server/forge-api';
import {hashPassword,memberLogin} from '../server/members';
import {memberStore} from '../server/storage';

// Builds a minimal xlsx: sheet XML uses shared strings and inline strings;
// one entry is deflated so both zip methods are exercised.
async function makeXlsx(rows:(string|number|null)[][]){
  const shared:string[]=[];
  const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const col=(i:number)=>String.fromCharCode(65+i);
  const sheetRows=rows.map((r,ri)=>`<row r="${ri+1}">${r.map((v,ci)=>{
    if(v==null)return '';
    const ref=`${col(ci)}${ri+1}`;
    if(typeof v==='number')return `<c r="${ref}"><v>${v}</v></c>`;
    if(ci===0)return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    shared.push(v);return `<c r="${ref}" t="s"><v>${shared.length-1}</v></c>`;
  }).join('')}</row>`).join('');
  const files:[string,string,boolean][]=[
    ['xl/workbook.xml','<workbook xmlns:r="r"><sheets><sheet name="版本审核记录" sheetId="1" r:id="rId1"/></sheets></workbook>',false],
    ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',false],
    ['xl/sharedStrings.xml',`<sst>${shared.map((s)=>`<si><t>${esc(s)}</t></si>`).join('')}</sst>`,true],
    ['xl/worksheets/sheet1.xml',`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,false],
  ];
  const enc=new TextEncoder();const parts:Uint8Array<ArrayBuffer>[]=[];const central:Uint8Array<ArrayBuffer>[]=[];let offset=0;
  for(const [name,text,deflate] of files){
    const raw=enc.encode(text);
    const data=deflate?new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()):raw;
    const n=enc.encode(name);
    const local=new DataView(new ArrayBuffer(30));
    local.setUint32(0,0x04034b50,true);local.setUint16(8,deflate?8:0,true);
    local.setUint32(18,data.length,true);local.setUint32(22,raw.length,true);local.setUint16(26,n.length,true);
    const cd=new DataView(new ArrayBuffer(46));
    cd.setUint32(0,0x02014b50,true);cd.setUint16(10,deflate?8:0,true);
    cd.setUint32(20,data.length,true);cd.setUint32(24,raw.length,true);cd.setUint16(28,n.length,true);cd.setUint32(42,offset,true);
    parts.push(new Uint8Array(local.buffer),n,data);central.push(new Uint8Array(cd.buffer),n);
    offset+=30+n.length+data.length;
  }
  const cdSize=central.reduce((s,p)=>s+p.length,0);
  const eocd=new DataView(new ArrayBuffer(22));
  eocd.setUint32(0,0x06054b50,true);eocd.setUint16(8,files.length,true);eocd.setUint16(10,files.length,true);
  eocd.setUint32(12,cdSize,true);eocd.setUint32(16,offset,true);
  return new Blob([...parts,...central,new Uint8Array(eocd.buffer)]).arrayBuffer();
}

const HEADER=['组员','游戏名称','版本','审核阶段','审核结果','美学 / 3','易玩性 / 3','可玩性 / 3','总分 / 9','审核意见（完整）','审核图片链接'];
const SHEET=[
  ['各版本完整审核记录'],
  ['每行是一条审核记录；三项各满分 3 分，总分满分 9 分。'],
  [],
  HEADER,
  ['甲','Alpha',1,'最终审核','退回修改',2,2,2,6,'操作不跟手 & 没有 <BGM>',null],
  ['甲','Alpha',2,'组长初审','初审通过',3,2,2,7,'美术很棒',null],
  ['甲','Alpha',2,'最终审核','审核通过',3,2,3,8,'（无审核意见）',null],
  ['乙','Beta',1,'最终审核','退回修改',2,1,2,5,'太难了',null],
  ['乙','Beta',2,'无审核记录','已撤回',null,null,null,null,null,null],
  ['乙','Gamma',1,'组长初审','初审通过',3,3,2,8,'',null],
] as (string|number|null)[][];

describe('总审核表格导入',()=>{
  it('读出共享字符串、内联字符串、实体和压缩条目',async()=>{
    const rows=await readXlsxRows(await makeXlsx(SHEET));
    expect(rows[3]).toEqual(HEADER);
    expect(rows[4][9]).toBe('操作不跟手 & 没有 <BGM>');
    expect(rows[4][2]).toBe('1');
    expect(listMembers(rows)).toEqual(['甲','乙']);
  });

  it('按游戏合并初审与终审，最新有结论的版本决定状态，姓名不进入结果',async()=>{
    const rows=await readXlsxRows(await makeXlsx(SHEET));
    const works=sheetToWorks(rows,{self:'甲'});
    const by=Object.fromEntries(works.map((w)=>[w.title,w]));
    expect(by.Alpha).toMatchObject({status:'approved',source:'mine',match:'title'});
    expect(by.Alpha.versions[1]).toEqual({r:2,s:'3/2/3',ps:'3/2/2',fb:'',pfb:'美术很棒'});
    expect(by.Beta).toMatchObject({status:'rejected',source:'peer'});
    expect(by.Beta.versions).toHaveLength(2);
    expect(by.Gamma.status).toBe('preapproved');
    expect(JSON.stringify(works)).not.toMatch(/甲|乙/);
    expect(new Set(works.map((w)=>w.id)).size).toBe(3);
  });

  it('找不到表头时给出明确错误',()=>{
    expect(()=>sheetToWorks([['随便'],['一行']])).toThrow('没有找到表头');
  });
});

describe('作品库导入合并',()=>{
  const secrets={ADMIN_PASSWORD:'test-only-admin',SETTINGS_KEY:'test-only-secret'};
  it('表格按标题和来源匹配，保留已有简介和平台 ID，新游戏插入',async()=>{
    const sqlite=new DatabaseSync(':memory:');
    try{
    for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
    const DB:any={prepare(sql:string){let params:any[]=[];const statement:any={bind(...values:any[]){params=values;return statement;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const result=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return statement;},batch:async(statements:any[])=>{sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
    const credentials=await hashPassword('fixture-password');
    sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at) VALUES('creator','creator','Creator',?,?,1,'now','now')").run(credentials.hash,credentials.salt);
    const members=memberStore(DB);
    sqlite.prepare("INSERT INTO games(id,ext_id,title,source,descr,owner_id) VALUES(1,NULL,'Alpha','mine','Keep this description','creator'),(2,'real-pgc-id','Beta','peer','Peer description','creator'),(3,NULL,'Beta','mine','Different source','creator'),(4,'sheet-a','Alpha','mine','Other owner must survive','other')").run();
    const works=[
      {id:'sheet-a',title:'Alpha',desc:'',status:'approved',source:'mine',match:'title',versions:[{r:1,s:'2/2/2',fb:'太简单'},{r:2,s:'3/2/3',ps:'3/2/2',pfb:'美术很棒'}]},
      {id:'sheet-b',title:'Beta',desc:'',status:'rejected',source:'peer',match:'title',versions:[{r:1,s:'2/1/2',fb:'太难了'}]},
      {id:'sheet-c',title:'Gamma',desc:'',status:'preapproved',source:'peer',match:'title',versions:[{r:1,ps:'3/3/2'}]},
    ];
    const token=await memberLogin('creator','fixture-password',members,secrets.SETTINGS_KEY);
    const res=await forgeApi(new Request('https://pgc.example/api/forge/import',{method:'POST',headers:{Cookie:`pgc_member=${token}`,'content-type':'application/json'},body:JSON.stringify({works})}),
      {...secrets,modelStore:{get:async()=>null,set:async()=>{}},DB} as any,['import'],members);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({inserted:1,updated:2});
    expect(sqlite.prepare('SELECT * FROM games WHERE id=1').get()).toMatchObject({ext_id:'sheet-a',descr:'Keep this description',feedback:'太简单 / 美术很棒',score:8,aes:3,ease:2,play:3,owner_id:'creator'});
    expect(sqlite.prepare('SELECT * FROM games WHERE id=2').get()).toMatchObject({ext_id:'real-pgc-id',descr:'Peer description',score:5,aes:2,ease:1,play:2,owner_id:'creator'});
    expect(sqlite.prepare('SELECT * FROM games WHERE id=3').get()).toMatchObject({title:'Beta',source:'mine',descr:'Different source'});
    expect(sqlite.prepare('SELECT * FROM games WHERE id=4').get()).toMatchObject({title:'Alpha',descr:'Other owner must survive',owner_id:'other'});
    expect(sqlite.prepare("SELECT * FROM games WHERE ext_id='sheet-c'").get()).toMatchObject({title:'Gamma',score:8,aes:3,ease:3,play:2,owner_id:'creator',is_public:0});
    }finally{sqlite.close();}
  });
});
