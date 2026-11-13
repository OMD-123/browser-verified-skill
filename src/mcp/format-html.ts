/**
 * Format generated HTML with Prettier.
 *
 * The generated demo page is checked by `prettier --check` in CI, so it
 * has to come out formatted. Hand-rolling a formatter would be a second
 * source of truth for what "formatted" means; Prettier is already the
 * project's formatter, so it is the right one to ask.
 *
 * If Prettier is somehow unavailable, the input is returned unchanged:
 * an unformatted page is better than no page, and the format check
 * will say so.
 */
import { format, resolveConfig } from 'prettier';

export async function formatHtml(html: string, filepath: string): Promise<string> {
  try {
    // The filepath is what lets Prettier find the project's config.
    // Without it, resolveConfig returns null and the page comes out
    // formatted differently from every other file -- which the format
    // check then fails on.
    const config = await resolveConfig(filepath);
    return await format(html, {
      ...(config ?? {}),
      filepath,
      parser: 'html',
      endOfLine: 'lf',
    });
  } catch {
    return html;
  }
}
