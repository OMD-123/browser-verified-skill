/**
 * `bv diff`, `bv report` and `bv audit` — the QA commands.
 */
import type { Command } from 'commander';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ok, fail } from '../../core/output.js';
import { EXIT } from '../../core/exit.js';
import { connectDaemon } from '../../core/client.js';
import { emit, globalOptions } from '../helpers.js';
import { UsageError } from '../../core/errors.js';
import { absPath, runDir } from '../../core/paths.js';
import { launchChromium } from '../../core/browser.js';
import { diffPages, renderDiff } from '../../testing/diff.js';
import {
  buildReports,
  renderFullReport,
  renderReports,
  renderReportsJson,
} from '../../testing/report.js';
import { FindingsCollector, renderFindings } from '../../testing/qa.js';
import type { PageFindings } from '../../testing/qa.js';

/** Register the QA commands. */
export function registerQa(program: Command): void {
  // --- bv diff ------------------------------------------------------------
  program
    .command('diff')
    .description('compare two pages and report how their trees differ')
    .option('--a <url>', 'the first URL')
    .option('--b <url>', 'the second URL')
    .option('--out <file>', 'write the result to this file')
    .action(async (options: { a?: string; b?: string; out?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      if (options.a === undefined || options.b === undefined) {
        const message = 'bv diff needs --a <url> and --b <url>';
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const browser = await launchChromium();
        let text: string;
        let result: Awaited<ReturnType<typeof diffPages>>;
        try {
          result = await diffPages(browser, options.a, options.b);
          text = renderDiff(result);
        } finally {
          await browser.close();
        }

        if (options.out !== undefined) {
          const path = absPath(options.out, global.cwd);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text, 'utf8');
        }

        emit(
          cmd,
          result.identical
            ? ok(result, ['The two pages have the same accessibility tree.'])
            : fail(result, [text], EXIT.VERIFICATION_FAILED),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv report ----------------------------------------------------------
  program
    .command('report')
    .description('report what a run found, as Markdown or JSON')
    .argument('<runId>', 'the run to report on')
    .option('--format <format>', 'md or json', 'md')
    .option('--out <file>', 'write the report to this file')
    .action(
      async (runId: string, options: { format?: string; out?: string }, cmd: Command) => {
        const global = globalOptions(cmd);
        const format = options.format ?? 'md';
        if (!['md', 'json'].includes(format)) {
          const message = `--format must be md or json, not "${format}"`;
          emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
          return;
        }

        try {
          const findings = await readFindings(runId, global.cwd);
          const reports = buildReports(findings, {
            reproSteps: ['open the url', 'observe the page'],
          });
          const text =
            format === 'json'
              ? renderReportsJson(reports)
              : renderFullReport(findings, reports);

          if (options.out !== undefined) {
            const path = absPath(options.out, global.cwd);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text, 'utf8');
          }

          const lines =
            format === 'json' ? [`${reports.length} problem(s) found.`] : [renderReports(reports)];
          emit(cmd, ok({ runId, findings, reports }, lines));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
          emit(cmd, fail({ error: message }, [message], code));
        }
      },
    );

  // --- bv audit -----------------------------------------------------------
  program
    .command('audit')
    .description('show the audit log of a run')
    .argument('[runId]', 'the run to show (the newest one by default)')
    .action(async (runId: string | undefined, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const id = runId ?? (await newestRun(global.cwd));
        if (id === undefined) {
          const message = 'there are no runs yet';
          emit(cmd, fail({ error: message }, [message], EXIT.FAILURE));
          return;
        }

        const entries = await readAudit(id, global.cwd);
        const lines = entries.map((entry) => JSON.stringify(entry));
        emit(cmd, ok({ runId: id, entries }, lines.length > 0 ? lines : ['(the audit log is empty)']));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}

/**
 * Read the findings of a run.
 *
 * The findings are read from the run's own artifacts, so a report can be
 * produced long after the browser is gone.
 */
async function readFindings(runId: string, cwd: string): Promise<PageFindings> {
  const path = `${runDir(runId, cwd)}/findings.json`;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as PageFindings;
  } catch {
    throw new UsageError(
      `the run ${runId} has no findings. Only a run made by the QA commands has findings.`,
    );
  }
}

/**
 * Read the audit log of a run.
 */
async function readAudit(
  runId: string,
  cwd: string,
): Promise<Record<string, unknown>[]> {
  const path = `${runDir(runId, cwd)}/audit.jsonl`;
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Find the newest run.
 */
async function newestRun(cwd: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(runDir('', cwd).replace(/[/\\]$/, ''));
    const runs = entries.filter((entry) => /^\d{8}T\d{6}-/.test(entry));
    runs.sort();
    return runs[runs.length - 1];
  } catch {
    return undefined;
  }
}

/**
 * Collect the findings of a page, for the QA commands.
 *
 * Exported so the daemon's `audit` handler can use the same collector.
 */
export { FindingsCollector, renderFindings, connectDaemon };
