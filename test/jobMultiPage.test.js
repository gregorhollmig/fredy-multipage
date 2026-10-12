/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The wiring of the one-time multi-page scan, from the button to the page loop.
 *
 * These are source assertions on purpose: the flow spans four UI components, an API route, the job
 * executor and the pipeline, and a unit test of any one of them would not notice a link going
 * missing. Changing the feature means changing these files together, and this is the test that says
 * so.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf-8');

const jobRouter = read('lib/api/routes/jobRouter.js');
const jobExecutionService = read('lib/services/jobs/jobExecutionService.js');
const pipeline = read('lib/FredyPipelineExecutioner.js');
const jobActions = read('ui/src/components/jobs/JobActions.jsx');
const jobGrid = read('ui/src/components/grid/jobs/JobGrid.jsx');
const jobsTable = read('ui/src/components/table/JobsTable.jsx');
const jobMutation = read('ui/src/views/jobs/mutation/JobMutation.jsx');

describe('the job page can trigger a one-time multi-page scan', () => {
  it('offers the action in the shared actions menu', () => {
    expect(jobActions).toMatch(/onMultiPageRun/);
    expect(jobActions).toMatch(/t\('jobs\.popoverMultiPage'\)/);
  });

  it('posts the flag for both views', () => {
    expect(jobGrid).toMatch(/multiPage \? \{ multiPage: true \} : \{\}/);
    expect(jobGrid).toMatch(/onMultiPageRun=\{\(id\) => onJobRun\(id, true\)\}/);
    expect(jobsTable).toMatch(/onMultiPageRun/);
  });

  it('reads the flag on the backend and emits it as a run', () => {
    expect(jobRouter).toMatch(/request\.body\?\.multiPage === true/);
    expect(jobRouter).toMatch(/bus\.emit\('jobs:runOne', \{ jobId, multiPage \}\)/);
  });
});

describe('saving a job can start a scan', () => {
  it('only when the form asked for it', () => {
    expect(jobMutation).toMatch(/multiPageAfterSave/);
    expect(jobRouter).toMatch(/multiPageAfterSave === true && savedJobId/);
    expect(jobRouter).toMatch(/bus\.emit\('jobs:runOne', \{ jobId: savedJobId, multiPage: true \}\)/);
  });
});

describe('a multi-page run walks pages and stores silently', () => {
  it('routes the flag into pipeline options', () => {
    expect(jobExecutionService).toMatch(/multiPagePipelineOptions\(\)/);
    expect(jobExecutionService).toMatch(/silent: true/);
  });

  it('collects across pages and skips the notification tail when silent', () => {
    expect(pipeline).toMatch(/collectAllPages\(/);
    expect(pipeline).toMatch(/_finalize/);
    expect(pipeline).toMatch(/if \(this\._silent\)/);
  });
});
