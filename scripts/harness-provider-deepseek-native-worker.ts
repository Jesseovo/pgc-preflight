import { WorkerEntrypoint } from 'cloudflare:workers';
import type { HarnessOutboundScope } from '../server/harness-outbound-scope';
import {
  deepSeekNativeFixture, handleProviderNativeControl, handleProviderNativeOutbound, ProviderNativeRunnerHost, type ProviderNativeEnv,
} from '../server/harness-provider-native';

export default {
  fetch(request: Request, env: ProviderNativeEnv) { return handleProviderNativeControl(request, env, true); },
};

export class ProviderNativeControl extends WorkerEntrypoint<ProviderNativeEnv> {
  fetch(request: Request) { return handleProviderNativeControl(request, this.env); }
}

export class ProviderNativeOutbound extends WorkerEntrypoint<ProviderNativeEnv, HarnessOutboundScope> {
  fetch(request: Request) { return handleProviderNativeOutbound(request, this.env, this.ctx.props, deepSeekNativeFixture); }
}

export class ProviderNativeRunner extends ProviderNativeRunnerHost {
  constructor(ctx: ConstructorParameters<typeof ProviderNativeRunnerHost>[0], env: ProviderNativeEnv) {
    super(ctx, env, deepSeekNativeFixture);
  }
}
