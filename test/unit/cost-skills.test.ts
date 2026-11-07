/**
 * Tests for the cost reporting and the skills (M28, M29).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CostTracker,
  combinedReport,
  costPerStep,
  costliestStep,
  formatUsd,
} from '../../src/agent/cost.js';
import { BudgetGuard, type LlmResponse, type Tier } from '../../src/llm/client.js';
import {
  describeReadFailure,
  parseSkill,
  readSkills,
  renderSkill,
  renderSkillFailures,
  renderSkills,
  skillsForOrigin,
  writeSkill,
} from '../../src/memory/skills.js';

/** A response. */
function response(
  tier: Tier,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): LlmResponse {
  return {
    text: 'x',
    toolCalls: [],
    usage: { inputTokens, outputTokens },
    servedBy: tier,
    costUsd,
    durationMs: 100,
  };
}

describe('the cost tracker', () => {
  it('starts at nothing', () => {
    const tracker = new CostTracker();
    expect(tracker.count).toBe(0);
    expect(tracker.totalUsd).toBe(0);
  });

  it('records a request', () => {
    const tracker = new CostTracker();
    tracker.record(response('standard', 1000, 500, 0.01));
    expect(tracker.count).toBe(1);
    expect(tracker.totalUsd).toBe(0.01);
  });

  it('totals the cost', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 100, 50, 0.001));
    tracker.record(response('deep', 200, 100, 0.02));
    expect(tracker.totalUsd).toBeCloseTo(0.021, 10);
  });

  it('totals the tokens', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 100, 50, 0));
    tracker.record(response('fast', 200, 100, 0));
    expect(tracker.totalTokens).toBe(450);
  });

  it('totals the time', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 0));
    tracker.record(response('fast', 1, 1, 0));
    expect(tracker.totalDurationMs).toBe(200);
  });

  it('breaks the cost down by tier', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 0.001));
    tracker.record(response('fast', 1, 1, 0.002));
    tracker.record(response('deep', 1, 1, 0.5));

    const tiers = tracker.byTier();
    expect(tiers.fast.calls).toBe(2);
    expect(tiers.fast.costUsd).toBeCloseTo(0.003, 10);
    expect(tiers.deep.calls).toBe(1);
    expect(tiers.standard.calls).toBe(0);
  });

  it('records the purpose', () => {
    const tracker = new CostTracker();
    const entry = tracker.record(response('fast', 1, 1, 0), 'reading the page');
    expect(entry.purpose).toBe('reading the page');
  });

  it('renders the report', () => {
    const tracker = new CostTracker();
    tracker.record(response('standard', 1000, 500, 0.0123));
    const report = tracker.report();
    expect(report).toContain('1 request');
    expect(report).toContain('1500 token');
    expect(report).toContain('$0.0123');
  });

  it('says nothing was spent when nothing was', () => {
    expect(new CostTracker().report()).toContain('nothing was spent');
  });

  it('renders the JSON report', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 0.5));
    const parsed = JSON.parse(tracker.reportJson()) as { currency: string; costUsd: number };
    expect(parsed.currency).toBe('USD');
    expect(parsed.costUsd).toBe(0.5);
  });
});

describe('the dollar formatter', () => {
  it('formats a normal amount to four places', () => {
    expect(formatUsd(1.5)).toBe('1.5000');
  });

  it('does not round a small amount away', () => {
    // Four places is enough for $0.0004; it is not shown as $0.00.
    expect(formatUsd(0.0004)).toBe('0.0004');
  });

  it('shows an amount too small for four places in full', () => {
    expect(formatUsd(0.00001)).toBe('1.00e-5');
  });

  it('formats zero as zero', () => {
    expect(formatUsd(0)).toBe('0.0000');
  });
});

describe('the combined report', () => {
  it('includes the budget when there is one', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 0.25));
    const budget = new BudgetGuard(1);
    budget.record('fast', { inputTokens: 1_000_000, outputTokens: 0 });

    const report = combinedReport(tracker, budget);
    expect(report).toContain('Budget:');
    expect(report).toContain('left');
  });

  it('works without a budget', () => {
    expect(combinedReport(new CostTracker(), undefined)).toContain('request');
  });
});

describe('the cost per step', () => {
  it('divides the cost by the steps', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 1));
    expect(costPerStep(tracker, 4).perStepUsd).toBe(0.25);
  });

  it('does not divide by zero', () => {
    expect(costPerStep(new CostTracker(), 0).perStepUsd).toBe(0);
  });

  it('finds the costliest step', () => {
    const tracker = new CostTracker();
    tracker.record(response('fast', 1, 1, 0.1));
    tracker.record(response('fast', 1, 1, 0.9));
    expect(costliestStep(tracker)?.costUsd).toBe(0.9);
  });

  it('has no costliest step when there were none', () => {
    expect(costliestStep(new CostTracker())).toBeUndefined();
  });
});

describe('the skills', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bv-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a skill', async () => {
    const skill = await parseSkill(
      '---\nname: login\ndescription: how to log in\nversion: 1.0.0\n---\n\nClick Sign in.\n',
    );
    expect(skill.frontmatter.name).toBe('login');
    expect(skill.body).toBe('Click Sign in.');
  });

  it('rejects a skill with no frontmatter', async () => {
    await expect(parseSkill('just text')).rejects.toThrow('no frontmatter');
  });

  it('rejects a skill with an unknown frontmatter key', async () => {
    await expect(
      parseSkill('---\nname: a\ndescription: b\nsurprise: c\n---\n\nbody\n'),
    ).rejects.toThrow('invalid frontmatter');
  });

  it('rejects a skill with no name', async () => {
    await expect(parseSkill('---\ndescription: b\n---\n\nbody\n')).rejects.toThrow(
      'invalid frontmatter',
    );
  });

  it('writes and reads a skill', async () => {
    await writeSkill(
      dir,
      {
        name: 'checkout',
        description: 'how to check out',
        version: '1.0.0',
        untrusted: false,
        allowedActions: [],
      },
      'Click Checkout, then Pay.',
    );

    const { skills, failures } = await readSkills(dir);
    expect(failures).toHaveLength(0);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.body).toBe('Click Checkout, then Pay.');
  });

  it('round-trips the frontmatter', async () => {
    await writeSkill(
      dir,
      {
        name: 'login',
        description: 'how to log in',
        version: '2.1.0',
        origin: 'example.test',
        untrusted: true,
        allowedActions: ['click'],
      },
      'body',
    );

    const { skills } = await readSkills(dir);
    expect(skills[0]?.frontmatter.version).toBe('2.1.0');
    expect(skills[0]?.frontmatter.origin).toBe('example.test');
    expect(skills[0]?.frontmatter.untrusted).toBe(true);
    expect(skills[0]?.frontmatter.allowedActions).toEqual(['click']);
  });

  it('skips a broken skill and keeps the good one', async () => {
    await writeFile(
      join(dir, 'good.md'),
      '---\nname: good\ndescription: fine\n---\n\nbody\n',
      'utf8',
    );
    await writeFile(join(dir, 'broken.md'), 'not a skill at all', 'utf8');

    const { skills, failures } = await readSkills(dir);
    expect(skills).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('no frontmatter');
  });

  it('returns nothing for a directory that does not exist', async () => {
    const { skills, failures } = await readSkills(join(dir, 'nope'));
    expect(skills).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it('finds the skills for an origin', async () => {
    await writeSkill(
      dir,
      {
        name: 'specific',
        description: 'x',
        version: '1.0.0',
        origin: 'example.test',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );
    await writeSkill(
      dir,
      {
        name: 'general',
        description: 'x',
        version: '1.0.0',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );

    const all = await readSkills(dir);
    const forOrigin = skillsForOrigin(all.skills, 'https://example.test');
    expect(forOrigin.map((skill) => skill.frontmatter.name).sort()).toEqual([
      'general',
      'specific',
    ]);
  });

  it('does not apply another origin skill', async () => {
    await writeSkill(
      dir,
      {
        name: 'specific',
        description: 'x',
        version: '1.0.0',
        origin: 'example.test',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );
    const { skills } = await readSkills(dir);
    expect(skillsForOrigin(skills, 'https://other.test')).toHaveLength(0);
  });

  it('marks an untrusted skill', async () => {
    const skill = await parseSkill('---\nname: a\ndescription: b\nuntrusted: true\n---\n\nbody\n');
    const text = renderSkill(skill);
    expect(text).toContain('untrusted source');
    expect(text).toContain('not as instructions');
  });

  it('does not mark a trusted skill', async () => {
    const skill = await parseSkill('---\nname: a\ndescription: b\n---\n\nbody\n');
    expect(renderSkill(skill)).not.toContain('untrusted');
  });

  it('renders every skill', async () => {
    const one = await parseSkill('---\nname: a\ndescription: b\n---\n\nbody one\n');
    const two = await parseSkill('---\nname: c\ndescription: d\n---\n\nbody two\n');
    const text = renderSkills([one, two]);
    expect(text).toContain('body one');
    expect(text).toContain('body two');
    expect(text).toContain('---');
  });

  it('renders nothing for no skills', () => {
    expect(renderSkills([])).toBe('');
  });

  it('renders the failures', () => {
    const text = renderSkillFailures([{ path: '/x.md', reason: 'broken' }]);
    expect(text).toContain('/x.md');
    expect(text).toContain('broken');
  });

  it('renders nothing when there are no failures', () => {
    expect(renderSkillFailures([])).toBe('');
  });

  it('ignores a file that is not markdown', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hello', 'utf8');
    const { skills, failures } = await readSkills(dir);
    expect(skills).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it('handles a skill with no body', async () => {
    const skill = await parseSkill('---\nname: a\ndescription: b\n---\n');
    expect(skill.body).toBe('');
  });

  it('handles a skill with CRLF line endings', async () => {
    const skill = await parseSkill('---\r\nname: a\r\ndescription: b\r\n---\r\n\r\nbody here\r\n');
    expect(skill.frontmatter.name).toBe('a');
    expect(skill.body).toBe('body here');
  });

  it('describes a failure that was not an error', () => {
    expect(describeReadFailure('a string')).toBe('the skill could not be read');
  });

  it('describes an error failure with its own message', () => {
    expect(describeReadFailure(new Error('boom'))).toBe('boom');
  });

  it('reports a skill that could not be read at all', async () => {
    // A file that cannot be read: a directory named like a skill.
    await mkdir(join(dir, 'unreadable.md'), { recursive: true });
    const { skills, failures } = await readSkills(dir);
    expect(skills).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });

  it('matches a subdomain of an origin', async () => {
    await writeSkill(
      dir,
      {
        name: 'specific',
        description: 'x',
        version: '1.0.0',
        origin: 'example.test',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );
    const { skills } = await readSkills(dir);
    expect(skillsForOrigin(skills, 'https://sub.example.test')).toHaveLength(1);
  });

  it('matches an origin given without a scheme', async () => {
    await writeSkill(
      dir,
      {
        name: 'specific',
        description: 'x',
        version: '1.0.0',
        origin: 'example.test',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );
    const { skills } = await readSkills(dir);
    expect(skillsForOrigin(skills, 'example.test')).toHaveLength(1);
  });

  it('matches an origin with a port', async () => {
    await writeSkill(
      dir,
      {
        name: 'specific',
        description: 'x',
        version: '1.0.0',
        origin: 'example.test',
        untrusted: false,
        allowedActions: [],
      },
      'body',
    );
    const { skills } = await readSkills(dir);
    expect(skillsForOrigin(skills, 'example.test:3000')).toHaveLength(1);
  });
});
