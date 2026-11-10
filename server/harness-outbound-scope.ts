export interface HarnessOutboundScope {
  taskId: string;
  generation: string;
  lease: string;
}

export function scopeHarnessOutbound(request: Request, scope: HarnessOutboundScope): Request | null {
  const url = new URL(request.url);
  if (url.origin !== 'http://pgc-harness.internal' || url.search || request.method !== 'POST' ||
      !['/v1/messages', '/v1/chat/completions', '/v1/tools'].includes(url.pathname) ||
      !scope?.taskId || !scope.generation || !scope.lease) return null;
  const headers = new Headers(request.headers);
  const identity = {
    Authorization: `Bearer ${scope.lease}`,
    'x-pgc-harness-task': scope.taskId,
    'x-pgc-harness-generation': scope.generation,
  };
  for (const [name, value] of Object.entries(identity)) {
    if (headers.has(name) && headers.get(name) !== value) return null;
    headers.set(name, value);
  }
  if (headers.has('x-api-key') && headers.get('x-api-key') !== scope.lease) return null;
  headers.delete('x-api-key');
  return new Request(request, { headers });
}
