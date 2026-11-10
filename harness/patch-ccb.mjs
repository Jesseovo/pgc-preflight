import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const pinned = '963e0013184ecc1521289a0fc7d5da4bb6e45356';
const source = resolve(process.argv[2] || '.');
const [archiveFlag, archive] = process.argv.slice(3);
if (archiveFlag === '--archive' && archive) {
  const pinnedArchive = '32281979fbca055752582e6f62015ddb2754dba0097cd4d2bf2d7712d61b4ebb';
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== pinnedArchive) throw new Error('Unexpected CCB source archive checksum');
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
} else {
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (head !== pinned || dirty) throw new Error('CCB build requires the clean pinned checkout');
}

function replace(path, previous, next) {
  const target = resolve(source, path);
  const original = readFileSync(target, 'utf8');
  if (original.split(previous).length !== 2) throw new Error(`Unexpected pinned CCB source: ${path}`);
  writeFileSync(target, original.replace(previous, () => next));
}

// Keep CCB's headless query loop and protocol adapters. Compile optional remote,
// background, plugin-adjacent and persistent-session features out of the build.
replace('build.ts', 'const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]', 'const features: string[] = []');
replace('build.ts', "  sourcemap: 'linked',\n", '');

// Tag only foreground streamed model operations, once per logical CCB turn.
// The loopback bridge refuses to forward all auxiliary and duplicate requests.
replace('src/services/api/claude.ts', `              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),`, `              headers: {
                ...(clientRequestId && { [CLIENT_REQUEST_ID_HEADER]: clientRequestId }),
                ...(options.querySource === 'sdk' && {
                  'x-pgc-ccb-turn': randomUUID(),
                }),
              },`);
replace('src/services/api/openai/index.ts', '            { signal },', `            {
              signal,
              ...(options.querySource === 'sdk' && {
                headers: { 'x-pgc-ccb-turn': randomUUID() },
              }),
            },`);
replace('src/services/api/withRetry.ts', '      lastError = error\n      logForDebugging(', `      if (process.env.PGC_CCB_HARNESS === '1') {
        throw new CannotRetryError(error, retryContext)
      }
      lastError = error
      logForDebugging(`);
replace('src/services/api/claude.ts', '      !didFallBackToNonStreaming &&\n      errorFromRetry instanceof CannotRetryError', `      process.env.PGC_CCB_HARNESS !== '1' &&
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError`);
replace('src/query.ts', '      if (isWithheldMaxOutputTokens(lastMessage)) {', `      if (process.env.PGC_CCB_HARNESS === '1' && isWithheldMaxOutputTokens(lastMessage)) {
        yield lastMessage!
        return { reason: 'model_error', error: 'max_output_tokens' }
      }
      if (isWithheldMaxOutputTokens(lastMessage)) {`);
// The headless workspace exposes no ripgrep, audio, browser or shell tools.
// Skip optional native assets and upstream postinstall downloads.
replace('build.ts', `const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(\`Copied vendor/audio-capture/ → \${audioCaptureDir}/\`)

const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true })
console.log(\`Copied src/utils/vendor/ripgrep/ → \${ripgrepDir}/\`)`, '');
// The container uses its own empty settings and no host managed configuration.
replace('src/utils/settings/mdm/rawRead.ts', '  return (async (): Promise<RawReadResult> => {', `  if (process.env.PGC_CCB_HARNESS === '1') {
    return Promise.resolve({ plistStdouts: null, hklmStdout: null, hkcuStdout: null })
  }
  return (async (): Promise<RawReadResult> => {`);
replace('src/main.tsx', 'startKeychainPrefetch();', "if (process.env.PGC_CCB_HARNESS !== '1') startKeychainPrefetch();");
replace('src/main.tsx', '        initBuiltinPlugins();\n        initBundledSkills();', `        if (process.env.PGC_CCB_HARNESS !== '1') {
          initBuiltinPlugins();
          initBundledSkills();
        }`);
replace('src/utils/errorLogSink.ts', 'export function initializeErrorLogSink(): void {', `export function initializeErrorLogSink(): void {
  if (process.env.PGC_CCB_HARNESS === '1') {
    attachErrorLogSink({
      logError() {}, logMCPError() {}, logMCPDebug() {}, getErrorsPath, getMCPLogsPath,
    })
    return
  }`);
// The Node permission profile denies all subprocesses. Skip the CLI's shell
// sandbox capability probe, which invokes "which" even when shell tools are absent.
replace('src/utils/sandbox/sandbox-adapter.ts', 'function isSandboxingEnabled(): boolean {', `function isSandboxingEnabled(): boolean {
  if (process.env.PGC_CCB_HARNESS === '1') return false`);
// PGC's original locked images must reach the provider unchanged.
replace('src/utils/processUserInput/processUserInput.ts',
  "      if (block.type === 'image') {\n        const resized = await maybeResizeAndDownsampleImageBlock(block)",
  `      if (block.type === 'image' && process.env.PGC_CCB_HARNESS !== '1') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)`);
replace('src/services/mcp/client.ts', "    case 'image': {\n      // Resize and compress image data, enforcing API dimension limits", `    case 'image': {
      if (process.env.PGC_CCB_HARNESS === '1' && serverName === 'pgc_workspace') {
        return [{
          type: 'image',
          source: {
            type: 'base64',
            data: String(resultContent.data),
            media_type: resultContent.mimeType as Base64ImageSource['media_type'],
          },
        }]
      }
      // Resize and compress image data, enforcing API dimension limits`);
replace('packages/@ant/model-provider/src/shared/openaiConvertMessages.ts',
  '      result.push(convertToolResult(tr))', `      result.push(convertToolResult(tr))
      if (process.env.PGC_CCB_HARNESS === '1' && Array.isArray(tr.content)) {
        for (const block of tr.content) {
          if (typeof block !== 'object' || block?.type !== 'image') continue
          const imagePart = convertImageBlockToOpenAI(block as unknown as Record<string, unknown>)
          if (imagePart) imageParts.push(imagePart)
        }
      }`);
replace('src/query.ts', '      config.gates.emitToolUseSummaries &&', `      process.env.PGC_CCB_HARNESS !== '1' &&
      config.gates.emitToolUseSummaries &&`);
replace('src/services/mcp/client.ts', "  if (name === 'ide') {\n    return content", `  if (name === 'ide' || (process.env.PGC_CCB_HARNESS === '1' && name === 'pgc_workspace')) {
    return content`);

replace('src/services/compact/microCompact.ts', '  // Clear suppression flag at start of new microcompact attempt', `  if (process.env.PGC_CCB_HARNESS === '1') return { messages }

  // Clear suppression flag at start of new microcompact attempt`);
