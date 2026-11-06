/**
 * Tests for the browser-side element inspector (M05-M07).
 *
 * The inspector is what tells the gate the role, name and form context of a
 * target. If it reports the wrong facts, the gate classifies the action
 * wrongly, so it is worth testing directly against a real page.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChromium } from '../../src/core/browser.js';
import { inspectTarget } from '../../src/safety/inspect.js';
import { parseTarget } from '../../src/actions/locate.js';

describe('the element inspector', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchChromium();
    page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <form method="post" action="/login">
          <label for="u">Username</label>
          <input id="u" name="username" type="text" />
          <label for="p">Password</label>
          <input id="p" name="password" type="password" />
          <input id="f" name="avatar" type="file" />
          <button type="submit" data-testid="submit">Log in</button>
        </form>
        <button type="button" aria-label="Toggle theme">Theme</button>
        <select id="s" name="country"><option>NL</option></select>
        <textarea id="t" name="bio" placeholder="About you"></textarea>
        <p>Just a paragraph.</p>
      </body></html>
    `);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('reads a submit button, its form and its method', async () => {
    const facts = await inspectTarget(page, parseTarget('role=button name="Log in"'));
    expect(facts.role).toBe('button');
    expect(facts.text).toBe('Log in');
    expect(facts.inForm).toBe(true);
    expect(facts.formMethod).toBe('POST');
    expect(facts.inputType).toBe('submit');
  });

  it('reads a text input, its label and its form', async () => {
    const facts = await inspectTarget(page, parseTarget('css=#u'));
    expect(facts.role).toBe('textbox');
    expect(facts.name).toBe('Username');
    expect(facts.inForm).toBe(true);
  });

  it('reads a password field', async () => {
    const facts = await inspectTarget(page, parseTarget('css=#p'));
    expect(facts.inputType).toBe('password');
    expect(facts.name).toBe('Password');
  });

  it('recognises a file input', async () => {
    const facts = await inspectTarget(page, parseTarget('css=#f'));
    expect(facts.isFileInput).toBe(true);
  });

  it('reads an aria-label', async () => {
    const facts = await inspectTarget(page, parseTarget('role=button name="Toggle theme"'));
    expect(facts.name).toBe('Toggle theme');
  });

  it('reads a select as a combobox', async () => {
    const facts = await inspectTarget(page, parseTarget('css=#s'));
    expect(facts.role).toBe('combobox');
  });

  it('reads a textarea as a textbox and takes its placeholder as the name', async () => {
    const facts = await inspectTarget(page, parseTarget('css=#t'));
    expect(facts.role).toBe('textbox');
    expect(facts.name).toBe('About you');
  });

  it('reads a paragraph as text with no role', async () => {
    const facts = await inspectTarget(page, parseTarget('text="Just a paragraph."'));
    expect(facts.text).toContain('Just a paragraph');
  });

  it('returns nothing for a target that does not exist', async () => {
    const facts = await inspectTarget(page, parseTarget('role=button name="No such button"'));
    expect(facts).toEqual({});
  });

  it('returns nothing for a target with no descriptor at all', async () => {
    const facts = await inspectTarget(page, {});
    expect(facts).toEqual({});
  });

  it('finds a target by its test id', async () => {
    const facts = await inspectTarget(page, parseTarget('testid=submit'));
    expect(facts.text).toBe('Log in');
  });

  it('finds a target by its label', async () => {
    const facts = await inspectTarget(page, parseTarget('label="Password"'));
    expect(facts.inputType).toBe('password');
  });

  it('finds a target by its text', async () => {
    const facts = await inspectTarget(page, parseTarget('text="Log in"'));
    expect(facts.role).toBe('button');
  });

  it('ignores an invalid ref and falls through', async () => {
    // A ref that is not a valid Playwright ref makes `getByRef` throw.
    // The inspector must fall through rather than crash.
    const facts = await inspectTarget(page, { ref: 'not-a-real-ref' });
    expect(facts).toEqual({});
  });

  it('resolves a target with no role', async () => {
    const facts = await inspectTarget(page, { css: '#u' });
    expect(facts.role).toBe('textbox');
  });

  it('resolves a target by role without a name', async () => {
    // The role-only branch of the locator chain.
    const facts = await inspectTarget(page, { role: 'button' });
    expect(facts.role).toBe('button');
  });

  it('resolves a target by label alone', async () => {
    const facts = await inspectTarget(page, { label: 'Username' });
    expect(facts.name).toBe('Username');
  });

  it('resolves a target by text alone', async () => {
    const facts = await inspectTarget(page, { text: 'Log in' });
    expect(facts.role).toBe('button');
  });

  it('resolves a target by test id alone', async () => {
    const facts = await inspectTarget(page, { testId: 'submit' });
    expect(facts.text).toBe('Log in');
  });

  it('ignores a selector that cannot be counted', async () => {
    // An invalid CSS selector makes `count()` reject. The inspector must
    // treat that as "not found" rather than propagating the error.
    const facts = await inspectTarget(page, { css: ':::' });
    expect(facts).toEqual({});
  });

  it('truncates a long text', async () => {
    await page.setContent(`<p>${'x'.repeat(500)}</p>`);
    const facts = await inspectTarget(page, parseTarget('css=p'));
    expect((facts.text ?? '').length).toBeLessThanOrEqual(200);
  });
});
