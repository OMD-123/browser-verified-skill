/**
 * Launching Chromium in tests and in the daemon.
 *
 * Playwright prefers the "headless shell" build, which is a separate download
 * from the full Chromium build. On hosts where only the full build is
 * installed (or where the installer cannot run), the full build is used
 * instead.
 *
 * The difference matters for one thing: `chromium.launch({ channel: 'chromium' })`
 * uses the full Chromium build in headless mode.
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright';

/**
 * Launch Chromium, preferring the headless shell and falling back to the
 * full build.
 *
 * The fallback is what makes the e2e suite runnable on a host where only
 * `chromium-<revision>` is present.
 */
export async function launchChromium(
  options: { headless?: boolean; headed?: boolean } = {},
): Promise<Browser> {
  const headless = options.headed !== true;
  const launchOptions: LaunchOptions = { headless };

  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Executable doesn't exist")) throw err;

    // The headless shell is missing: use the full Chromium build, which
    // supports headless mode too.
    return chromium.launch({ ...launchOptions, channel: 'chromium' });
  }
}
