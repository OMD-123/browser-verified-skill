/**
 * Tests for the element-fact rules (M05-M07).
 *
 * These are the rules that decide whether a value can be typed into a
 * field, so they are tested directly.
 */
import { describe, expect, it } from 'vitest';
import {
  implicitRole,
  accessibleName,
  effectiveFormMethod,
  computeElementFacts,
} from '../../../src/safety/element-facts.js';

describe('the implicit role', () => {
  it('maps a button', () => {
    expect(implicitRole('button')).toBe('button');
  });

  it('maps a select', () => {
    expect(implicitRole('select')).toBe('combobox');
  });

  it('maps a textarea', () => {
    expect(implicitRole('textarea')).toBe('textbox');
  });

  it('maps a text input', () => {
    expect(implicitRole('input')).toBe('textbox');
    expect(implicitRole('input', 'text')).toBe('textbox');
  });

  it('maps a checkbox', () => {
    expect(implicitRole('input', 'checkbox')).toBe('checkbox');
  });

  it('maps a radio', () => {
    expect(implicitRole('input', 'radio')).toBe('radio');
  });

  it('maps a button input', () => {
    expect(implicitRole('input', 'button')).toBe('button');
  });

  it('maps a submit input', () => {
    expect(implicitRole('input', 'submit')).toBe('button');
  });

  it('maps a reset input', () => {
    expect(implicitRole('input', 'reset')).toBe('button');
  });

  it('maps a file input', () => {
    expect(implicitRole('input', 'file')).toBe('button');
  });

  it('maps an unknown input type to a textbox', () => {
    expect(implicitRole('input', 'email')).toBe('textbox');
  });

  it('has no role for other tags', () => {
    expect(implicitRole('div')).toBeUndefined();
    expect(implicitRole('p')).toBeUndefined();
    expect(implicitRole('a')).toBeUndefined();
  });
});

describe('the accessible name', () => {
  it('prefers the aria-label', () => {
    expect(
      accessibleName({
        tag: 'input',
        ariaLabel: 'Aria',
        labelText: 'Label',
        placeholder: 'Placeholder',
      }),
    ).toBe('Aria');
  });

  it('falls back to the label that points at the element', () => {
    expect(accessibleName({ tag: 'input', labelText: 'Label', placeholder: 'Placeholder' })).toBe(
      'Label',
    );
  });

  it('falls back to a wrapping label', () => {
    expect(accessibleName({ tag: 'input', wrappingLabelText: 'Wrapping', placeholder: 'P' })).toBe(
      'Wrapping',
    );
  });

  it('falls back to the placeholder', () => {
    expect(accessibleName({ tag: 'input', placeholder: 'Placeholder' })).toBe('Placeholder');
  });

  it('ignores an empty aria-label', () => {
    expect(accessibleName({ tag: 'input', ariaLabel: '', labelText: 'Label' })).toBe('Label');
  });

  it('ignores an empty label', () => {
    expect(accessibleName({ tag: 'input', labelText: '', placeholder: 'P' })).toBe('P');
  });

  it('ignores an empty wrapping label', () => {
    expect(accessibleName({ tag: 'input', wrappingLabelText: '', placeholder: 'P' })).toBe('P');
  });

  it('does not use a label for a non-form-control', () => {
    expect(accessibleName({ tag: 'div', labelText: 'Label' })).toBeUndefined();
  });

  it('has no name when there is nothing to use', () => {
    expect(accessibleName({ tag: 'input' })).toBeUndefined();
  });

  it('has no name for a plain element', () => {
    expect(accessibleName({ tag: 'p' })).toBeUndefined();
  });
});

describe('the effective form method', () => {
  it('assumes POST when there is no method', () => {
    expect(effectiveFormMethod(undefined)).toBe('POST');
  });

  it('keeps GET', () => {
    expect(effectiveFormMethod('GET')).toBe('GET');
  });

  it('keeps POST', () => {
    expect(effectiveFormMethod('POST')).toBe('POST');
  });

  it('uppercases a lower-case method', () => {
    expect(effectiveFormMethod('get')).toBe('GET');
  });

  it('treats an unusual method as POST', () => {
    expect(effectiveFormMethod('DIALOG')).toBe('POST');
  });
});

describe('computing the facts', () => {
  it('uses an explicit role when there is one', () => {
    const facts = computeElementFacts({ tag: 'div', role: 'button' });
    expect(facts.role).toBe('button');
  });

  it('ignores an empty role', () => {
    const facts = computeElementFacts({ tag: 'div', role: '' });
    expect(facts.role).toBeUndefined();
  });

  it('gives a form control its implicit role', () => {
    expect(computeElementFacts({ tag: 'button' }).role).toBe('button');
  });

  it('gives a non-form control no role', () => {
    expect(computeElementFacts({ tag: 'p' }).role).toBeUndefined();
  });

  it('records the name', () => {
    expect(computeElementFacts({ tag: 'input', ariaLabel: 'A' }).name).toBe('A');
  });

  it('omits an empty name', () => {
    expect(computeElementFacts({ tag: 'input', ariaLabel: '' }).name).toBeUndefined();
  });

  it('records the text, truncated', () => {
    const facts = computeElementFacts({ tag: 'p', text: 'x'.repeat(300) });
    expect(facts.text).toHaveLength(200);
  });

  it('omits empty text', () => {
    expect(computeElementFacts({ tag: 'p', text: '' }).text).toBeUndefined();
  });

  it('records the input type', () => {
    expect(computeElementFacts({ tag: 'input', type: 'password' }).inputType).toBe('password');
  });

  it('omits a missing input type', () => {
    expect(computeElementFacts({ tag: 'input' }).inputType).toBeUndefined();
  });

  it('marks a file input', () => {
    expect(computeElementFacts({ tag: 'input', type: 'file' }).isFileInput).toBe(true);
  });

  it('does not mark a non-file input', () => {
    expect(computeElementFacts({ tag: 'input', type: 'text' }).isFileInput).toBeUndefined();
  });

  it('records the form membership and method', () => {
    const facts = computeElementFacts({ tag: 'input', inForm: true, formMethod: 'GET' });
    expect(facts.inForm).toBe(true);
    expect(facts.formMethod).toBe('GET');
  });

  it('assumes POST for a form with no method', () => {
    const facts = computeElementFacts({ tag: 'input', inForm: true });
    expect(facts.formMethod).toBe('POST');
  });

  it('omits the form membership when there is no form', () => {
    const facts = computeElementFacts({ tag: 'input', inForm: false });
    expect(facts.inForm).toBeUndefined();
    expect(facts.formMethod).toBeUndefined();
  });

  it('records the html, truncated', () => {
    const facts = computeElementFacts({ tag: 'p', html: 'x'.repeat(900) });
    expect(facts.html).toHaveLength(500);
  });

  it('omits empty html', () => {
    expect(computeElementFacts({ tag: 'p', html: '' }).html).toBeUndefined();
  });

  it('handles a raw element with nothing in it', () => {
    expect(computeElementFacts({ tag: 'div' })).toEqual({});
  });
});
