import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto('https://github.com/OMD-123/browser-verified-skill', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(4000);

// Does GitHub's own file viewer render a player for the mp4?
const blob = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await blob.goto(
  'https://github.com/OMD-123/browser-verified-skill/blob/main/docs/agent-demo.mp4',
  { waitUntil: 'domcontentloaded' },
);
await blob.waitForTimeout(5000);
const blobVideos = await blob.evaluate(() =>
  Array.from(document.querySelectorAll('video')).map((v) => ({
    src: v.getAttribute('src'),
    w: v.clientWidth,
    h: v.clientHeight,
    controls: v.hasAttribute('controls'),
  })),
);
console.log('the blob viewer video elements:', JSON.stringify(blobVideos));
await blob.screenshot({ path: 'C:/Users/omd44/gh-blob.png' });
await blob.close();

const videos = await page.evaluate(() => {
  const list = Array.from(document.querySelectorAll('video'));
  return list.map((v) => ({
    src: v.getAttribute('src'),
    poster: v.getAttribute('poster'),
    width: v.clientWidth,
    height: v.clientHeight,
    hasControls: v.hasAttribute('controls'),
  }));
});

console.log('the README video players:', JSON.stringify(videos, null, 2));

// Does the image syntax with an mp4 extension render a player?
const md = await page.evaluate(async () => {
  const raw = await fetch(
    'https://api.github.com/repos/OMD-123/browser-verified-skill/readme',
    { headers: { Accept: 'application/vnd.github.raw' } },
  ).then((r) => r.text());
  return raw.includes('![') ? 'has image syntax' : 'no image syntax';
});
console.log('the readme markdown:', md);

// What did GitHub actually render in that section?
const section = await page.evaluate(() => {
  const h = Array.from(document.querySelectorAll('h2')).find((x) =>
    (x.textContent || '').includes('The demo'),
  );
  if (!h) return 'no heading';
  const out = [];
  let node = h.parentElement ? h.parentElement.nextElementSibling : null;
  while (node && out.length < 4) {
    out.push(node.tagName + ': ' + (node.textContent || '').slice(0, 120));
    node = node.nextElementSibling;
  }
  // Also: any element that mentions the mp4.
  const mentions = Array.from(document.querySelectorAll('a,img,video,p'))
    .filter((e) => (e.outerHTML || '').includes('demo.mp4'))
    .map((e) => e.tagName + ' -> ' + e.outerHTML.slice(0, 160));
  return { siblings: out, mentions };
});
console.log('THE SECTION:', JSON.stringify(section, null, 2).slice(0, 1800));

// Scroll to the first video and take a screenshot.
const first = page.locator('video').first();
if ((await first.count()) > 0) {
  await first.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'C:/Users/omd44/gh-readme-video.png' });
  console.log('screenshot written');
}

await browser.close();
