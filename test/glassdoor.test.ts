import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractJobListings,
  findEasyApplyButton,
  normalizeJobUrl,
  isCloudflareBlocked,
  isAlreadyApplied,
  getJobMeta,
} from '../src/glassdoor/jobs.js';

async function localPage(html: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

test('extracts cards with data-jobid and deduplicates by URL', async () => {
  const html = `
    <li data-jobid="101"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>
    <li data-jobid="102"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>
  `;
  const { browser, page } = await localPage(html);
  try {
    const jobs = await extractJobListings(page);
    assert.equal(jobs.length, 1, 'should deduplicate identical URLs');
    assert.equal(jobs[0].jobId, '101');
    assert.equal(jobs[0].url, 'https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101');
  } finally {
    await browser.close();
  }
});

test('extracts cards with class fallback when data-jobid missing', async () => {
  const html = `<li class="JobCard_jobCard__123"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/frontend-JV_IC2.htm?jl=202">Frontend Dev</a><div data-test="employer-name">Beta Corp</div><div data-test="emp-location">Mumbai</div></li>`;
  const { browser, page } = await localPage(html);
  try {
    const jobs = await extractJobListings(page);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Frontend Dev');
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

test('rejects external and Indeed buttons', async () => {
  const html = `
    <button>Apply on company site</button>
    <button>Apply on Indeed</button>
    <button>Apply on employer site</button>
  `;
  const { browser, page } = await localPage(html);
  try {
    const button = await findEasyApplyButton(page);
    assert.equal(button, null, 'should reject external application buttons');
  } finally {
    await browser.close();
  }
});

test('detects Cloudflare block by title', async () => {
  const { browser, page } = await localPage('<title>Security Check - Glassdoor</title>');
  try {
    assert.equal(await isCloudflareBlocked(page), true);
  } finally {
    await browser.close();
  }
});

test('detects Cloudflare block by URL token', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.glassdoor.co.in/?__cf_chl_tk=abc123');
    assert.equal(await isCloudflareBlocked(page), true);
  } finally {
    await browser.close();
  }
});

test('detects already applied state in main', async () => {
  const html = `<main><button>Applied</button></main>`;
  const { browser, page } = await localPage(html);
  try {
    assert.equal(await isAlreadyApplied(page), true);
  } finally {
    await browser.close();
  }
});

test('extracts job meta from title and heading', async () => {
  const html = `<title>Software Engineer at TechCorp</title><h1>Senior Backend Engineer</h1>`;
  const { browser, page } = await localPage(html);
  try {
    const meta = await getJobMeta(page);
    assert.equal(meta.role, 'Senior Backend Engineer');
    assert.equal(meta.company, 'TechCorp');
  } finally {
    await browser.close();
  }
});
