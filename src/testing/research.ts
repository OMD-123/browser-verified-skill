/**
 * The research module (M26).
 *
 * `bv research --questions q.json --sources urls.txt` answers a set of
 * questions from a set of sources, **in the browser**.
 *
 * Why in the browser: a page is often the only place the answer is written.
 * A JSON API behind it, an image with the numbers on it, a table that only
 * renders with JavaScript. The tool reads the page the way a person does.
 *
 * The rules that matter:
 *
 *  1. **Every answer cites its source.** An answer without a citation is
 *     not reported.
 *  2. **Only the given sources are read.** The tool does not follow links
 *     out to the open web, because a research tool that wanders is a
 *     research tool that cannot be trusted.
 *  3. **Nothing is written back.** Research is read-only. There is no
 *     form filling, no clicking "submit", no logging in.
 */
import type { Browser, Page } from 'playwright';

/** One question to answer. */
export interface ResearchQuestion {
  /** The question. */
  question: string;
  /** The id, when the questions file has one. */
  id?: string;
}

/** The answer to one question. */
export interface ResearchAnswer {
  /** The question. */
  question: string;
  /** The answer, or null when the sources did not answer it. */
  answer: string | null;
  /** Where the answer came from. */
  citation?: { url: string; snippet: string };
  /** The sources that were read. */
  sourcesRead: string[];
  /** How confident the extractor is, from 0 to 1. */
  confidence: number;
}

/** The result of a research run. */
export interface ResearchResult {
  /** The answers. */
  answers: ResearchAnswer[];
  /** The sources that were read. */
  sourcesRead: string[];
  /** The sources that could not be read. */
  sourcesFailed: string[];
}

/**
 * The maximum number of characters extracted from one page.
 *
 * A page can be megabytes. The extractor only needs enough to answer the
 * questions, and a bounded extract keeps the cost and the context
 * predictable.
 */
export const MAX_EXTRACT_CHARS = 40_000;

/**
 * Extract the readable text of a page.
 *
 * The extraction is deliberately simple: the visible text, minus the
 * scripts and the styles. It is not a readability algorithm, because a
 * readability algorithm would silently drop content and the citation would
 * then point at something that is not there.
 */
export async function extractText(page: Page): Promise<string> {
  const text = await page
    .evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const element of Array.from(clone.querySelectorAll('script, style, noscript'))) {
        element.remove();
      }
      return (clone.innerText ?? clone.textContent ?? '').replace(/\n{3,}/g, '\n\n');
    })
    .catch(() => '');

  return text.slice(0, MAX_EXTRACT_CHARS);
}

/**
 * Find the sentence in a text that best answers a question.
 *
 * The scoring is simple on purpose: the sentences that share the most
 * words with the question win. A simple, explainable score is better
 * than a clever one that cannot be argued with.
 */
export function bestSentence(text: string, question: string): { sentence: string; score: number } {
  const questionWords = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20 && sentence.length < 600);

  let best = { sentence: '', score: 0 };

  for (const sentence of sentences) {
    const words = sentence.toLowerCase().split(/[^a-z0-9]+/);
    let score = 0;
    for (const word of words) {
      if (questionWords.has(word)) score += 1;
    }
    // A sentence that shares no words with the question is not an answer.
    if (score > best.score) best = { sentence, score };
  }

  return best;
}

/**
 * Answer the questions from the sources.
 *
 * Each source is read once, and every question is answered against every
 * source, so the best answer across all of them wins.
 */
export async function research(
  browser: Browser,
  questions: readonly ResearchQuestion[],
  sources: readonly string[],
): Promise<ResearchResult> {
  const context = await browser.newContext();
  const page = await context.newPage();

  const sourcesRead: string[] = [];
  const sourcesFailed: string[] = [];
  const texts = new Map<string, string>();

  try {
    for (const source of sources) {
      try {
        await page.goto(source, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const text = await extractText(page);
        texts.set(source, text);
        sourcesRead.push(source);
      } catch {
        sourcesFailed.push(source);
      }
    }

    const answers: ResearchAnswer[] = [];

    for (const question of questions) {
      let best: ResearchAnswer = {
        question: question.question,
        answer: null,
        sourcesRead: [],
        confidence: 0,
      };

      for (const [source, text] of texts) {
        const candidate = bestSentence(text, question.question);
        if (candidate.score === 0) continue;

        // The confidence is the share of the question's words the sentence
        // contains. It is a ratio, not a probability.
        const questionWords = question.question
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 2);
        const confidence = questionWords.length === 0 ? 0 : candidate.score / questionWords.length;

        if (confidence > best.confidence) {
          best = {
            question: question.question,
            answer: candidate.sentence,
            citation: { url: source, snippet: candidate.sentence.slice(0, 300) },
            sourcesRead: [source],
            confidence,
          };
        }
      }

      // Every source that was read is listed, so the reader knows what was
      // consulted even when none of it answered the question.
      best.sourcesRead = [...texts.keys()];
      answers.push(best);
    }

    return { answers, sourcesRead, sourcesFailed };
  } finally {
    await context.close();
  }
}

/**
 * Render the research result.
 *
 * An unanswered question is shown as unanswered, with the sources that
 * were consulted. It is not omitted: "we looked and found nothing" is
 * information.
 */
export function renderResearch(result: ResearchResult): string {
  const lines: string[] = [];
  lines.push(
    `Read ${result.sourcesRead.length} source(s)` +
      (result.sourcesFailed.length > 0 ? `, ${result.sourcesFailed.length} failed` : '') +
      '.',
  );
  lines.push('');

  for (const answer of result.answers) {
    lines.push(`Q: ${answer.question}`);
    if (answer.answer === null) {
      lines.push('A: not answered by the sources');
    } else {
      lines.push(`A: ${answer.answer}`);
      if (answer.citation !== undefined) {
        lines.push(`   (${answer.citation.url})`);
      }
      lines.push(`   confidence ${(answer.confidence * 100).toFixed(0)}%`);
    }
    lines.push('');
  }

  if (result.sourcesFailed.length > 0) {
    lines.push('Sources that could not be read:');
    for (const source of result.sourcesFailed) lines.push(`  ${source}`);
  }

  return lines.join('\n');
}
