import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function installationPage({ search = '', hash = '', standalone = false, userAgent = 'iPhone Version/18.0 Safari/604.1', platform = '', maxTouchPoints = 0 } = {}) {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('const appDisplayMode =');
  const end = source.indexOf("\nif ('serviceWorker'", begin);
  assert.ok(begin > 0 && end > begin);
  const events = new Map();
  const mode = { matches: false, addEventListener(_name, callback) { this.change = callback; } };
  const elements = Object.fromEntries(['installation', 'install', 'install-title', 'install-help', 'welcome', 'share-page'].map(id => [id, {
    hidden: true, textContent: '', addEventListener(_name, callback) { this.click = callback; },
  }]));
  const navigator = { userAgent, standalone, platform, maxTouchPoints };
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
  mode.change();
  assert.equal(elements.installation.hidden, false);

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

test('installation steps match the browser and device instead of their shared Safari user-agent token', () => {
  const cases = [
    [{ userAgent: 'iPhone Version/18.0 Safari/604.1' }, 'Safari: Share → Add to Home Screen → Add.'],
    [{ userAgent: 'iPhone CriOS/150.0 Safari/604.1' }, 'Chrome: Share → Add to Home Screen → Add.'],
    [{ userAgent: 'iPhone FxiOS/150.0 Safari/605.1' }, 'Open in Safari → Share → Add to Home Screen → Add.'],
    [{ userAgent: 'Macintosh Version/18.0 Safari/605.1', platform: 'MacIntel', maxTouchPoints: 5 }, 'Safari: Share → Add to Home Screen → Add.'],
    [{ userAgent: 'Android 15 Chrome/150.0 Safari/537.36' }, 'Chrome: ⋮ → Install and create shortcut → Install.'],
    [{ userAgent: 'Android 15 Firefox/150.0' }, 'Firefox: ⋮ → Install → Add automatically.'],
    [{ userAgent: 'Linux Chrome/150.0 Safari/537.36' }, 'Chrome: ⋮ → Cast, save, and share → Install page as app…'],
    [{ userAgent: 'Macintosh Version/18.0 Safari/605.1' }, 'Safari: File → Add to Dock → Add.'],
    [{ userAgent: 'Windows NT 10.0 Firefox/150.0' }, 'Firefox: Address bar → Add tab to taskbar.'],
    [{ userAgent: 'Linux Firefox/150.0' }, 'Open in Chrome → ⋮ → Cast, save, and share → Install page as app…'],
    [{ userAgent: 'Macintosh Firefox/150.0' }, 'Open in Safari → File → Add to Dock → Add.'],
    [{ userAgent: 'Android Chrome/150.0 SamsungBrowser/30.0 Safari/537.36' }, 'Open in Chrome → ⋮ → Install and create shortcut → Install.'],
  ];
  for (const [options, expected] of cases) {
    const { elements } = installationPage(options);
    assert.equal(elements['install-help'].textContent, expected, options.userAgent);
  }
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
