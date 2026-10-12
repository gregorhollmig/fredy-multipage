/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * One-time multi-page scanning.
 *
 * Fredy reads exactly one result page per provider per run - `FredyPipelineExecutioner` asks each
 * provider's `getListings`/extractor for a single URL. That is the right default (the newest
 * listings are on page one, and a run should stay cheap), but it means an existing search that has
 * hundreds of active results only ever surfaces the first page's worth. This module is the escape
 * hatch: given a provider run URL it walks subsequent pages and hands back the concatenation.
 *
 * It is opt-in per run (a "multi-page" run triggered from the job page), never the scheduled path.
 *
 * A page parameter is not something Fredy can ask a portal for generically - the query string is
 * the portal's own. So each portal that can be paged is named here with the parameter it uses.
 * Where a portal cannot be paged (its result list is a "load more" widget, not a numbered set) it
 * is simply absent, and a multi-page run degrades to the single page it would have fetched anyway.
 */

import logger from '../logger.js';

/**
 * Portals whose result pages are reachable by adding a page number to the search URL.
 *
 * `param` is the query parameter the portal itself uses to select a page. `pageSizeParam`/`pageSize`
 * are only set for an API that lets us ask for a larger page (fewer round trips for the same
 * coverage); a portal without them serves whatever page size it serves.
 *
 * Every name here is read off the portal's own result page; a wrong one is not fatal - the walk
 * stops as soon as a page contributes nothing new, see {@link collectAllPages}.
 *
 * A portal that does not page with a query parameter sets `pageUrl` instead: a function returning
 * the URL of page N (kleinanzeigen addresses pages in the path). `delayMs`, where set, overrides
 * the run's pause between this portal's pages - for a portal whose bot wall reacts to request rate
 * rather than to the search itself.
 *
 * @type {Record<string, {param?: string, pageSizeParam?: string, pageSize?: number, delayMs?: number, pageUrl?: (url: string, page: number) => string}>}
 */
export const MULTIPAGE_PROVIDERS = {
  // The mobile API selects the page with `pagenumber` and caps a page at 100 (`pagesize`).
  immoscout: { param: 'pagenumber', pageSizeParam: 'pagesize', pageSize: 100 },
  // immowelt's search BFF takes a page in its criteria, and answers 403 (DataDome) when the
  // requests arrive in a tight burst - hence the longer pause between its pages.
  immowelt: { param: 'page', delayMs: 3000 },
  engelVoelkers: { param: 'page' },
  // Kleinanzeigen pages in the path (`/s-<category>/seite:N/...`); see {@link kleinanzeigenPageUrl}.
  kleinanzeigen: { pageUrl: kleinanzeigenPageUrl },
  sparkasse: { param: 'page' },
  immoswp: { param: 'page' },
  regionalimmobilien24: { param: 'page' },
};

/**
 * The URL of one Kleinanzeigen result page.
 *
 * Kleinanzeigen addresses pages in the path, not the query string: the pager on a result page links
 * to `/s-wohnung-mieten/seite:2/c203`. A `?page=` parameter is accepted but ignored - it serves page
 * one again - so a query-parameter descriptor could never walk past the first page of this portal,
 * which carries a large share of the listings.
 *
 * The segment goes right after the category (`/s-<category>/`), before the location and filters, so
 * that everything the job configured is preserved. Page one is the URL untouched: the portal's own
 * first page has no `/seite:1/`.
 *
 * @param {string} url
 * @param {number} page
 * @returns {string}
 */
function kleinanzeigenPageUrl(url, page) {
  if (page <= 1) return url;
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return url;
  const firstSlash = url.indexOf('/', schemeEnd + 3);
  if (firstSlash < 0) return url;
  const secondSlash = url.indexOf('/', firstSlash + 1);
  if (secondSlash < 0) return url; // no category segment to insert the page after
  return `${url.slice(0, secondSlash)}/seite:${page}${url.slice(secondSlash)}`;
}

/** A generous default cap; only the one-time backfill ever reaches for it. */
export const DEFAULT_MULTIPAGE_MAX_PAGES = 25;

/** Pause between two page requests, so a deep scan does not present as a burst. */
export const DEFAULT_MULTIPAGE_DELAY_MS = 350;

/**
 * Whether a multi-page run can do more than a normal one for this provider.
 *
 * @param {string} providerId
 * @returns {boolean}
 */
export function supportsMultiPage(providerId) {
  return Object.prototype.hasOwnProperty.call(MULTIPAGE_PROVIDERS, providerId);
}

/**
 * The pagination descriptor for a provider, or null when it cannot be paged.
 *
 * @param {string} providerId
 * @returns {{param?: string, pageSizeParam?: string, pageSize?: number, delayMs?: number, pageUrl?: (url: string, page: number) => string}|null}
 */
export function descriptorFor(providerId) {
  return MULTIPAGE_PROVIDERS[providerId] ?? null;
}

/**
 * Build the URL of one result page from the run's base URL.
 *
 * The base URL already carries the job's filters and Fredy's injected sort parameter (it is the
 * output of `queryStringMutator`), so only the page is touched. A portal that pages in the path
 * supplies its own `pageUrl`; otherwise the page is set as a query parameter. Page one is returned
 * unchanged apart from the parameter, so a portal that is indifferent to `page=1` behaves exactly
 * as it did before the feature existed.
 *
 * @param {string} url The run's URL.
 * @param {number} page 1-based page number.
 * @param {{param?: string, pageSizeParam?: string, pageSize?: number, delayMs?: number, pageUrl?: (url: string, page: number) => string}} [descriptor]
 * @returns {string}
 */
export function buildPageUrl(url, page, descriptor = {}) {
  if (typeof descriptor.pageUrl === 'function') {
    return descriptor.pageUrl(url, page);
  }
  const target = new URL(url);
  target.searchParams.set(descriptor.param ?? 'page', String(page));
  if (descriptor.pageSizeParam && descriptor.pageSize) {
    target.searchParams.set(descriptor.pageSizeParam, String(descriptor.pageSize));
  }
  return target.toString();
}

/**
 * A stable identity for a raw listing, used to tell "a page added something" from "the portal
 * served the same page again".
 *
 * The raw shapes differ per provider, so this looks at the fields every one of them carries: a
 * link, or an id. A value carrying neither falls back to its JSON, which is still stable enough to
 * detect a repeated page.
 *
 * @param {any} item
 * @returns {string}
 */
function defaultKeyOf(item) {
  if (item == null) return 'null';
  const key = item.link ?? item.url ?? item.href ?? item.id;
  return key == null ? JSON.stringify(item) : String(key);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk a provider's result pages and return every raw listing, in page order and de-duplicated.
 *
 * Stops at whichever comes first:
 * - a page that yields nothing,
 * - a page that contributes no listing not already seen (this is also what makes a wrong or
 *   unsupported page parameter safe: the portal repeats page one, and the walk ends),
 * - `maxPages`.
 *
 * The caller owns the actual fetch, so this stays provider-agnostic: the pipeline passes a
 * `fetchPage` that calls the provider's `getListings` or the shared extractor.
 *
 * @param {Object} params
 * @param {string} params.url Base run URL.
 * @param {{param?: string, pageSizeParam?: string, pageSize?: number, delayMs?: number, pageUrl?: (url: string, page: number) => string}} params.descriptor
 * @param {(url: string) => Promise<any[]>} params.fetchPage Fetches one page's raw listings.
 * @param {number} [params.maxPages]
 * @param {number} [params.delayMs]
 * @param {(item: any) => string} [params.keyOf]
 * @param {string} [params.providerId] For log lines only.
 * @returns {Promise<any[]>}
 */
export async function collectAllPages({
  url,
  descriptor,
  fetchPage,
  maxPages = DEFAULT_MULTIPAGE_MAX_PAGES,
  delayMs = DEFAULT_MULTIPAGE_DELAY_MS,
  keyOf = defaultKeyOf,
  providerId = null,
}) {
  const seen = new Set();
  const collected = [];
  const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : DEFAULT_MULTIPAGE_MAX_PAGES;
  // A portal may ask for a longer pause than the run's default (a rate-sensitive bot wall), so its
  // own value wins where it declares one.
  const pauseMs = Number.isFinite(descriptor?.delayMs) ? descriptor.delayMs : delayMs;

  for (let page = 1; page <= pageLimit; page += 1) {
    const pageUrl = buildPageUrl(url, page, descriptor);
    let items;
    try {
      items = await fetchPage(pageUrl);
    } catch (error) {
      // A deep page that fails (a bot wall, a 4xx) must not throw the whole import away: the pages
      // already collected are still worth storing, and the next run can try again.
      logger.warn(
        `Multi-page scan stopped at page ${page}${providerId ? ` (Provider: '${providerId}')` : ''}:`,
        error?.message || error,
      );
      break;
    }

    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    let added = 0;
    for (const item of items) {
      const key = keyOf(item) ?? JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      added += 1;
    }

    // The portal served a page we have already seen in full. Either the search has no more pages,
    // or the page parameter is not the one this portal understands; both mean stop.
    if (added === 0) {
      break;
    }

    if (page < pageLimit && pauseMs > 0) {
      await sleep(pauseMs);
    }
  }

  logger.debug(
    `Multi-page scan collected ${collected.length} raw listing(s)` +
      `${providerId ? ` (Provider: '${providerId}')` : ''}`,
  );
  return collected;
}

/**
 * The pipeline options for a one-time multi-page import.
 *
 * Reads an environment override so an operator can widen the cap without a code change; the
 * defaults are deliberately small, because this is a manual gesture and the normal scheduled run
 * never uses it.
 *
 * @returns {{pagination: {maxPages: number, delayMs: number}}}
 */
export function multiPagePipelineOptions() {
  const maxPages = Number(process.env.FREDY_MULTIPAGE_MAX_PAGES);
  const delayMs = Number(process.env.FREDY_MULTIPAGE_DELAY_MS);
  return {
    pagination: {
      maxPages: Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : DEFAULT_MULTIPAGE_MAX_PAGES,
      delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_MULTIPAGE_DELAY_MS,
    },
  };
}
