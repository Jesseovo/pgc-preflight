import { WorkerEntrypoint } from 'cloudflare:workers';
import type { HarnessOutboundScope } from '../server/harness-outbound-scope';
import {
  handleProviderNativeControl, handleProviderNativeOutbound, ProviderNativeRunnerHost, type ProviderNativeEnv,
} from '../server/harness-provider-native';

// The default entry is closed unless the isolated Worker origin is explicitly
// configured. Only the separately signed control surface can then answer.
export default {
  fetch(request: Request, env: ProviderNativeEnv) { return handleProviderNativeControl(request, env, true); },
};

export class ProviderNativeControl extends WorkerEntrypoint<ProviderNativeEnv> {
  fetch(request: Request) { return handleProviderNativeControl(request, this.env); }
}

export class ProviderNativeOutbound extends WorkerEntrypoint<ProviderNativeEnv, HarnessOutboundScope> {
  fetch(request: Request) { return handleProviderNativeOutbound(request, this.env, this.ctx.props); }
}

export class ProviderNativeRunner extends ProviderNativeRunnerHost {}
