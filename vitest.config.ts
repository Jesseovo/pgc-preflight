import {configDefaults,defineConfig} from 'vitest/config';

// Private research checkouts are evidence, not PGC's executable test suite.
export default defineConfig({test:{exclude:[...configDefaults.exclude,'artifacts/**','dist-ui/**']}});
