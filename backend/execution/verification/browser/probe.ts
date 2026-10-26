// Fixed host-authored diagnostics, run in the task sandbox without provider state.
// The detected Playwright dependency loads only inside that sandbox. No project
// test or installer is started. Fixture success is capability evidence.
export const browserEnvironmentProbe = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir, tmpdir } = require('node:os');
const { Resolver } = require('node:dns/promises');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');
const deadline = setTimeout(() => { process.stderr.write('Browser environment probe exceeded its 20-second deadline.'); process.exit(2); }, 20000);
const describe = (error) => String(error && error.message || error).slice(0, 6000);
(async () => {
  const result = {
    checked_at: new Date().toISOString(), environment: process.argv[1] || 'isolated',
    packages: [], browsers: [],
    dns: { outcome: 'unavailable', detail: 'Registry resolution was not checked.' },
    socket: { outcome: 'unavailable', detail: 'Listening socket was not checked.' },
    direct_file: { outcome: 'unavailable', detail: 'No usable Playwright package and browser executable were found.' },
    http: { outcome: 'unavailable', detail: 'HTTP browser loading was not executed.' },
    note: 'Observed capabilities of the manual task sandbox only. Provider-internal tool restrictions can differ. This fixed fixture does not verify the application or resolve any required check.'
  };
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try { result.packages.push({ name, path: require.resolve(name + '/package.json', { paths: [process.cwd()] }) }); } catch {}
  }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'];
  for (const entry of await fs.readdir(cache).catch(() => [])) {
    if (/^chromium-\d+$/.test(entry)) candidates.push(join(cache, entry, 'chrome-linux64', 'chrome'), join(cache, entry, 'chrome-linux', 'chrome'));
    if (/^chromium_headless_shell-\d+$/.test(entry)) candidates.push(join(cache, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(cache, entry, 'chrome-linux', 'headless_shell'));
  }
  for (const path of candidates) {
    try { await fs.access(path, constants.X_OK); const canonical = await fs.realpath(path); if (!result.browsers.includes(canonical)) result.browsers.push(canonical); } catch {}
  }
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  try { await resolver.resolve4('registry.npmjs.org'); result.dns = { outcome: 'available', detail: 'Resolved registry.npmjs.org in this task sandbox.' }; }
  catch (error) { result.dns = { outcome: 'blocked', detail: describe(error) }; }
  finally { resolver.cancel(); }
  const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Vibestar HTTP probe</title><p>Vibestar browser probe</p>'); });
  let browser;
  let temporary;
  try {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      result.socket = { outcome: 'available', detail: 'Created and closed an ephemeral listening socket on 127.0.0.1.' };
    } catch (error) { result.socket = { outcome: 'blocked', detail: describe(error) }; }
    if (result.packages.length && result.browsers.length) {
      try {
        const playwright = require(dirname(result.packages[0].path));
        if (!playwright.chromium || typeof playwright.chromium.launch !== 'function') throw Error('Installed package does not expose Chromium launch.');
        browser = await playwright.chromium.launch({ executablePath: result.browsers[0], headless: true, timeout: 8000, args: ['--disable-dev-shm-usage'] });
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await page.route('**/*', (route) => { const url = new URL(route.request().url()); return ['file:', 'data:', 'about:'].includes(url.protocol) || (url.protocol === 'http:' && url.hostname === '127.0.0.1') ? route.continue() : route.abort(); });
        temporary = await fs.mkdtemp(join(tmpdir(), 'vibestar-browser-probe-'));
        const file = join(temporary, 'index.html');
        await fs.writeFile(file, '<!doctype html><title>Vibestar direct file probe</title><p>Vibestar browser probe</p>');
        await page.goto(pathToFileURL(file).href, { timeout: 3000 });
        if (await page.title() !== 'Vibestar direct file probe') throw Error('Direct-file fixture did not load.');
        result.direct_file = { outcome: 'available', detail: 'Launched the detected browser and loaded the fixed local HTML fixture.' };
        if (server.listening) {
          try {
            await page.goto('http://127.0.0.1:' + server.address().port, { timeout: 3000 });
            if (await page.title() !== 'Vibestar HTTP probe') throw Error('HTTP fixture did not load.');
            result.http = { outcome: 'available', detail: 'Loaded the fixed loopback HTTP fixture in the detected browser.' };
          } catch (error) { result.http = { outcome: 'blocked', detail: describe(error) }; }
        } else result.http = { outcome: 'blocked', detail: 'HTTP checks require a listening socket; direct-file capability is independent.' };
      } catch (error) { result.direct_file = { outcome: 'blocked', detail: describe(error) }; }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(result));
})().catch((error) => { process.stderr.write(describe(error)); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
`;
