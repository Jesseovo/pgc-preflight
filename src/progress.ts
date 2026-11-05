// The static workbench and Vite entry points use the same runtime and styles.
const moduleUrl = new URL('/forge/progress.js', location.origin).href;
export const { startTask, withProgress, progressHtml, progressState, elapsed } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../public/forge/progress.js');
