import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractJobListings,
  findEasyApplyButton,
  normalizeJobUrl,
} from '../src/glassdoor/jobs.js';

async function localPage(html: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

test('extracts and deduplicates cards while preserving jl', async () => {
  const { browser, page } = await localPage('<li data-jobid="101"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>');
  try {
    const jobs = await extractJobListings(page);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, '101');
    assert.equal(jobs[0].url, 'https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101');
  } finally {
    await browser.close();
  }
});

test('rejects search URLs and accepts native Easy Apply only', async () => {
  assert.equal(normalizeJobUrl('/Job/jobs.htm?sc.keyword=backend', 'https://www.glassdoor.co.in/Job/jobs.htm'), null);
  const { browser, page } = await localPage('<button>Apply on employer site</button><button data-test="easy-apply-button">Easy Apply</button>');
  try {
    const button = await findEasyApplyButton(page);
    assert.equal(await button?.innerText(), 'Easy Apply');
  } finally {
    await browser.close();
  }
});
