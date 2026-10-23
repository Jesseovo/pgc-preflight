import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

export function findChrome(): string | undefined {
  return [process.env.PGC_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path): path is string => !!path && existsSync(path));
}
export async function launchLocalBrowser() {
  const executablePath = findChrome();
  if (!executablePath) throw new Error('未找到 Chrome 或 Edge，请设置 PGC_CHROME_PATH。');
  return puppeteer.launch({ executablePath, headless: true, args: ['--disable-extensions', '--disable-sync', '--mute-audio'] });
}
