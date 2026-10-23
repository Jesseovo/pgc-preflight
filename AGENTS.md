# PGC Preflight

## Product contract

- A website for batch preflight checks of single-file HTML games; target domain `pgc.ovoxin.top`.
- Only check basic loading, obvious runtime faults, input response, obvious mobile layout defects, and reachable restart flows.
- Never score aesthetics, control feel, fun, balance, originality, or platform acceptance. Human reviewers own these judgments.
- All game-review findings and verdicts come from the configured vision model. Code only validates uploads, runs the browser, gathers evidence, executes bounded model actions and validates report format. Never add rule-based game judgments as a fallback.
- A check that could not be verified is `review`, never an automatic pass or failure. If no model is configured, refuse to start review rather than generate a report.
- Do not treat screenshot changes in an animated game as proof that input worked.
- Uploaded HTML is untrusted. Keep it in a separate browser context, restrict navigation and outbound resources, close browsers in finally, and never run it in the app origin.
- `/admin` manages the OpenAI-compatible Chat Completions endpoint, model ID, enabled state and encrypted API key. Never echo keys in responses or logs. Model must support images.
- `/admin` also creates member accounts, resets passwords, enables/disables accounts and grants/revokes `canReview`. `/login` is for members. `/api/check` must validate session and current review permission on the server. Role changes, account disablement and password resets revoke old sessions.
- Opening `/` or `/index.html` without a valid session redirects to `/login` before the workspace renders. Keep public and member views free of links to `/admin`; the administrator can visit that path directly.
- Visual direction follows Jesseovo's GitHub profile: white surfaces, fine borders, muted sage accents, compact layouts and the original pixel cat. Avoid garden backgrounds and oversized decorative cards. Profile artwork is copied into `public/artwork/`.
- Keep uploads, screenshots and reports ephemeral. Never commit real team game files or internal research data.

## Development

- `npm run dev`: website plus local browser-check API. Requires local Chrome or Edge; set `PGC_CHROME_PATH` if needed.
- `npm run build`: typecheck and production build.
- `npm test`: validation, network policy, and verdict regression tests.
- `npm run test:runtime`: real-browser integration against synthetic fixtures and scripted model responses; does not validate real model accuracy.
- `npm run deploy`: Cloudflare Worker assets, Browser Rendering and D1 settings, custom domain configured in `wrangler.jsonc`. Initialize D1 migrations and `ADMIN_PASSWORD` / `SETTINGS_KEY` secrets before deployment.

GitHub repository: `Jesseovo/pgc-preflight`, private. This is not a 见识星球 Gitea repository.
