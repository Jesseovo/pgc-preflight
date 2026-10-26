# PGC Preflight

## Product contract

- A website for batch preflight checks of single-file HTML games; target domain `pgc.ovoxin.top`.
- The legacy root preflight API checks basic loading, obvious runtime faults, input response, obvious mobile layout defects, and reachable restart flows.
- The current Forge AI simulation review follows the migrated PGC Forge contract: the model scores aesthetics, ease of play and playability from 1–3 each, uses the platform calibration set, and writes evidence-backed fixes. This is a simulation score, not the final human decision.
- All game-review findings and verdicts come from the configured vision model. Code only validates uploads, runs the browser, gathers evidence, executes bounded model actions and validates report format. Never add rule-based game judgments as a fallback.
- A check that could not be verified is `review`, never an automatic pass or failure. If no model is configured, refuse to start review rather than generate a report.
- Do not treat screenshot changes in an animated game as proof that input worked.
- Uploaded HTML is untrusted. Keep it in a separate browser context, restrict navigation and outbound resources, close browsers in finally, and never run it in the app origin.
- `/admin` manages the OpenAI-compatible Chat Completions endpoint, model ID, enabled state and encrypted API key. Never echo keys in responses or logs. Model must support images.
- `/admin` also creates member accounts, resets passwords, enables/disables accounts and grants/revokes `canReview`. `/login` is for members. `/api/check` must validate session and current review permission on the server. Role changes, account disablement and password resets revoke old sessions.
- Opening `/` or `/index.html` without a valid session redirects to `/login` before any workspace renders. An administrator is routed to `/admin`, and a member stays at `/` for AI simulation review; the old root upload view is no longer a user-facing entry. Keep public and member views free of links to `/admin`; the administrator can visit that path directly.
- Visual direction follows Jesseovo's GitHub profile: white surfaces, fine borders, muted sage accents, compact layouts and the original pixel cat. Avoid garden backgrounds and oversized decorative cards. Profile artwork is copied into `public/artwork/`.
- Keep uploads, screenshots and reports ephemeral. Never commit real team game files or internal research data.

## PGC Forge integration

- The full migrated Forge workbench is embedded inside `/admin`; members use AI simulation review directly at `/`. `/forge` is an administrator-only compatibility document for the embed, and `/review` redirects to the appropriate canonical page. Their backend behavior, prompts, weighting, topic library, work library, brief generation and AI simulation review follow `C:\Users\Administrator\Desktop\05 Riffle\pgc-forge`. All Forge model calls use the encrypted model configured once in `/admin`; Forge settings must not expose a second model or API key configuration.
- The legacy root PGC Preflight API remains available only for compatibility. Members only receive the Forge AI simulation review surface; administrators receive the complete Forge workbench.
- The Forge surface uses the existing PGC Preflight visual language: white surfaces, fine borders, muted sage accents, compact layouts and the pixel cat artwork.

## Development

- `npm run dev`: website plus local browser-check API. Requires local Chrome or Edge; set `PGC_CHROME_PATH` if needed.
- `npm run build`: typecheck and production build.
- `npm test`: validation, network policy, and verdict regression tests.
- `npm run test:runtime`: real-browser integration against synthetic fixtures and scripted model responses; does not validate real model accuracy.
- `npm run deploy`: Cloudflare Worker assets, Browser Rendering and D1 settings, custom domain configured in `wrangler.jsonc`. Initialize D1 migrations and `ADMIN_PASSWORD` / `SETTINGS_KEY` secrets before deployment.

GitHub repository: `Jesseovo/pgc-preflight`, private. This is not a 见识星球 Gitea repository.

## Background generation

- Topic expansion and brief generation run through `pgc-forge-jobs`, with consumer concurrency 1 and short HTTP enqueue responses. Keep the D1 lease heartbeat and recoverable error states.
- Long model retries must fit within the Queue consumer lifetime; never reintroduce browser-side cross-tab locks.
