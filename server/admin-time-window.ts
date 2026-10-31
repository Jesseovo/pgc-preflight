// Explicit chart windows are UTC instants; callers display them in Beijing time.
export function explicitWindow(params:URLSearchParams):[string,string]|null{
  const from=params.get('from'),to=params.get('to');if(!from&&!to)return null;
  const start=Date.parse(from||''),end=Date.parse(to||'');
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)throw Object.assign(new Error('时间范围需要完整且不超过 31 天。'),{status:400});
  return [new Date(start).toISOString(),new Date(end).toISOString()];
}
