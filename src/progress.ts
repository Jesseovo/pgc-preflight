// The static workbench and Vite entry points use the same runtime and styles.
const moduleUrl = '/forge/progress.js';
export const { startTask, withProgress, progressHtml } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../public/forge/progress.js');
