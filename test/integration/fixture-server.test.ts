import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';

describe('fixture server', () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({ port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the login page', async () => {
    const res = await fetch(server.url('/pages/login.html'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sign in');
    expect(body).toContain('data-testid="submit"');
  });

  it('serves robots.txt with a disallowed path', async () => {
    const res = await fetch(server.url('/robots.txt'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /private');
  });

  it('serves the paginated rows API', async () => {
    const res = await fetch(server.url('/api/rows?page=1'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; rows: unknown[] };
    expect(data.total).toBe(37);
    expect(data.rows).toHaveLength(10);
  });

  it('returns 429 on every third rate-limited request', async () => {
    const fresh = await startFixtureServer({ port: 0 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(fresh.url('/api/rate-limited'));
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await fresh.close();
    }
  });

  it('serves the download endpoint with a content-disposition header', async () => {
    const res = await fetch(server.url('/download/report.csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('id,name,value');
  });

  it('returns 404 for an unknown fixture', async () => {
    const res = await fetch(server.url('/pages/does-not-exist.html'));
    expect(res.status).toBe(404);
  });

  it('refuses path traversal outside the pages directory', async () => {
    const res = await fetch(server.url('/pages/..%2f..%2fpackage.json'));
    // Either the traversal is rejected outright or it 404s; it must never
    // return the contents of a file outside the pages directory.
    const body = await res.text();
    expect(body).not.toContain('browser-verified-skill');
  });

  it('serves the staging/prod pair with an intentional difference', async () => {
    const prod = await (await fetch(server.url('/prod'))).text();
    const staging = await (await fetch(server.url('/staging'))).text();
    expect(prod).toContain('data-testid="promo"');
    expect(staging).not.toContain('data-testid="promo"');
    expect(prod).not.toBe(staging);
  });

  it('records requests', async () => {
    await fetch(server.url('/pages/login.html'));
    expect(server.requests.some((r) => r.path === '/pages/login.html')).toBe(true);
  });
});
