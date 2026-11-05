declare module 'cloudflare:workers' {
  export class WorkerEntrypoint<Env=unknown,Props=unknown> {
    protected env:Env;
    protected ctx:{props:Props;waitUntil(p:Promise<unknown>):void};
    constructor(ctx:any,env:Env);
  }
}
