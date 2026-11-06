import { fetchResearchCandidate as fetchConfiguredResearchCandidate } from './harness-provider-candidate-entry';
import { deepSeekResearchFixtureManifest } from '../server/harness-provider-deepseek-fixture';

// This separately packaged research entry has exactly one fixture. Neither
// the incoming request nor the production configuration can select another.
type CandidateParameters = Parameters<typeof fetchConfiguredResearchCandidate>;

export function fetchResearchCandidate(request: Request, env: CandidateParameters[1], ctx: CandidateParameters[2]) {
  return fetchConfiguredResearchCandidate(request, env, ctx, deepSeekResearchFixtureManifest);
}
