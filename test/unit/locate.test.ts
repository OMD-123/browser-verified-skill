/**
 * Tests for the target parser and the locator chain (M03).
 *
 * The chain order matters: it is what makes healing possible and what keeps
 * a CSS selector from being used when a role and name would do.
 */
import { describe, expect, it } from 'vitest';
import { parseTarget, strategyOrder } from '../../src/actions/locate.js';
import { WAIT_CONDITIONS } from '../../src/actions/waits.js';

describe('the target parser', () => {
  it('parses a ref', () => {
    expect(parseTarget('e12')).toEqual({ ref: 'e12' });
  });

  it('parses a frame ref', () => {
    expect(parseTarget('f1e12')).toEqual({ ref: 'f1e12' });
  });

  it('parses a role with a name', () => {
    expect(parseTarget('role=button name="Log in"')).toEqual({
      role: 'button',
      name: 'Log in',
    });
  });

  it('parses a role without a name', () => {
    expect(parseTarget('role=button')).toEqual({ role: 'button' });
  });

  it('parses a label', () => {
    expect(parseTarget('label="Email address"')).toEqual({ label: 'Email address' });
  });

  it('parses a text target', () => {
    expect(parseTarget('text="Sign in"')).toEqual({ text: 'Sign in' });
  });

  it('parses a test id', () => {
    expect(parseTarget('testid=submit')).toEqual({ testId: 'submit' });
  });

  it('parses a CSS selector', () => {
    expect(parseTarget('#login-button')).toEqual({ css: '#login-button' });
  });

  it('parses several fields at once', () => {
    const target = parseTarget('role=button name="Save" testid=save');
    expect(target.role).toBe('button');
    expect(target.name).toBe('Save');
    expect(target.testId).toBe('save');
  });

  it('handles a quoted name with spaces', () => {
    expect(parseTarget('role=button name="Log in now"').name).toBe('Log in now');
  });

  it('handles a name with an equals sign in it', () => {
    expect(parseTarget('role=button name="a=b"').name).toBe('a=b');
  });

  it('handles a single-quoted name', () => {
    expect(parseTarget("role=button name='Log in'").name).toBe('Log in');
  });

  it('returns an empty descriptor for an empty string', () => {
    expect(parseTarget('')).toEqual({});
  });

  it('treats an unknown key as visible text', () => {
    // A bare string that is not a known key=value pair is treated as text,
    // because that is what an agent most often means.
    expect(parseTarget('nonsense=value')).toEqual({ text: 'nonsense=value' });
  });

  it('treats a bare string as visible text', () => {
    expect(parseTarget('Sign in')).toEqual({ text: 'Sign in' });
  });

  it('treats a selector-looking string as CSS', () => {
    expect(parseTarget('#id')).toEqual({ css: '#id' });
    expect(parseTarget('.class')).toEqual({ css: '.class' });
    expect(parseTarget('[attr]')).toEqual({ css: '[attr]' });
  });
});

describe('the locator chain order', () => {
  it('puts the ref first', () => {
    const order = strategyOrder({ ref: 'e12' });
    expect(order[0]).toBe('ref');
  });

  it('puts the role before the label', () => {
    const order = strategyOrder({ role: 'button', name: 'Save', label: 'Save' });
    expect(order.indexOf('role')).toBeLessThan(order.indexOf('label'));
  });

  it('puts the label before the text', () => {
    const order = strategyOrder({ label: 'Save', text: 'Save' });
    expect(order.indexOf('label')).toBeLessThan(order.indexOf('text'));
  });

  it('puts the text before the test id', () => {
    const order = strategyOrder({ text: 'Save', testId: 'save' });
    expect(order.indexOf('text')).toBeLessThan(order.indexOf('testid'));
  });

  it('puts the test id before the CSS selector', () => {
    const order = strategyOrder({ testId: 'save', css: '.save' });
    expect(order.indexOf('testid')).toBeLessThan(order.indexOf('css'));
  });

  it('only includes the strategies that apply', () => {
    expect(strategyOrder({ label: 'Save' })).toEqual(['label']);
  });

  it('is empty for an empty descriptor', () => {
    expect(strategyOrder({})).toEqual([]);
  });

  it('needs both a role and a name to use the role strategy', () => {
    // A bare role would match too many things, so it is not a strategy on
    // its own. The role still reaches the page through the fresh-snapshot
    // lookup.
    expect(strategyOrder({ role: 'button' })).toEqual([]);
    expect(strategyOrder({ role: 'button', name: 'Save' })).toEqual(['role']);
  });
});

describe('the wait conditions', () => {
  it('includes the documented conditions', () => {
    for (const condition of ['attached', 'visible', 'stable', 'enabled', 'receives-events']) {
      expect(WAIT_CONDITIONS).toContain(condition);
    }
  });

  it('does not include a fixed sleep', () => {
    // Fixed sleeps are forbidden except for the rate-limit jitter.
    expect(WAIT_CONDITIONS).not.toContain('sleep');
  });
});
