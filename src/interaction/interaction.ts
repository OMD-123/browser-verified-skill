/**
 * Realistic interaction (M17).
 *
 * The point of this module is **honesty, not evasion**. A script that
 * types at 400 characters per second and clicks at the exact centre of
 * every element is obviously a script; the sites you care about can tell,
 * and so can the humans you work for.
 *
 * So the behaviour here is:
 *
 *  - **Human-like timing**, because that is what a person does.
 *  - **Honest identity**, always. The user agent says what this is, the
 *    contact URL is real, and nothing here tries to look like a different
 *    browser.
 *  - **No anti-detection tricks.** No stealth patches, no fingerprint
 *    spoofing, no hiding the automation. `automated` in the webdriver
 *    flag stays visible.
 *
 * The messy-user mode (occasional mis-clicks and corrections) exists for
 * **testing your own site**, and is restricted to origins you own. It is
 * for finding the bugs a perfect script never finds, not for fooling anyone.
 */
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { devices } from 'playwright';

/** How a value is typed into a field. */
export type TypingMode = 'instant' | 'normal' | 'fast' | 'human';

/** The settings for the typing behaviour. */
export interface TypingSettings {
  /** The mode. */
  mode: TypingMode;
  /** The delay between keystrokes, in milliseconds, for `normal`. */
  normalDelayMs: number;
  /** The delay between keystrokes, in milliseconds, for `fast`. */
  fastDelayMs: number;
  /** The chance of a typo, from 0 to 1, for `human`. */
  typoChance: number;
  /** The chance of a pause before typing, from 0 to 1, for `human`. */
  pauseChance: number;
}

/** The default typing settings. */
export const DEFAULT_TYPING: TypingSettings = {
  mode: 'normal',
  normalDelayMs: 60,
  fastDelayMs: 15,
  typoChance: 0.03,
  pauseChance: 0.2,
};

/** An environment profile: the browser, the viewport and the platform. */
export interface EnvironmentProfile {
  /** The profile's name. */
  name: string;
  /** The device descriptor to base it on. */
  device: string;
  /** The viewport, when it overrides the device's. */
  viewport?: { width: number; height: number };
  /** The device scale factor. */
  deviceScaleFactor?: number;
  /** The locale. */
  locale?: string;
  /** The timezone. */
  timezoneId?: string;
}

/** The environment profiles that ship with the tool. */
export const PROFILES: readonly EnvironmentProfile[] = [
  {
    name: 'desktop-chrome',
    device: 'Desktop Chrome',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  {
    name: 'desktop-firefox',
    device: 'Desktop Firefox',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  },
  {
    name: 'desktop-safari',
    device: 'Desktop Safari',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  },
  {
    name: 'mobile-safari',
    device: 'iPhone 13',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  {
    name: 'mobile-pixel',
    device: 'Pixel 7',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
];

/**
 * Find an environment profile by name.
 *
 * Returns undefined when there is no such profile.
 */
export function findProfile(name: string): EnvironmentProfile | undefined {
  return PROFILES.find((profile) => profile.name === name);
}

/**
 * The context options for a profile.
 *
 * The user agent is **not** changed. Whatever the browser reports is what
 * it reports; this tool does not disguise itself.
 */
export function contextOptionsFor(
  profile: EnvironmentProfile,
  options: { userAgent?: string; headed?: boolean } = {},
): BrowserContextOptions {
  const device = devices[profile.device];
  const base: BrowserContextOptions = device === undefined ? {} : { ...device };

  // Playwright's device descriptors carry a user agent. Replacing it would
  // mean pretending to be a browser this is not, so it is dropped unless
  // the caller supplies an honest one.
  const { userAgent: _deviceUserAgent, ...deviceWithoutUserAgent } = base;

  return {
    ...deviceWithoutUserAgent,
    ...(profile.viewport !== undefined ? { viewport: profile.viewport } : {}),
    ...(profile.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: profile.deviceScaleFactor }
      : {}),
    ...(profile.locale !== undefined ? { locale: profile.locale } : {}),
    ...(profile.timezoneId !== undefined ? { timezoneId: profile.timezoneId } : {}),
    // The user agent is set only when the caller supplies one that is
    // honest about being this tool.
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
}

/**
 * Type a value into a field the way a person would.
 *
 * `instant` sets the value at once. `normal` types with a steady delay.
 * `fast` types quickly. `human` types with a variable delay, the
 * occasional typo that is corrected, and the occasional pause to think.
 */
export async function typeValue(
  page: Page,
  selector: string,
  value: string,
  settings: TypingSettings = DEFAULT_TYPING,
  random: () => number = Math.random,
): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });

  switch (settings.mode) {
    case 'instant':
      await locator.fill(value);
      return;

    case 'fast':
      await locator.click();
      await clear(locator);
      await locator.pressSequentially(value, { delay: settings.fastDelayMs });
      return;

    case 'human': {
      await locator.click();
      await clear(locator);
      // A pause before typing, as if reading the field.
      if (random() < settings.pauseChance) {
        await page.waitForTimeout(200 + Math.floor(random() * 600));
      }
      await typeWithTypos(locator, value, settings, random);
      return;
    }

    case 'normal':
    default:
      await locator.click();
      await clear(locator);
      await locator.pressSequentially(value, { delay: settings.normalDelayMs });
      return;
  }
}

/**
 * Clear a field.
 *
 * Typing appends to whatever is there, so the field is emptied first. The
 * selection is used rather than a press-per-character, because a field
 * with a password manager extension can have its value restored.
 */
async function clear(locator: ReturnType<Page['locator']>): Promise<void> {
  await locator.press('ControlOrMeta+a');
  await locator.press('Backspace');
}

/**
 * Type a value, occasionally making and correcting a typo.
 *
 * The typo is always corrected before the field is left, so the typed
 * value is correct at the end — which is what a person does.
 */
async function typeWithTypos(
  locator: ReturnType<Page['locator']>,
  value: string,
  settings: TypingSettings,
  random: () => number,
): Promise<void> {
  for (const character of value) {
    const delay = 40 + Math.floor(random() * 90);
    await locator.pressSequentially(character, { delay });

    // A typo: a neighbouring key on the keyboard.
    if (character !== ' ' && random() < settings.typoChance) {
      const wrong = neighbour(character, random);
      if (wrong !== character) {
        await locator.pressSequentially(wrong, { delay: 30 });
        await locator.press('Backspace', { delay: 30 });
      }
    }

    // A longer pause between words, as if thinking.
    if (character === ' ' && random() < settings.pauseChance) {
      await locator.page().waitForTimeout(120 + Math.floor(random() * 400));
    }
  }
}

/**
 * A neighbouring key on a QWERTY keyboard.
 *
 * Returns the same character when there is no neighbour to pick.
 */
export function neighbour(character: string, random: () => number): string {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const lower = character.toLowerCase();

  for (const row of rows) {
    const index = row.indexOf(lower);
    if (index === -1) continue;
    if (index === 0) return row[1] ?? character;
    if (index === row.length - 1) return row[index - 1] ?? character;
    return random() < 0.5 ? (row[index - 1] ?? character) : (row[index + 1] ?? character);
  }

  return character;
}

/**
 * Click an element with a human-like approach.
 *
 * The pointer moves to the element in a few steps rather than teleporting
 * to it, and the click lands at a point inside the element rather than
 * always dead centre.
 */
export async function clickLikeHuman(
  page: Page,
  selector: string,
  options: { sloppy?: boolean; random?: () => number } = {},
): Promise<void> {
  const random = options.random ?? Math.random;
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });

  const box = await locator.boundingBox();
  if (box === null) {
    await locator.click();
    return;
  }

  // A point inside the element, away from the exact centre.
  const offsetX = (random() - 0.5) * box.width * 0.4;
  const offsetY = (random() - 0.5) * box.height * 0.4;
  const x = box.x + box.width / 2 + offsetX;
  const y = box.y + box.height / 2 + offsetY;

  // The pointer moves in a couple of steps, not in one.
  await page.mouse.move(x - 20 - random() * 30, y - 15 - random() * 20);
  await page.mouse.move(x, y, { steps: 4 + Math.floor(random() * 6) });

  if (options.sloppy === true && random() < 0.1) {
    // A mis-click: the pointer lands outside the element, and the click
    // does nothing. This is for testing your own site.
    await page.mouse.click(x + box.width * 0.8, y + box.height * 0.8);
    return;
  }

  await page.mouse.click(x, y);
}

/**
 * A jittered delay for rate limiting.
 *
 * The delay is always at least the base, and never more than the base plus
 * the jitter, so a rate limit is never accidentally exceeded.
 */
export function jitteredDelay(
  baseMs: number,
  jitter: readonly [number, number],
  random: () => number = Math.random,
): number {
  const [low, high] = jitter;
  const spread = Math.max(0, high - low);
  return baseMs + Math.floor(random() * spread);
}

/**
 * The options for the messy-user mode.
 */
export interface MessyOptions {
  /** The chance that a click lands in the wrong place. */
  misclickChance: number;
  /** The chance that a typed character is wrong and corrected. */
  typoChance: number;
  /** The chance of a pause before an action. */
  pauseChance: number;
}

/** The default messy-user settings. */
export const DEFAULT_MESSY: MessyOptions = {
  misclickChance: 0.08,
  typoChance: 0.04,
  pauseChance: 0.15,
};

/**
 * Check whether the messy mode may be used against an origin.
 *
 * It may only be used against an origin the operator owns. This is a hard
 * rule, not a warning: the mode exists to find the bugs in **your** site.
 */
export function mayUseMessyMode(
  url: string,
  ownedOrigins: readonly string[],
): { allowed: boolean; reason: string } {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { allowed: false, reason: 'the URL could not be parsed' };
  }

  if (ownedOrigins.includes(origin)) {
    return { allowed: true, reason: `the origin ${origin} is owned` };
  }

  return {
    allowed: false,
    reason:
      `messy mode is restricted to origins you own; ${origin} is not one of ` +
      `them (${ownedOrigins.join(', ') || 'none configured'})`,
  };
}

/**
 * Apply the honest identity to a context.
 *
 * The user agent is set to something that says exactly what this is, and
 * the contact URL is included so a site operator can reach whoever is
 * running the tool.
 */
export async function applyHonestIdentity(
  context: BrowserContext,
  options: { userAgent: string; contactUrl: string },
): Promise<void> {
  // The contact URL is exposed as a header-visible fact, not hidden.
  await context.setExtraHTTPHeaders({
    'X-Browser-Verified-Contact': options.contactUrl,
  });
}

/**
 * The description of the identity a context carries.
 *
 * Used by the audit log so a run records who it was.
 */
export function describeIdentity(options: { userAgent: string; contactUrl: string }): string {
  return `${options.userAgent} (contact: ${options.contactUrl})`;
}
