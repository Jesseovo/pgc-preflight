import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ComparisonServiceContext } from '../server/harness-comparison-service';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}));

import worker, { ComparisonCandidateRelay, createComparisonCandidateRelayClient } from '../scripts/harness-comparison-relay-worker';

const time = 1_800_000_000_000;
const version = '231f7591-370d-4f92-8356-87c346f430f6';
const taskId = '101f7591-370d-8f92-8356-87c346f430f6';
const baselineTaskId = '111f7591-370d-8f92-8356-87c346f430f6';
const digest = (ch: string) => ch.repeat(64);
const key = digest('0');
const context = (at: number): ComparisonServiceContext => ({
  runId: 'relay-local-run', authorizationSha256: digest('1'), runnerGrantSha256: digest('2'), dispatchGrantSha256: digest('3'),
  planSha256: digest('4'), manifestSha256: digest('5'), runnerDatabaseId: 'isolated-b', nonceDatabaseId: 'isolated-nonce',
  candidateVersion: version, notBefore: at - 60_000, deadlineAt: at + 600_000, taskIds: [taskId, baselineTaskId],
});
function profileScope(at: number) {
  const frozen = context(at);
  return {
    taskId, slotSha256: digest('6'), admissionSha256: digest('7'), inputSha256: digest('8'), policySha256: digest('9'),
    grantSha256: frozen.runnerGrantSha256, authorizationSha256: frozen.authorizationSha256, dispatchGrantSha256: frozen.dispatchGrantSha256,
    planSha256: frozen.planSha256, manifestSha256: frozen.manifestSha256, runnerDatabaseId: frozen.runnerDatabaseId,
    ownerId: 'admin', operation: 'review' as const, sourceSha256: digest('a'), evidenceSha256: digest('b'),
    modelConfigSha256: digest('c'), modelContractHash: digest('d'), deadlineAt: frozen.deadlineAt,
  };
}
const message = 'Comparison relay unavailable';
let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchTrap = vi.fn(() => { throw new Error('Unexpected global fetch'); });
  vi.stubGlobal('fetch', fetchTrap);
});
afterEach(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('closes the public entrypoint and rejects requests to unapproved private paths', async () => {
  const relay = new ComparisonCandidateRelay({}, {});
  for (const response of [worker.fetch(), await relay.fetch(new Request('https://pgc.ovoxin.top/profile', { method: 'POST' })),
    await relay.fetch(new Request('https://comparison-relay.internal/unknown', { method: 'POST' }))]) {
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  }
  expect(Object.getOwnPropertyNames(ComparisonCandidateRelay.prototype).sort()).toEqual(['constructor', 'fetch']);
});

const localClient = (relay: ComparisonCandidateRelay) => createComparisonCandidateRelayClient(relay);

test.each([undefined, '{', '[]', '{}', JSON.stringify({ ...context(time), taskIds: [taskId, taskId] }),
  JSON.stringify({ ...context(time), target: 'https://arbitrary.invalid/' })])('rejects invalid immutable config before invoking fetch', async json => {
  const relay = new ComparisonCandidateRelay({}, { COMPARISON_SERVICE_CONTEXT: json, COMPARISON_SERVICE_AUTH_KEY: key });
  await expect(localClient(relay).readVerifiedProfile(profileScope(time), version)).rejects.toThrow(message);
});

test('denies missing Secret, mismatched version, arbitrary task and arbitrary target before network', async () => {
  const json = JSON.stringify(context(time));
  const missing = localClient(new ComparisonCandidateRelay({}, { COMPARISON_SERVICE_CONTEXT: json }));
  const relay = localClient(new ComparisonCandidateRelay({}, { COMPARISON_SERVICE_CONTEXT: json, COMPARISON_SERVICE_AUTH_KEY: key }));
  await expect(missing.readVerifiedProfile(profileScope(time), version)).rejects.toThrow(message);
  await expect(relay.readVerifiedProfile(profileScope(time), version.replace(/^2/, '3'))).rejects.toThrow(message);
  await expect(relay.readVerifiedProfile({ ...profileScope(time), taskId: '121f7591-370d-8f92-8356-87c346f430f6' }, version)).rejects.toThrow(message);
  await expect(relay.forwardBaseline({ arm: 'A', taskId: baselineTaskId, ownerId: 'admin', operation: 'review', stage: 'review' },
    'https://arbitrary.invalid/', { method: 'POST', redirect: 'manual', signal: new AbortController().signal, body: '{}' }, version)).rejects.toThrow(message);
});

test('rejects caller-supplied relay settings and oversized metadata before loading secrets or calling fetch', async () => {
  const relay = new ComparisonCandidateRelay({}, { COMPARISON_SERVICE_CONTEXT: JSON.stringify(context(time)), COMPARISON_SERVICE_AUTH_KEY: key });
  for (const metadata of [JSON.stringify({ version, scope: profileScope(time), url: 'https://arbitrary.invalid' }), 'x'.repeat(8193)]) {
    const result = await relay.fetch(new Request('https://comparison-relay.internal/profile', { method: 'POST',
      headers: { 'x-pgc-comparison-relay-scope': metadata } }));
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('');
  }
});

test('uses named Fetcher service binding in workerd with stable flags, forwards cancellation and streams A/B bytes', async () => {
  const at = Date.now(), frozen = context(at);
  const buildOptions = { external: ['cloudflare:workers'], bundle: true, format: 'esm' as const, platform: 'browser' as const,
    target: 'es2022', write: false as const };
  const [relay, candidate] = await Promise.all([
    build({ ...buildOptions, entryPoints: ['scripts/harness-comparison-relay-worker.ts'] }),
    build({ ...buildOptions, stdin: { resolveDir: process.cwd(), contents: `
      import {createComparisonServiceHandler} from './server/harness-comparison-service';
      import {canonicalHarness,harnessHash} from './server/harness-policy';
      let release, called=0, cancelled=0;
      const nonces=new Set();
      const handle=createComparisonServiceHandler({
        context:${JSON.stringify(frozen)}, authKey:${JSON.stringify(key)}, executingVersion:${JSON.stringify(version)},
        nonceDatabase:{scope:'isolated-comparison',id:'isolated-nonce',connection:{prepare(){
          return {bind(_run,nonce){return {async first(){
            if(nonces.has(nonce))return null; nonces.add(nonce);return {nonce};
          }}}};
        }}},
        async handle(call) {
          called++;
          if(call.kind==='profile')return {
            scopeSha256:await harnessHash(canonicalHarness(call.scope)),profileId:'synthetic',
            profile:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',protocol:'openai',enabled:true,vision:true,
              updatedAt:'synthetic',encryptedKey:'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAA='},
          };
          const body=call.kind==='baseline'?call.init.body:await call.request.text();
          if(body!==JSON.stringify({model:'deepseek-flash',stream:true}))throw new Error('Unexpected body');
          return new Response(new ReadableStream({start(controller){
            const encoder=new TextEncoder();
            controller.enqueue(encoder.encode('data: {"delta":"'+call.kind+' 流"}\\r\\n\\r\\n'));
            release=()=>{controller.enqueue(encoder.encode('data: [DONE]\\r\\n\\r\\n'));controller.close()};
          }, cancel(){cancelled++}}),{headers:{'content-type':'text/event-stream'}});
        },
      });
      export default {fetch(request) {
        const url=new URL(request.url);
        if(url.origin==='http://local.test'&&url.pathname==='/release'){release();return new Response(null,{status:204});}
        if(url.origin==='http://local.test'&&url.pathname==='/calls')return Response.json({called,cancelled});
        if(request.headers.get('Cloudflare-Workers-Version-Overrides')!==${JSON.stringify(`pgc-preflight="${version}"`)})
          return new Response(null,{status:412});
        return handle(request);
      }};`,
    } }),
  ]);
  const manifest = (contents: string) => ({ mainModule: 'index.js', modules: { 'index.js': { type: 'esm' as const, contents } } });
  const workerConfig = (name: string, contents: string) => ({ name, compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], manifest: manifest(contents) });
  const caller = await build({ ...buildOptions, stdin: { resolveDir: process.cwd(), contents: `
    import {createComparisonCandidateRelayClient} from './scripts/harness-comparison-relay-worker';
    const version=${JSON.stringify(version)}, taskId=${JSON.stringify(taskId)}, baselineTaskId=${JSON.stringify(baselineTaskId)};
    const profile=${JSON.stringify(profileScope(at))};
    const lease='e'.repeat(64);
    export default {async fetch(request,env) {
      const path=new URL(request.url).pathname;
      try {
        if(path==='/named-fetch')return env.RELAY.fetch(request);
        const client=createComparisonCandidateRelayClient(env.RELAY);
        if(path==='/profile')return Response.json(await client.readVerifiedProfile(profile,version));
        if(path==='/bad-version')return Response.json(await client.readVerifiedProfile(profile,version.replace(/^2/,'3')));
        const controller=new AbortController();
        if(path==='/cancelled')controller.abort();
        const body=JSON.stringify({model:'deepseek-flash',stream:true});
        if(path==='/baseline')return await client.forwardBaseline(
          {arm:'A',taskId:baselineTaskId,ownerId:'admin',operation:'review',stage:'review'},
          'https://api.deepseek.com/chat/completions',{method:'POST',redirect:'manual',signal:controller.signal,body,headers:new Headers({
            accept:'text/event-stream','content-type':'application/json','authorization':'Bearer pgc-comparison-local-placeholder',
            'idempotency-key':'pgc-review-'+baselineTaskId+'-'+'f'.repeat(24),
          })},version);
        const forwarded=await client.forwardHarness(new Request('http://pgc-harness.internal/v1/chat/completions',{
          method:'POST',signal:controller.signal,body,headers:{
            'content-type':'application/json',authorization:'Bearer '+lease,'x-pgc-harness-task':taskId,
            'x-pgc-harness-generation':'synthetic','x-pgc-harness-request-id':'review-0-test',
          },
        }),{taskId,generation:'synthetic',lease,stageDeadlineAt:${at + 60_000},requestIdPrefix:'review-0-',jsonOutput:true,stage:'review'},version);
        if(path!=='/cancel-inflight')return forwarded;
        const reader=forwarded.body.getReader();
        await reader.read();
        controller.abort();
        const aborted=await Promise.race([reader.read().then(result=>result.done,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
        return Response.json(aborted);
      } catch(error){return new Response(error.message,{status:503})}
    }};` } });
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [
    { config: { ...workerConfig('caller', caller.outputFiles[0].text),
      env: { RELAY: { type: 'worker', worker: 'comparison-relay', exportName: 'ComparisonCandidateRelay' } } } },
    { config: { ...workerConfig('comparison-relay', relay.outputFiles[0].text), env: {
      COMPARISON_SERVICE_CONTEXT: { type: 'text', value: JSON.stringify(frozen) },
      COMPARISON_SERVICE_AUTH_KEY: { type: 'text', value: key },
    } }, dev: { outboundService: { type: 'worker', worker: 'candidate' } } },
    { config: workerConfig('candidate', candidate.outputFiles[0].text) },
  ] });
  try {
    // Miniflare's Worker proxy has fetch at runtime. Its mapped Workers type
    // for this installed release currently resolves to Request.
    type LocalFetcher = { fetch(url: string): Promise<Response> };
    const relayFetch = await runtime.getWorker('comparison-relay') as unknown as LocalFetcher;
    const candidateFetch = await runtime.getWorker('candidate') as unknown as LocalFetcher;
    const request = (path: string) => runtime.dispatchFetch('http://local.test' + path);
    expect((await relayFetch.fetch('http://local.test/anything')).status).toBe(403);
    expect((await request('/named-fetch')).status).toBe(403);
    expect(await (await request('/bad-version')).text()).toBe(message);
    expect(await (await request('/cancelled')).text()).toBe(message);
    expect(await (await candidateFetch.fetch('http://local.test/calls')).json()).toEqual({ called: 0, cancelled: 0 });
    const profile = await (await request('/profile')).json();
    expect(profile).toMatchObject({ candidateVersion: version, profileId: 'synthetic' });
    expect(JSON.stringify(profile)).not.toContain(key);
    for (const [path, kind] of [['/forward', 'forward'], ['/baseline', 'baseline']]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-pgc-comparison-broker-version')).toBe(version);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toBe(`data: {"delta":"${kind} 流"}\r\n\r\n`);
      expect((await candidateFetch.fetch('http://local.test/release')).status).toBe(204);
      expect(decoder.decode((await reader.read()).value)).toBe('data: [DONE]\r\n\r\n');
      expect((await reader.read()).done).toBe(true);
    }
    expect(await (await request('/cancel-inflight')).json()).toBe(true);
    expect(await (await candidateFetch.fetch('http://local.test/calls')).json()).toEqual({ called: 4, cancelled: 1 });
  } finally { await runtime.dispose(); }
}, 15_000);
