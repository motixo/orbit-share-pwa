import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function installationPage({ search = '', hash = '', standalone = false } = {}) {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('const appDisplayMode =');
  const end = source.indexOf("\nif ('serviceWorker'", begin);
  assert.ok(begin > 0 && end > begin);
  const events = new Map();
  const mode = { matches: false, addEventListener(_name, callback) { this.change = callback; } };
  const elements = Object.fromEntries(['installation', 'install', 'install-title', 'install-help', 'welcome', 'share-page'].map(id => [id, {
    hidden: true, textContent: '', addEventListener(_name, callback) { this.click = callback; },
  }]));
  const navigator = { userAgent: 'iPhone', standalone, platform: '', maxTouchPoints: 0 };
  let starts = 0;
  runInNewContext('let installPrompt;\n' + source.slice(begin, end), {
    navigator,
    location: { search, hash },
    URLSearchParams,
    async start() { starts++; },
    matchMedia: () => mode,
    document: {
      getElementById: id => elements[id],
      querySelector: selector => elements[selector.slice(1)],
    },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    statusElement: {},
  });
  return { elements, events, mode, navigator, starts: () => starts };
}

test('installation notice follows launch mode and offers native or manual installation', async () => {
  const { elements, events, mode, navigator } = installationPage();
  assert.equal(elements.installation.hidden, false);
  assert.equal(elements.install.hidden, true);
  assert.equal(elements['install-title'].hidden, false);
  assert.match(elements['install-help'].textContent, /Safari: Share → Add to Home Screen/);

  navigator.standalone = true;
  events.get('pageshow')();
  assert.equal(elements.installation.hidden, true);
  navigator.standalone = false;
  mode.matches = true;
  mode.change();
  assert.equal(elements.installation.hidden, true);
  mode.matches = false;
  navigator.userAgent = 'Android';
  mode.change();
  assert.equal(elements.installation.hidden, false);
  assert.match(elements['install-help'].textContent, /Browser menu \(⋮\) → Install app or Add to Home screen/);
  navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X)';
  mode.change();
  assert.equal(elements['install-help'].textContent, 'Browser menu → Install app.');
  navigator.platform = 'MacIntel';
  navigator.maxTouchPoints = 5;
  mode.change();
  assert.match(elements['install-help'].textContent, /Safari: Share → Add to Home Screen/);

  let prompted = 0;
  let prevented = false;
  events.get('beforeinstallprompt')({
    preventDefault() { prevented = true; },
    async prompt() { prompted++; },
  });
  assert.equal(prevented, true);
  assert.equal(elements.install.hidden, false);
  assert.equal(elements['install-title'].hidden, true);
  assert.equal(elements['install-help'].hidden, true);
  await elements.install.click();
  await elements.install.click();
  assert.equal(prompted, 1);
  assert.equal(elements.install.hidden, true);
  assert.equal(elements['install-title'].hidden, false);
  assert.equal(elements['install-help'].hidden, false);
  events.get('appinstalled')();
  assert.equal(elements.installation.hidden, true);
});

test('browser users choose the share page while installed apps and invitations open it directly', () => {
  for (const [options, sharing] of [
    [{}, false],
    [{ search: '?view=other' }, false],
    [{ search: '?view=share' }, true],
    [{ search: '?preview=1' }, true],
    [{ hash: '#invitation' }, true],
    [{ standalone: true }, true],
  ]) {
    const { elements, starts } = installationPage(options);
    assert.equal(elements.welcome.hidden, sharing);
    assert.equal(elements['share-page'].hidden, !sharing);
    assert.equal(starts(), sharing ? 1 : 0);
  }
});
