/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MULTIPAGE_PROVIDERS,
  DEFAULT_MULTIPAGE_MAX_PAGES,
  buildPageUrl,
  collectAllPages,
  descriptorFor,
  multiPagePipelineOptions,
  supportsMultiPage,
} from '../../lib/services/pagination/paginationService.js';

describe('provider descriptors', () => {
  it('knows the portals whose result pages can be addressed directly', () => {
    expect(supportsMultiPage('immoscout')).toBe(true);
    expect(supportsMultiPage('immoswp')).toBe(true);
    expect(descriptorFor('immoscout')).toMatchObject({ param: 'pagenumber', pageSizeParam: 'pagesize' });
    // A portal without an entry (a "load more" widget, say) must answer false rather than guess a
    // parameter that would silently repeat page one.
    expect(supportsMultiPage('ohneMakler')).toBe(false);
    expect(descriptorFor('ohneMakler')).toBeNull();
  });

  it('names a way to address the next page for every portal it claims to page', () => {
    for (const [id, descriptor] of Object.entries(MULTIPAGE_PROVIDERS)) {
      const hasParam = typeof descriptor.param === 'string' && descriptor.param.length > 0;
      const hasBuilder = typeof descriptor.pageUrl === 'function';
      expect(hasParam || hasBuilder, id).toBe(true);
    }
  });

  it('slows immowelt down, whose search answers 403 when hit in a burst', () => {
    expect(descriptorFor('immowelt').delayMs).toBeGreaterThanOrEqual(1000);
  });
});

describe('buildPageUrl', () => {
  it('sets the page parameter without dropping the search filters', () => {
    const url = buildPageUrl('https://immo.swp.de/mieten/reutlingen?pf=500&pt=1200&page=1', 3, { param: 'page' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('page')).toBe('3');
    expect(parsed.searchParams.get('pf')).toBe('500');
    expect(parsed.searchParams.get('pt')).toBe('1200');
  });

  it('adds the page-size parameter when the portal supports it', () => {
    const url = buildPageUrl('https://api.mobile.immobilienscout24.de/search/list?x=1', 2, {
      param: 'pagenumber',
      pageSizeParam: 'pagesize',
      pageSize: 100,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('pagenumber')).toBe('2');
    expect(parsed.searchParams.get('pagesize')).toBe('100');
  });

  it('pages kleinanzeigen in the path, keeping the job filters intact', () => {
    const url =
      'https://www.kleinanzeigen.de/s-wohnung-mieten/karlsruhe/preis::1500/c203l9186r30+wohnung_mieten.qm_d:80%2C+wohnung_mieten.zimmer_d:3%2C';
    const descriptor = descriptorFor('kleinanzeigen');

    // Page one is the URL untouched: the portal's own first page carries no `/seite:1/`.
    expect(buildPageUrl(url, 1, descriptor)).toBe(url);

    // Page N inserts the segment right after the category, before the location and the filters.
    expect(buildPageUrl(url, 2, descriptor)).toBe(
      'https://www.kleinanzeigen.de/s-wohnung-mieten/seite:2/karlsruhe/preis::1500/c203l9186r30+wohnung_mieten.qm_d:80%2C+wohnung_mieten.zimmer_d:3%2C',
    );
  });

  it('leaves a URL with no path alone rather than inventing a segment', () => {
    const descriptor = descriptorFor('kleinanzeigen');
    expect(buildPageUrl('https://www.kleinanzeigen.de/', 2, descriptor)).toBe('https://www.kleinanzeigen.de/');
  });
});

describe('collectAllPages', () => {
  const descriptor = { param: 'page' };
  const item = (id) => ({ id, link: `http://x/${id}` });

  it('walks pages in order and concatenates them', async () => {
    const pages = [[item('a'), item('b')], [item('c')], []];
    const seen = [];
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      delayMs: 0,
      fetchPage: async (url) => {
        seen.push(new URL(url).searchParams.get('page'));
        return pages[Number(new URL(url).searchParams.get('page')) - 1];
      },
    });
    expect(seen).toEqual(['1', '2', '3']);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('uses a provider page builder when it has one (kleinanzeigen)', async () => {
    const kl = descriptorFor('kleinanzeigen');
    const seen = [];
    const result = await collectAllPages({
      url: 'https://www.kleinanzeigen.de/s-wohnung-mieten/karlsruhe/c203',
      descriptor: kl,
      delayMs: 0,
      fetchPage: async (url) => {
        seen.push(url);
        return url.includes('/seite:2/') ? [] : [item('a')];
      },
    });
    expect(seen[0]).toBe('https://www.kleinanzeigen.de/s-wohnung-mieten/karlsruhe/c203');
    expect(seen[1]).toBe('https://www.kleinanzeigen.de/s-wohnung-mieten/seite:2/karlsruhe/c203');
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('lets the descriptor override the pause between pages', async () => {
    vi.useFakeTimers();
    try {
      const times = [];
      const pending = collectAllPages({
        url: 'http://x/search',
        descriptor: { param: 'page', delayMs: 5000 },
        maxPages: 2,
        delayMs: 10,
        fetchPage: async (url) => {
          times.push(Date.now());
          const page = Number(new URL(url).searchParams.get('page'));
          return [item('p' + page)];
        },
      });
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      expect(times).toHaveLength(2);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when a page repeats itself, so a wrong parameter is not an endless loop', async () => {
    const page1 = [item('a'), item('b')];
    const calls = [];
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      delayMs: 0,
      fetchPage: async (url) => {
        calls.push(new URL(url).searchParams.get('page'));
        // A portal that ignores the parameter answers page one every time.
        return page1;
      },
    });
    expect(calls).toEqual(['1', '2']);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('never exceeds maxPages', async () => {
    const calls = [];
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      maxPages: 3,
      delayMs: 0,
      fetchPage: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        calls.push(page);
        return [item(`p${page}`)];
      },
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(result).toHaveLength(3);
  });

  it('keeps the pages it already has when a later fetch fails', async () => {
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      delayMs: 0,
      fetchPage: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 3) throw new Error('403');
        return [item(`p${page}`)];
      },
    });
    expect(result.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('de-duplicates within a page as well as across pages', async () => {
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      delayMs: 0,
      fetchPage: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        return page === 1 ? [item('a'), item('a'), item('b')] : [];
      },
    });
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('falls back to the default page cap when given a nonsensical one', async () => {
    const calls = [];
    const result = await collectAllPages({
      url: 'http://x/search',
      descriptor,
      maxPages: 0,
      delayMs: 0,
      fetchPage: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        calls.push(page);
        return [item(`p${page}`)];
      },
    });
    expect(calls).toHaveLength(DEFAULT_MULTIPAGE_MAX_PAGES);
    expect(result).toHaveLength(DEFAULT_MULTIPAGE_MAX_PAGES);
  });
});

describe('multiPagePipelineOptions', () => {
  it('falls back to the documented defaults', () => {
    vi.stubEnv('FREDY_MULTIPAGE_MAX_PAGES', '');
    vi.stubEnv('FREDY_MULTIPAGE_DELAY_MS', '');
    const options = multiPagePipelineOptions();
    expect(options.pagination.maxPages).toBe(DEFAULT_MULTIPAGE_MAX_PAGES);
    vi.unstubAllEnvs();
  });

  it('honours an environment override', () => {
    vi.stubEnv('FREDY_MULTIPAGE_MAX_PAGES', '7');
    vi.stubEnv('FREDY_MULTIPAGE_DELAY_MS', '0');
    const options = multiPagePipelineOptions();
    expect(options.pagination).toEqual({ maxPages: 7, delayMs: 0 });
    vi.unstubAllEnvs();
  });
});
