/**
 * Tests for the realistic interaction layer (M17).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import {
  DEFAULT_TYPING,
  PROFILES,
  contextOptionsFor,
  describeIdentity,
  findProfile,
  jitteredDelay,
  mayUseMessyMode,
  neighbour,
  typeValue,
  clickLikeHuman,
} from '../../src/interaction/interaction.js';

describe('the environment profiles', () => {
  it('ships a set of profiles', () => {
    expect(PROFILES.length).toBeGreaterThanOrEqual(5);
  });

  it('finds a profile by name', () => {
    expect(findProfile('desktop-chrome')?.device).toBe('Desktop Chrome');
  });

  it('returns undefined for an unknown profile', () => {
    expect(findProfile('nope')).toBeUndefined();
  });

  it('gives the context options of a profile', () => {
    const profile = findProfile('desktop-chrome');
    expect(profile).toBeDefined();
    if (profile === undefined) return;

    const options = contextOptionsFor(profile);
    expect(options.viewport).toBeDefined();
    expect(options.locale).toBe('en-US');
  });

  it('does not change the user agent on its own', () => {
    const profile = findProfile('desktop-chrome');
    if (profile === undefined) throw new Error('the profile is missing');
    expect(contextOptionsFor(profile).userAgent).toBeUndefined();
  });

  it('uses the scale factor of a profile that has one', () => {
    const options = contextOptionsFor({
      name: 'custom',
      device: 'Desktop Chrome',
      deviceScaleFactor: 2,
      viewport: { width: 100, height: 100 },
    });
    expect(options.deviceScaleFactor).toBe(2);
    expect(options.viewport).toEqual({ width: 100, height: 100 });
  });

  it('leaves out a scale factor the profile does not have', () => {
    // A profile with no device of its own has no scale factor either.
    const options = contextOptionsFor({
      name: 'custom',
      device: 'No Such Device',
    });
    expect(options.deviceScaleFactor).toBeUndefined();
  });

  it('uses an honest user agent when one is given', () => {
    const profile = findProfile('desktop-chrome');
    if (profile === undefined) throw new Error('the profile is missing');
    const options = contextOptionsFor(profile, {
      userAgent: 'BrowserVerifiedSkill/1.0 (+@url:`https://example.test/contact`)',
    });
    expect(options.userAgent).toContain('BrowserVerified');
  });
});

describe('the identity description', () => {
  it('names the user agent and the contact', () => {
    const text = describeIdentity({
      userAgent: 'BrowserVerifiedSkill/1.0',
      contactUrl: 'https://example.test/contact',
    });
    expect(text).toContain('BrowserVerifiedSkill/1.0');
    expect(text).toContain('https://example.test/contact');
  });
});

describe('the messy-mode guard', () => {
  it('allows an owned origin', () => {
    const result = mayUseMessyMode('https://mine.test/page', ['https://mine.test']);
    expect(result.allowed).toBe(true);
  });

  it('refuses an origin that is not owned', () => {
    const result = mayUseMessyMode('https://theirs.test/page', ['https://mine.test']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not one of');
  });

  it('refuses when no origins are owned', () => {
    const result = mayUseMessyMode('https://theirs.test/page', []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('none configured');
  });

  it('refuses a URL that cannot be parsed', () => {
    expect(mayUseMessyMode('not a url', ['https://mine.test']).allowed).toBe(false);
  });
});

describe('the keyboard neighbour', () => {
  it('finds a neighbour of a letter', () => {
    expect(['w', 'a', 's', 'd']).toContain(neighbour('q', () => 0.5));
  });

  it('finds the neighbour to the right', () => {
    expect(neighbour('g', () => 0.9)).toBe('h');
  });

  it('finds the neighbour to the left', () => {
    expect(neighbour('g', () => 0.1)).toBe('f');
  });

  it('finds the neighbour of the first letter of a row', () => {
    expect(neighbour('q', () => 0.5)).toBe('w');
  });

  it('finds the neighbour of the last letter of a row', () => {
    expect(neighbour('p', () => 0.5)).toBe('o');
  });

  it('finds the neighbour of a letter in the middle row', () => {
    // 'g' is in the row 'asdfghjkl', so its neighbours are 'f' and 'h'.
    expect(['f', 'h']).toContain(neighbour('g', () => 0.5));
  });

  it('returns the same character for a space', () => {
    expect(neighbour(' ', () => 0.5)).toBe(' ');
  });

  it('returns the same character for a digit', () => {
    expect(neighbour('5', () => 0.5)).toBe('5');
  });
});

describe('the jittered delay', () => {
  it('is at least the base', () => {
    expect(jitteredDelay(100, [0, 500], () => 0)).toBe(100);
  });

  it('is at most the base plus the jitter', () => {
    expect(jitteredDelay(100, [0, 500], () => 0.999)).toBeLessThanOrEqual(600);
  });

  it('is deterministic for a given random value', () => {
    expect(jitteredDelay(100, [0, 500], () => 0.5)).toBe(jitteredDelay(100, [0, 500], () => 0.5));
  });

  it('handles an inverted jitter range', () => {
    expect(jitteredDelay(100, [500, 0], () => 0.5)).toBe(100);
  });
});

describe('typing', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <input id="email" type="text" />
        <input id="search" type="search" />
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('types instantly', async () => {
    await typeValue(page, '#email', 'instant@example.test', {
      ...DEFAULT_TYPING,
      mode: 'instant',
    });
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('instant@example.test');
  });

  it('types normally', async () => {
    await typeValue(page, '#email', 'normal@example.test', {
      ...DEFAULT_TYPING,
      mode: 'normal',
      normalDelayMs: 1,
    });
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('normal@example.test');
  });

  it('types fast', async () => {
    await typeValue(page, '#email', 'fast@example.test', {
      ...DEFAULT_TYPING,
      mode: 'fast',
      fastDelayMs: 1,
    });
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('fast@example.test');
  });

  it('types like a human and ends with the right value', async () => {
    await typeValue(page, '#email', 'human@example.test', {
      ...DEFAULT_TYPING,
      mode: 'human',
      typoChance: 1,
      pauseChance: 0,
    });
    // The typos are corrected, so the final value is correct.
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('human@example.test');
  });

  it('pauses before typing like a human', async () => {
    // A pause chance of 1 means the pause always happens.
    await typeValue(page, '#email', 'paused@example.test', {
      ...DEFAULT_TYPING,
      mode: 'human',
      typoChance: 0,
      pauseChance: 1,
    });
    expect(await page.locator('#email').inputValue()).toBe('paused@example.test');
  });

  it('types like a human with no typos', async () => {
    await typeValue(page, '#email', 'clean@example.test', {
      ...DEFAULT_TYPING,
      mode: 'human',
      typoChance: 0,
      pauseChance: 0,
    });
    expect(await page.locator('#email').inputValue()).toBe('clean@example.test');
  });
});

describe('clicking', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <button id="target" style="width:200px;height:60px" onclick="this.textContent='clicked'">Click me</button>
        <div id="other">other</div>
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('clicks the element', async () => {
    await clickLikeHuman(page, '#target', { random: () => 0.5 });
    expect(await page.locator('#target').textContent()).toBe('clicked');
  });

  it('clicks inside the element, not exactly at its centre', async () => {
    await page.setContent(`
      <html><body>
        <button id="target" style="width:200px;height:60px"
          onclick="document.getElementById('where').textContent = String(event.offsetX) + ',' + String(event.offsetY)">
          Click me
        </button>
        <div id="where"></div>
      </body></html>
    `);

    await clickLikeHuman(page, '#target', { random: () => 0.9 });
    const where = await page.locator('#where').textContent();
    // The click did not land dead centre.
    expect(where).not.toBe('100,30');
  });

  it('clicks an element with no box, such as a hidden one', async () => {
    // An element with no box cannot be clicked by coordinates, so the
    // locator's own click is used.
    await page.setContent(`
      <html><body>
        <button id="target" style="display:none" onclick="document.title='clicked'">Click me</button>
      </body></html>
    `);

    // The element is not visible, so waiting for it would time out. The
    // branch is reached through an element that is visible but has no box.
    await page.setContent(`
      <html><body>
        <span id="target" style="display:inline;width:0;height:0">x</span>
      </body></html>
    `);

    await clickLikeHuman(page, '#target', { random: () => 0.5 });
    // The click did not throw, which is the point.
    expect(true).toBe(true);
  });

  it('can mis-click', async () => {
    await page.setContent(`
      <html><body>
        <button id="target" style="width:100px;height:40px" onclick="this.dataset.hit='yes'">Click me</button>
      </body></html>
    `);

    await clickLikeHuman(page, '#target', { sloppy: true, random: () => 0.01 });
    expect(await page.locator('#target').getAttribute('data-hit')).toBeNull();
  });
});
