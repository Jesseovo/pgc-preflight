import {afterEach,describe,expect,it,vi} from 'vitest';
import {modelTransport} from '../server/model';
import {parseJson} from '../server/forge-llm';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('模型传输',()=>{
  const config={baseUrl:'https://provider.example',model:'vision-model',apiKey:'test-only-api-key'};
  it('模型开始记录在实际请求前完成；记录失败时不发起收费请求',async()=>{
    const order:string[]=[];
    const fetchMock=vi.fn(async()=>{order.push('fetch');return Response.json({choices:[{message:{content:'READY'}}]});});
    vi.stubGlobal('fetch',fetchMock);
    await modelTransport(config,{onStart:async()=>{order.push('charge');}})([]);
    expect(order).toEqual(['charge','fetch']);
    fetchMock.mockClear();
    await expect(modelTransport(config,{onStart:async()=>{throw new Error('fixture-ledger-unavailable');}})([])).rejects.toThrow('fixture-ledger-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it('Opus 制作的 32k 预算不会被传输层截成 24k，其他模型仍保留原上限',async()=>{
    const budgets:number[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{
      budgets.push(JSON.parse(String(init?.body)).max_tokens);
      return Response.json({content:[{type:'text',text:'READY'}],choices:[{message:{content:'READY'}}]});
    }));
    await modelTransport({...config,protocol:'anthropic',model:'claude-opus-5-5'},{maxTokens:32768})([]);
    await modelTransport(config,{maxTokens:32768})([]);
    await modelTransport({...config,protocol:'anthropic',model:'claude-opus-5-5'},{maxTokens:24000})([]);
    expect(budgets).toEqual([32768,24000,24000]);
  });

  it('Opus 支持请求 64k，遵守已保存的思考强度和输出上限',async()=>{
    const bodies:any[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({content:[{type:'text',text:'READY'}],stop_reason:'end_turn'});
    }));
    const opus={...config,protocol:'anthropic' as const,model:'claude-opus-5-5',effort:'medium' as const};
    await modelTransport(opus,{maxTokens:64000,outputEffort:'low'})([]);
    await modelTransport(opus,{maxTokens:100000})([]);
    await modelTransport({...opus,maxOutputTokens:16000},{maxTokens:64000})([]);
    expect(bodies.map(b=>b.max_tokens)).toEqual([64000,64000,16000]);
    expect(bodies[0]).toMatchObject({thinking:{type:'adaptive'},output_config:{effort:'medium'}});
  });

  it('修复尾随逗号时保留字符串里的逗号、括号和转义引号',()=>{
    const copy = 'Use ,} or ,] and "quoted" text';
    const response = `结果：{"items":[{"title":${JSON.stringify(copy)},},]} 完成。`;
    expect(parseJson(response)).toEqual({items:[{title:copy}]});
    expect(()=>parseJson('{"items": [')).toThrow('不是合法 JSON');
  });

  it('空的 Anthropic 流不会再次读取已消费的响应体',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})));
    await expect(modelTransport({baseUrl:'https://riffle.example',model:'claude-opus-5-5',protocol:'anthropic',apiKey:'test-only-api-key'})([
      {role:'user',content:'test'},
    ])).rejects.toThrow('Anthropic Messages');
  });

  it('持续返回思考片段也不能突破任务总时限',async()=>{
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>new Response(new ReadableStream({
      start(controller){
        const timer=setInterval(()=>controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}\n\n')),20_000);
        init?.signal?.addEventListener('abort',()=>{clearInterval(timer);controller.error(new DOMException('aborted','AbortError'));});
      },
    }),{headers:{'content-type':'text/event-stream'}})));
    const response=modelTransport({...config,protocol:'anthropic'},{timeoutMs:30_000,totalTimeoutMs:45_000})([]);
    const check=expect(response).rejects.toThrow('模型响应超时');
    await vi.advanceTimersByTimeAsync(45_000);
    await check;
  });

  it('上游流读取永久挂起时，超时会直接退出并取消读取',async()=>{
    vi.useFakeTimers();
    const cancel=vi.fn(async()=>{});
    const reader={read:vi.fn(()=>new Promise<ReadableStreamReadResult<Uint8Array>>(()=>{})),cancel,releaseLock:vi.fn()};
    vi.stubGlobal('fetch',vi.fn(async()=>({
      status:200,ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:{getReader:()=>reader},
    } as unknown as Response)));
    const response=modelTransport(config,{timeoutMs:100,totalTimeoutMs:1000})([]);
    const check=expect(response).rejects.toThrow('模型响应超时');
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('上游建连永久挂起时，超时会返回错误并完成任务清理',async()=>{
    vi.useFakeTimers();
    const onMetrics=vi.fn(async()=>{});
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(()=>{})));
    const response=modelTransport(config,{timeoutMs:100,totalTimeoutMs:1000,onMetrics})([]);
    const check=expect(response).rejects.toThrow('模型响应超时');
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({status:'error',error:'模型响应超时'}));
  });

  it.each(['openai','anthropic'] as const)('%s 已收到结束标记但网关不断开时，立即返回正文',async(protocol)=>{
    const cancel=vi.fn();
    const payload=protocol==='anthropic'
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"READY"}}\n\ndata: {"type":"message_stop"}\n\n'
      : 'data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({
      start(controller){controller.enqueue(new TextEncoder().encode(payload));},
      cancel,
    }),{headers:{'content-type':'text/event-stream'}})));
    await expect(modelTransport({...config,protocol},{timeoutMs:100})([])).resolves.toBe('READY');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('读取 Anthropic 流式文本，并带上幂等键',async()=>{
    const progress = vi.fn(async (_characters: number) => {});
    const fetchMock=vi.fn(async(_input:unknown,_init?:RequestInit)=>new Response([
      'event: message_start\n',
      'data: {"type":"message_start"}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"READY"}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),{headers:{'content-type':'text/event-stream'}}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport({baseUrl:'https://riffle.example',model:'claude-opus-5-5',protocol:'anthropic',apiKey:'test-only-api-key'},{idempotencyKey:'expand-42',onProgress:progress})([
      {role:'user',content:'test'},
    ])).resolves.toBe('READY');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({'Idempotency-Key':'expand-42','Accept':'text/event-stream'});
    expect(progress).toHaveBeenCalledWith(5);
  });

  it('DeepSeek流式读取思考与正文，只有报告正文返回给调用方',async()=>{
    const fetchMock=vi.fn(async(_input:unknown,init?:RequestInit)=>{
      expect(JSON.parse(String(init?.body))).toMatchObject({stream:true,max_tokens:24000,reasoning_effort:'low',response_format:{type:'json_object'}});
      return new Response([
        ': keep-alive\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"{\\"aes\\":3}"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),{headers:{'Content-Type':'text/event-stream'}});
    });
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport({...config,baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},{maxTokens:24000,json:true,reasoningEffort:'low'})([])).resolves.toBe('{"aes":3}');
  });

  it('OpenAI长度截断不被误报为空内容，也不把思考过程当成报告',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'private reasoning'}}]})));
    await expect(modelTransport(config)([])).rejects.toMatchObject({kind:'truncated'});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:null,reasoning_content:'private reasoning'}}]})));
    await expect(modelTransport(config)([])).rejects.toThrow('没有生成报告正文');
  });

  it('OpenAI流即使包含可解析JSON，缺少正常结束标记也不能当成完整报告',async()=>{
    const stream=(tail:string)=>new Response(`data: {"choices":[{"delta":{"content":"{}"}}]}\n\n${tail}`,{headers:{'Content-Type':'text/event-stream'}});
    vi.stubGlobal('fetch',vi.fn(async()=>stream('')));
    await expect(modelTransport(config)([])).rejects.toMatchObject({kind:'incomplete'});
    vi.stubGlobal('fetch',vi.fn(async()=>stream('data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')));
    await expect(modelTransport(config)([])).rejects.toMatchObject({kind:'truncated'});
  });
});
