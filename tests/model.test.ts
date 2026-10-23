import {afterEach,describe,expect,it,vi} from 'vitest';
import {modelTransport} from '../server/model';

afterEach(()=>vi.unstubAllGlobals());

describe('模型传输',()=>{
  const config={baseUrl:'https://provider.example',model:'vision-model',apiKey:'test-only-api-key'};

  it('兼容边缘运行时，读取正常的模型回复',async()=>{
    const fetchMock=vi.fn(async(_input:unknown,init?:RequestInit)=>{
      if(init?.redirect==='error')throw new Error('Unsupported redirect mode');
      return Response.json({choices:[{message:{content:'READY'}}]});
    });
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport(config)([{role:'user',content:'test'}])).resolves.toBe('READY');
  });

  it('拒绝跟随重定向，避免把密钥发到其他地址',async()=>{
    const fetchMock=vi.fn(async()=>new Response(null,{status:307,headers:{Location:'https://other.example'}}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport(config)([])).rejects.toThrow('不会跟随跳转');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://provider.example/chat/completions',
      expect.objectContaining({redirect:'manual'}),
    ]);
  });
});
