import {describe,it,expect,vi,afterEach} from 'vitest';
import {createReadCache,createTaskReader} from '../public/forge/experience.js';
describe('session metadata cache',()=>{
  it('deduplicates concurrent reads and returns isolated values',async()=>{
    const cache=createReadCache(),load=vi.fn(async()=>({items:[1]}));
    const [a,b]:any[]=await Promise.all([cache.read('a',load),cache.read('a',load)]);
    a.items.push(2);expect(b.items).toEqual([1]);expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.read('a',load)).toEqual({items:[1]});
  });
  it('aborting one view does not cancel another view of the same request',async()=>{
    const cache=createReadCache(),abort=new AbortController();let finish!:(v:any)=>void;
    const load=()=>new Promise(resolve=>{finish=resolve;});
    const a=cache.read('a',load,{signal:abort.signal}),b=cache.read('a',load);
    const rejected=expect(a).rejects.toMatchObject({name:'AbortError'});
    await Promise.resolve();abort.abort();finish({ok:true});await rejected;expect(await b).toEqual({ok:true});
  });
  it('logout or mutation invalidation prevents an old response repopulating the cache',async()=>{
    const cache=createReadCache();let finish!:(v:any)=>void;
    const old=cache.read('a',()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();cache.clear();
    await cache.read('a',async()=>({revision:2}));finish({revision:1});await old;
    expect(await cache.read('a',async()=>({revision:3}))).toEqual({revision:2});
  });
  it('does not cache failures and evicts bounded old entries',async()=>{
    const cache=createReadCache({capacity:2});await expect(cache.read('bad',async()=>{throw Error('offline');})).rejects.toThrow('offline');
    expect(cache.size).toBe(0);for(const key of ['a','b','c'])await cache.read(key,async()=>key);expect(cache.size).toBe(2);
    const load=vi.fn(async()=>4);expect(await cache.read('a',load)).toBe(4);expect(load).toHaveBeenCalledTimes(1);
  });
});
describe('shared creation status reader',()=>{
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
  function setup(){vi.useFakeTimers();const doc=Object.assign(new EventTarget(),{hidden:false});vi.stubGlobal('document',doc);return doc;}
  it('batches simultaneous tasks, waits between polls, and pauses while hidden',async()=>{
    const doc=setup(),batch=vi.fn(async()=>[{id:'a',executor:'platform'},{id:'b',executor:'platform'}]),single=vi.fn();
    const reader=createTaskReader(batch,single),first=[reader.read('a'),reader.read('b')];
    await vi.advanceTimersByTimeAsync(0);await Promise.all(first);expect(batch).toHaveBeenCalledTimes(1);expect(single).not.toHaveBeenCalled();
    const second=reader.read('a');await vi.advanceTimersByTimeAsync(9999);expect(batch).toHaveBeenCalledTimes(1);
    doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(60000);expect(batch).toHaveBeenCalledTimes(1);
    doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);await second;expect(batch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120000);expect(batch).toHaveBeenCalledTimes(2);
  });
  it('observes Agent tasks every sixty seconds and backs off failed batches',async()=>{
    setup();const batch=vi.fn().mockResolvedValueOnce([{id:'a',executor:'agent'}]).mockRejectedValueOnce(Error('offline')).mockResolvedValue([{id:'a',executor:'agent'}]);
    const reader=createTaskReader(batch,vi.fn()),first=reader.read('a');await vi.advanceTimersByTimeAsync(0);await first;
    const second=reader.read('a'),rejected=expect(second).rejects.toThrow('offline');await vi.advanceTimersByTimeAsync(59999);expect(batch).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);await rejected;
    const third=reader.read('a');await vi.advanceTimersByTimeAsync(59999);expect(batch).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);await third;expect(batch).toHaveBeenCalledTimes(3);
  });
  it('a newly submitted platform task does not wait behind an Agent interval',async()=>{
    setup();const batch=vi.fn(async()=>[{id:'agent',executor:'agent'},{id:'platform',executor:'platform'}]);
    const reader=createTaskReader(batch,vi.fn());batch.mockResolvedValueOnce([{id:'agent',executor:'agent'}]);
    const first=reader.read('agent');await vi.advanceTimersByTimeAsync(0);await first;
    const next=[reader.read('agent'),reader.read('platform')];await vi.advanceTimersByTimeAsync(0);await Promise.all(next);expect(batch).toHaveBeenCalledTimes(2);
  });
});
