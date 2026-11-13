/**
 * The demo pages.
 *
 * GitHub will not play a video in a README. It strips a `<video>` tag
 * and renders an empty paragraph, and an mp4 through the image syntax
 * is a broken image.
 *
 * So the README shows a poster image that links to the video, and the
 * video is served from GitHub Pages -- which serves an mp4 as
 * `video/mp4` with range support, so a browser plays it.
 *
 * This module owns the page that holds them, so the README and the
 * page cannot drift.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder the page is published from. */
export function pagesRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..', 'docs'), resolve(here, '..', '..', '..', 'docs')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), 'docs');
}

/** The videos the page shows. */
export const PAGE_VIDEOS = [
  {
    file: 'agent-demo.mp4',
    poster: 'agent-demo-poster.jpg',
    title: 'The agent demo',
    blurb:
      'Hermes, given a repo link and a task, installs the skill, fills a form, ' +
      'gets a human approval for the submit, and then meets a prompt-injection ' +
      'payload -- and does not work around the refusal.',
  },
  {
    file: 'demo.mp4',
    poster: 'demo-poster.jpg',
    title: 'The tool demo',
    blurb:
      'A real run of the CLI: the injection block, the agent that cannot approve ' +
      'its own action, the tainted value, the human approval, the verification, ' +
      'and the run compiled into a plain Playwright script.',
  },
] as const;

/**
 * The page.
 *
 * A real `<video>` element, because this is a web page and not a README:
 * a browser plays an mp4 from the same origin without a download
 * dialog.
 */
export function renderPage(): string {
  const sections = PAGE_VIDEOS.map((video) => {
    const exists = existsSync(resolve(pagesRoot(), video.file));
    const poster = existsSync(resolve(pagesRoot(), video.poster))
      ? ` poster="${video.poster}"`
      : '';

    return `    <section class="video">
      <h2>${video.title}</h2>
      <p class="blurb">${video.blurb}</p>
      <video controls preload="metadata"${poster} width="960">
        <source src="${video.file}" type="video/mp4" />
        <p>
          Your browser cannot play this video.
          <a href="${video.file}">Download it</a> instead.
        </p>
      </video>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>browser-verified-skill — the demos</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #12141a;
        --panel: #1a1d25;
        --fg: #d0d6e0;
        --dim: #8a929e;
        --accent: #56b6c2;
      }
      body {
        margin: 0;
        padding: 3rem 1.5rem;
        background: var(--bg);
        color: var(--fg);
        font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      main { max-width: 60rem; margin: 0 auto; }
      h1 { font-size: 1.9rem; margin: 0 0 0.4rem; }
      h2 { font-size: 1.25rem; margin: 0 0 0.35rem; }
      p.lede { color: var(--dim); margin: 0 0 2.5rem; }
      .video {
        background: var(--panel);
        border: 1px solid #262a34;
        border-radius: 10px;
        padding: 1.25rem;
        margin-bottom: 2rem;
      }
      .blurb { color: var(--dim); margin: 0 0 1rem; }
      video { width: 100%; height: auto; border-radius: 6px; background: #000; display: block; }
      a { color: var(--accent); }
      code {
        background: var(--panel);
        padding: 0.15em 0.4em;
        border-radius: 4px;
        font-size: 0.9em;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>browser-verified-skill</h1>
      <p class="lede">
        Two real runs against a local fixture site. Nothing is mocked. The
        refusals are the content: a tool that cannot be stopped from doing
        something unsafe is not a tool an agent can be trusted with.
      </p>

${sections}

      <p class="lede">
        The repository is at
        <a href="https://github.com/OMD-123/browser-verified-skill">OMD-123/browser-verified-skill</a>.
        Run the demo yourself with <code>npm run demo</code>.
      </p>
    </main>
  </body>
</html>
`;
}
