/**
 * Browser contexts, tabs and frames.
 *
 * Everything that touches Playwright's browser model lives here, so the rest
 * of the codebase deals with plain data.
 */
import type { Browser, BrowserContext, Page, Frame } from 'playwright';

/** A tab in a session. */
export interface TabInfo {
  /** Playwright's page index within the context. */
  index: number;
  /** The page URL. */
  url: string;
  /** The page title. */
  title: string;
  /** Whether the tab is the active one. */
  active: boolean;
  /** True when the tab was opened by the page (a popup). */
  popup: boolean;
}

/** A frame inside a tab. */
export interface FrameInfo {
  /** The frame's URL. */
  url: string;
  /** The frame's name, when it has one. */
  name?: string;
  /** True when the frame is the main frame. */
  isMain: boolean;
  /** The frame's index in the page's frame list. */
  index: number;
}

/**
 * Manages the browser context and the pages within it.
 *
 * A session has exactly one context (so cookies and storage are shared) and
 * one or more pages (tabs).
 */
export class SessionState {
  /** The URL of the active page, when there is one. */
  currentUrl(): string | undefined {
    return this.pages[this.activeIndex]?.url();
  }

  readonly browser: Browser;
  context: BrowserContext | undefined;
  pages: Page[] = [];
  /** The index of the active page. */
  activeIndex = 0;
  /** Pages that were opened by the page rather than by the user. */
  readonly popupPages = new Set<Page>();

  constructor(browser: Browser) {
    this.browser = browser;
  }

  /** Create the context if it does not exist. */
  async ensureContext(
    options: { userAgent?: string; headed?: boolean } = {},
  ): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context;
    const contextOptions: Parameters<Browser['newContext']>[0] = {};
    if (options.userAgent !== undefined) contextOptions.userAgent = options.userAgent;
    this.context = await this.browser.newContext(contextOptions);
    return this.context;
  }

  /** The active page, creating one if needed. */
  async activePage(): Promise<Page> {
    const context = await this.ensureContext();
    const existing = this.pages[this.activeIndex];
    if (existing !== undefined && !existing.isClosed()) return existing;

    const page = await context.newPage();
    this.pages.push(page);
    this.activeIndex = this.pages.length - 1;
    return page;
  }

  /** Register a page that Playwright reports as a popup. */
  registerPopup(page: Page): void {
    this.popupPages.add(page);
    this.pages.push(page);
  }

  /** Forget closed pages and return the list of live tabs. */
  async tabs(): Promise<TabInfo[]> {
    this.pages = this.pages.filter((p) => !p.isClosed());
    if (this.activeIndex >= this.pages.length) {
      this.activeIndex = Math.max(0, this.pages.length - 1);
    }

    const infos: TabInfo[] = [];
    for (const [index, page] of this.pages.entries()) {
      let url = '';
      let title = '';
      try {
        url = page.url();
        title = await page.title().catch(() => '');
      } catch {
        // The page may have navigated away or closed mid-read.
      }
      infos.push({
        index,
        url,
        title,
        active: index === this.activeIndex,
        popup: this.popupPages.has(page),
      });
    }
    return infos;
  }

  /** Switch to a tab by index. */
  selectTab(index: number): Page {
    const page = this.pages[index];
    if (page === undefined) {
      throw new Error(`no tab with index ${index}`);
    }
    this.activeIndex = index;
    return page;
  }

  /** Close a tab by index. */
  async closeTab(index: number): Promise<void> {
    const page = this.pages[index];
    if (page === undefined) {
      throw new Error(`no tab with index ${index}`);
    }
    await page.close().catch(() => undefined);
    this.pages = this.pages.filter((_, i) => i !== index);
    if (this.activeIndex >= this.pages.length) {
      this.activeIndex = Math.max(0, this.pages.length - 1);
    }
  }

  /** List the frames of the active page. */
  async frames(page?: Page): Promise<FrameInfo[]> {
    const target = page ?? (await this.activePage());
    return target.frames().map((frame: Frame, index: number) => ({
      url: frame.url(),
      ...(frame.name() !== '' ? { name: frame.name() } : {}),
      isMain: frame === target.mainFrame(),
      index,
    }));
  }

  /** Save the storage state of the context. */
  async storageState(): Promise<unknown> {
    if (this.context === undefined) return null;
    return this.context.storageState();
  }

  /**
   * Restore a storage state into a live context.
   *
   * Playwright can only apply a storage state when *creating* a context, so
   * restoring into a running context is done explicitly:
   *  - cookies via `context.addCookies()`,
   *  - localStorage via an init script that seeds it before any page script
   *    runs.
   *
   * sessionStorage is not restorable: it is per-tab and dies with the tab.
   * This is recorded in docs/KNOWN_LIMITATIONS.md.
   */
  async restoreStorageState(state: unknown): Promise<void> {
    if (state === null || state === undefined) return;
    const context = await this.ensureContext();

    if (typeof state !== 'object' || state === null) return;
    const typed = state as { cookies?: unknown; origins?: unknown };

    // --- Cookies ------------------------------------------------------------
    if (Array.isArray(typed.cookies)) {
      const valid = typed.cookies.filter(
        (c): c is Parameters<BrowserContext['addCookies']>[0][number] =>
          typeof c === 'object' && c !== null,
      );
      if (valid.length > 0) {
        await context.addCookies(valid);
      }
    }

    // --- localStorage -------------------------------------------------------
    if (Array.isArray(typed.origins)) {
      const seed = typed.origins
        .filter(
          (o): o is { origin: string; localStorage: { name: string; value: string }[] } =>
            typeof o === 'object' &&
            o !== null &&
            typeof (o as { origin?: unknown }).origin === 'string' &&
            Array.isArray((o as { localStorage?: unknown }).localStorage),
        )
        .map((o) => ({
          origin: o.origin,
          localStorage: o.localStorage.filter(
            (e): e is { name: string; value: string } =>
              typeof e === 'object' && e !== null && typeof e.name === 'string',
          ),
        }))
        .filter((o) => o.localStorage.length > 0);

      if (seed.length > 0) {
        await context.addInitScript((entries: typeof seed) => {
          for (const entry of entries) {
            try {
              const loc = window.location;
              if (loc.origin !== entry.origin) continue;
              for (const item of entry.localStorage) {
                window.localStorage.setItem(item.name, item.value);
              }
            } catch {
              // Storage can be blocked; ignore.
            }
          }
        }, seed);
      }
    }
  }

  /** Close everything. */
  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.pages = [];
  }
}
