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
import {
  asOpenApiFragment,
  discoverEndpoints,
  renderEndpoints,
  type ObservedRequest,
} from '../../testing/discover.js';
import { renderResearch, research, type ResearchQuestion } from '../../testing/research.js';
import { parseSuite, renderSuite, runSuite } from '../../testing/suite.js';
import { renderRedTeam, runRedTeam } from '../../testing/redteam.js';

/** Register the QA commands. */
export function registerQa(program: Command): void {
  // --- bv test -------------------------------------------------------------
  program
    .command('test')
    .description('run a suite of checks against a site')
    .option('--suite <file>', 'the suite JSON file')
    .option('--tag <tag>', 'only run checks with this tag (repeatable)', collect)
    .option('--out <file>', 'write the result to this file')
    .action(async (options: { suite?: string; tag?: string[]; out?: string }, cmd: Command) => {
      const global = globalOptions(cmd);
      if (options.suite === undefined) {
        const message = 'bv test needs --suite <file>';
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const raw = await readFile(absPath(options.suite, global.cwd), 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new UsageError(`the suite file is not valid JSON: ${detail}`);
        }

        const suite = parseSuite(parsed);

        const browser = await launchChromium();
        let result: Awaited<ReturnType<typeof runSuite>>;
        try {
          result = await runSuite(browser, suite, {
            ...(options.tag !== undefined ? { tags: options.tag } : {}),
          });
        } finally {
          await browser.close();
        }

        const text = renderSuite(result);
        if (options.out !== undefined) {
          const path = absPath(options.out, global.cwd);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text, 'utf8');
        }

        emit(
          cmd,
          result.failed === 0 ? ok(result, [text]) : fail(result, [text], EXIT.VERIFICATION_FAILED),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv redteam ----------------------------------------------------------
  program
    .command('redteam')
    .description("test the tool's own guards against known attacks")
    .argument('[action]', 'run (the only action for now)', 'run')
    .action(async (action: string, cmd: Command) => {
      const global = globalOptions(cmd);
      if (action !== 'run') {
        const message = `unknown redteam action "${action}". The only action is "run".`;
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }

      try {
        const result = await runRedTeam();
        emit(
          cmd,
          result.failed === 0
            ? ok(result, [renderRedTeam(result)])
            : fail(result, [renderRedTeam(result)], EXIT.VERIFICATION_FAILED),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(cmd, fail({ error: message }, [message], EXIT.FAILURE));
      }
      void global;
    });

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

  // --- bv discover-api ----------------------------------------------------
  program
    .command('discover-api')
    .description('report the API endpoints a run actually used')
    .argument('<runId>', 'the run to inspect')
    .option('--out <file>', 'write the result to this file')
    .option('--openapi', 'write an OpenAPI fragment instead', false)
    .action(async (runId: string, options: { out?: string; openapi?: boolean }, cmd: Command) => {
      const global = globalOptions(cmd);
      try {
        const facts = await readNetworkFacts(runId, global.cwd);
        const endpoints = discoverEndpoints(facts);
        const text =
          options.openapi === true
            ? JSON.stringify(asOpenApiFragment(endpoints), null, 2)
            : renderEndpoints(endpoints);

        if (options.out !== undefined) {
          const path = absPath(options.out, global.cwd);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text, 'utf8');
        }

        emit(cmd, ok({ runId, endpoints, count: endpoints.length }, [text]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });

  // --- bv research ---------------------------------------------------------
  program
    .command('research')
    .description('answer questions from a set of sources, in the browser')
    .option('--questions <file>', 'the questions JSON file')
    .option('--sources <file>', 'the sources file, one URL per line')
    .option('--out <file>', 'write the result to this file')
    .action(
      async (options: { questions?: string; sources?: string; out?: string }, cmd: Command) => {
        const global = globalOptions(cmd);
        if (options.questions === undefined || options.sources === undefined) {
          const message = 'bv research needs --questions <file> and --sources <file>';
          emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
          return;
        }

        try {
          const questionsRaw = await readFile(absPath(options.questions, global.cwd), 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(questionsRaw);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new UsageError(`the questions file is not valid JSON: ${detail}`);
          }

          const questions = normaliseQuestions(parsed);
          const sources = (await readFile(absPath(options.sources, global.cwd), 'utf8'))
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'));

          const browser = await launchChromium();
          let result: Awaited<ReturnType<typeof research>>;
          try {
            result = await research(browser, questions, sources);
          } finally {
            await browser.close();
          }

          const text = renderResearch(result);
          if (options.out !== undefined) {
            const path = absPath(options.out, global.cwd);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text, 'utf8');
          }

          emit(cmd, ok(result, [text]));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
          emit(cmd, fail({ error: message }, [message], code));
        }
      },
    );

  // --- bv report ----------------------------------------------------------
  program
    .command('report')
    .description('report what a run found, as Markdown or JSON')
    .argument('<runId>', 'the run to report on')
    .option('--format <format>', 'md or json', 'md')
    .option('--out <file>', 'write the report to this file')
    .action(async (runId: string, options: { format?: string; out?: string }, cmd: Command) => {
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
          format === 'json' ? renderReportsJson(reports) : renderFullReport(findings, reports);

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
    });

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
        emit(
          cmd,
          ok({ runId: id, entries }, lines.length > 0 ? lines : ['(the audit log is empty)']),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}

/**
 * Collect a repeatable option into an array.
 *
 * Commander passes `undefined` for `previous` on the first call, so the
 * default has to handle it.
 */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * Read the network facts of a run.
 */
async function readNetworkFacts(runId: string, cwd: string): Promise<ObservedRequest[]> {
  const path = `${runDir(runId, cwd)}/network.json`;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as ObservedRequest[];
  } catch {
    throw new UsageError(
      `the run ${runId} has no network log. Only a run made with the network watcher has one.`,
    );
  }
}

/**
 * Normalise the questions file.
 *
 * Both shapes are accepted: a list of strings, and a list of objects with
 * a `question` field.
 */
function normaliseQuestions(parsed: unknown): ResearchQuestion[] {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : undefined;

  if (list === undefined) {
    throw new UsageError('the questions file must be a list, or an object with a "questions" list');
  }

  return list.map((entry) => {
    if (typeof entry === 'string') return { question: entry };
    if (typeof entry === 'object' && entry !== null) {
      const question = (entry as { question?: unknown }).question;
      const id = (entry as { id?: unknown }).id;
      if (typeof question !== 'string') {
        throw new UsageError(
          'every question must be a string or an object with a "question" field',
        );
      }
      return {
        question,
        ...(typeof id === 'string' ? { id } : {}),
      };
    }
    throw new UsageError('every question must be a string or an object with a "question" field');
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
async function readAudit(runId: string, cwd: string): Promise<Record<string, unknown>[]> {
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
