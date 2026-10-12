/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';
import * as mockNotification from './mocks/mockNotification.js';

/**
 * The one-time multi-page run: it walks a provider's result pages, stores what it finds, and - when
 * silent, as the job page's deep scan is - does not notify. A normal run must stay exactly one page.
 */

/**
 * A provider whose result pages are keyed by the `page` query parameter (immoswp's shape).
 *
 * @param {any[][]} pages One array of raw listings per page.
 * @returns {Object}
 */
function configFor(pages) {
  const calls = [];
  return {
    calls,
    url: 'http://example.com/search?city=x',
    sortByDateParam: null,
    getListings: (url) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      calls.push(page);
      return Promise.resolve(pages[page - 1] ?? []);
    },
    normalize: (l) => l,
    filter: () => true,
    requiredFieldNames: ['id', 'title', 'link'],
  };
}

const listing = (n) => ({ id: `l${n}`, title: `Listing ${n}`, link: `http://example.com/${n}` });
const job = { id: 'test-job', notificationAdapter: null, specFilter: null, spatialFilter: null, commuteFilter: null };
const cache = { checkAndAddEntry: () => false };

/**
 * @param {Object} config
 * @param {Object} [options]
 * @param {string} [providerId]
 * @returns {Promise<Object>} The provider config, for its recorded page calls.
 */
async function run(config, options = {}, providerId = 'immoswp') {
  const Fredy = await mockFredy();
  const fredy = new Fredy(config, job, providerId, cache, undefined, options);
  try {
    await fredy.execute();
  } catch {
    // NoNewListingsWarning is control flow, not a failure.
  }
  return config;
}

beforeEach(() => {
  mockStore.resetListings();
  mockNotification.reset();
});

describe('a normal run', () => {
  it('asks for exactly one page, as it always did', async () => {
    const config = configFor([[listing(1), listing(2)], [listing(3)]]);
    await run(config);
    expect(config.calls).toEqual([1]);
    expect(mockStore.getKnownListingHashesForJobAndProvider(job.id, 'immoswp')).toHaveLength(2);
  });
});

describe('a multi-page run', () => {
  it('walks every page and stores the listings from all of them', async () => {
    const config = configFor([[listing(1)], [listing(2)], [listing(3)]]);
    await run(config, { pagination: { maxPages: 5, delayMs: 0 } });
    // Page four is empty, which is what stops the walk.
    expect(config.calls).toEqual([1, 2, 3, 4]);
    expect(mockStore.getKnownListingHashesForJobAndProvider(job.id, 'immoswp')).toHaveLength(3);
  });

  it('does not notify when the run is silent', async () => {
    const config = configFor([[listing(1)], [listing(2)], []]);
    await run(config, { pagination: { maxPages: 5, delayMs: 0 }, silent: true });
    expect(mockNotification.get()).toEqual({});
  });

  it('still notifies when the run is not silent', async () => {
    const config = configFor([[listing(1)], [listing(2)], []]);
    await run(config, { pagination: { maxPages: 5, delayMs: 0 }, silent: false });
    expect(mockNotification.get().payload).toHaveLength(2);
  });

  it('degrades to one page for a provider with no page parameter', async () => {
    const config = configFor([[listing(1)], [listing(2)]]);
    await run(config, { pagination: { maxPages: 5, delayMs: 0 } }, 'ohneMakler');
    // The base url is fetched as-is; no page parameter is invented for a portal we cannot page.
    expect(config.calls).toEqual([1]);
  });
});
