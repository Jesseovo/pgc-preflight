import {afterEach,describe,expect,it,vi} from 'vitest';
import {modelTransport} from '../server/model';
import {parseJson} from '../server/forge-llm';

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

  it('把 Anthropic 配置转换为 /v1/messages 请求并读取文本块',async()=>{
    const fetchMock=vi.fn(async(_input:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      expect(body.system).toBe('system prompt');
      expect(body.messages[0].content[0]).toEqual({type:'text',text:'user prompt'});
      return Response.json({content:[{type:'text',text:'READY'}]});
    });
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport({baseUrl:'https://riffle.example',model:'claude-opus-5-5',protocol:'anthropic',apiKey:'test-only-api-key'})([
      {role:'system',content:'system prompt'}, {role:'user',content:'user prompt'},
    ])).resolves.toBe('READY');
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://riffle.example/v1/messages',
      expect.objectContaining({redirect:'manual'}),
    ]);
  });

  it('从模型前后说明文字中提取唯一的平衡 JSON',()=>{
    const value = parseJson('说明：先看这个例子 {example}。\n结果：{\"items\":[{\"title\":\"A {B}\"}]}\n完成。');
    expect(value.items[0].title).toBe('A {B}');
  });

  it('空的 Anthropic 流不会再次读取已消费的响应体',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})));
    await expect(modelTransport({baseUrl:'https://riffle.example',model:'claude-opus-5-5',protocol:'anthropic',apiKey:'test-only-api-key'})([
      {role:'user',content:'test'},
    ])).rejects.toThrow('Anthropic Messages');
  });

  it('读取 Anthropic 流式文本，并带上幂等键',async()=>{
    const fetchMock=vi.fn(async(_input:unknown,_init?:RequestInit)=>new Response([
      'event: message_start\n',
      'data: {"type":"message_start"}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"READY"}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),{headers:{'content-type':'text/event-stream'}}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport({baseUrl:'https://riffle.example',model:'claude-opus-5-5',protocol:'anthropic',apiKey:'test-only-api-key'},{idempotencyKey:'expand-42'})([
      {role:'user',content:'test'},
    ])).resolves.toBe('READY');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({'Idempotency-Key':'expand-42','Accept':'text/event-stream'});
  });
});
