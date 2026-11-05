import {describe,expect,it} from 'vitest';
import {parseProductionOutput} from '../server/forge-production-output';
import {validateCreationOutput} from '../server/forge-creation-pipeline';

const html='<!doctype html>\n<html><script>const data = {}; const pattern = /\\d+/; const copy = "quoted";\nconst s = `line\\nvalue`;</script></html>';
const record={requirements:[{id:'R1',text:'Play',status:'implemented'}],decisions:[],coreChanges:[]};
const frame=(source=html,metadata=JSON.stringify(record))=>`<PGC_HTML>\n${source}\n</PGC_HTML>\n<PGC_RECORD>\n${metadata}\n</PGC_RECORD>`;

describe('platform production framing',()=>{
  it('preserves raw HTML and exact metadata without JSON string escaping',()=>{
    const result=parseProductionOutput(frame());
    expect(result).toEqual({html,...record});
    expect(validateCreationOutput(result,'build')).toEqual([]);
    expect(result.html).not.toContain('PGC_RECORD');
  });
  it('rejects incomplete, duplicate and embedded delimiters instead of extracting partial artifacts',()=>{
    for(const value of [html,frame().slice(0,-5),frame()+'\n'+frame(),'Explanation\n'+frame(),frame(html+'<!-- <PGC_RECORD> -->')]){
      expect(()=>parseProductionOutput(value)).toThrow('完整且唯一');
    }
  });
  it('rejects malformed or conflicting metadata and never fills missing fields',()=>{
    expect(()=>parseProductionOutput(frame(html,'{ "requirements": [ }'))).toThrow('不是合法 JSON');
    expect(()=>parseProductionOutput(frame(html,JSON.stringify({...record,html:'replacement'})))).toThrow('不能重复声明');
    const partial=parseProductionOutput(frame(html,'{}'));
    expect(partial).toEqual({html});
    expect(validateCreationOutput(partial,'build')).toContain('requirements');
  });
});
