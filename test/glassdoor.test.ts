import assert from 'node:assert/strict';
import { access, rmdir } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { getApplicationFailureResult, parseMaxPages } from '../src/glassdoor/index.js';
import {
  extractJobListings,
  findEasyApplyButton,
  normalizeJobUrl,
  isCloudflareBlocked,
  isAlreadyApplied,
  getJobMeta,
} from '../src/glassdoor/jobs.js';
import {
  hasCaptcha,
  hasGlassdoorRateLimit,
  hasMandatoryAdditionalFields,
  isExternalApplication,
  openApplication,
  submitApplication,
  takeDebugScreenshot,
} from '../src/glassdoor/application.js';

test('parses the Glassdoor page limit', () => {
  assert.equal(parseMaxPages(undefined), 1);
  assert.equal(parseMaxPages('3'), 3);
  assert.throws(() => parseMaxPages('0'));
  assert.throws(() => parseMaxPages('nope'));
});

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
    <button data-test="easy-apply-button">Apply on company site</button>
    <button data-test="easy-apply-button">Apply on Indeed</button>
    <button data-test="easy-apply-button">Apply on employer site</button>
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

test('classifies employer-site copy as external', async () => {
  const { browser, page } = await localPage('<div role="dialog"><p>Continue to company site</p></div>');
  try {
    assert.equal(await isExternalApplication(page.locator('[role="dialog"]')), true);
  } finally {
    await browser.close();
  }
});

test('classifies Indeed dialog copy as external', async () => {
  const { browser, page } = await localPage('<div role="dialog"><p>Apply on Indeed</p></div>');
  try {
    assert.equal(await isExternalApplication(page.locator('[role="dialog"]')), true);
  } finally {
    await browser.close();
  }
});

test('returns a missing-form outcome when no dialog opens', async () => {
  const { browser, page } = await localPage('<button id="apply">Easy Apply</button>');
  try {
    const outcome = await openApplication(
      page,
      page.context(),
      page.locator('#apply'),
    );
    assert.deepEqual(outcome, { kind: 'missing' });
  } finally {
    await browser.close();
  }
});

test('creates the screenshots directory before capturing a debug screenshot', async () => {
  const screenshotsDir = path.resolve('screenshots');
  const screenshotsDirExisted = await access(screenshotsDir).then(() => true).catch(() => false);
  let directoryExistedWhenScreenshotStarted = false;
  const page = {
    screenshot: async ({ path: file }: { path: string }) => {
      directoryExistedWhenScreenshotStarted = await access(path.dirname(file)).then(() => true).catch(() => false);
      return Buffer.alloc(0);
    },
  } as Page;

  try {
    await takeDebugScreenshot(page, 'directory_test');
    assert.equal(directoryExistedWhenScreenshotStarted, true);
  } finally {
    if (!screenshotsDirExisted) await rmdir(screenshotsDir).catch(() => undefined);
  }
});

test('detects empty aria-required fields through the Glassdoor application helper', async () => {
  const { browser, page } = await localPage('<div role="dialog"><textarea aria-required="true"></textarea></div>');
  try {
    assert.equal(await hasMandatoryAdditionalFields(page.locator('[role="dialog"]')), true);
  } finally {
    await browser.close();
  }
});

test('detects CAPTCHA and rate-limit copy', async () => {
  const { browser, page } = await localPage('<div role="dialog"><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><p>Too many applications. Try again later.</p></div>');
  try {
    const modal = page.locator('[role="dialog"]');
    assert.equal(await hasCaptcha(modal), true);
    assert.equal(await hasGlassdoorRateLimit(modal), true);
  } finally {
    await browser.close();
  }
});

test('classifies modal failures with rate limits first', async (t) => {
  const cases = [
    {
      name: 'rate limit before mandatory fields',
      html: '<div role="dialog"><p>Too many applications. Try again later.</p><textarea aria-required="true"></textarea></div>',
      expected: 'skipped_rate_limited',
    },
    {
      name: 'CAPTCHA',
      html: '<div role="dialog"><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></div>',
      expected: 'skipped_captcha',
    },
    {
      name: 'external application',
      html: '<div role="dialog"><p>Continue to company site</p></div>',
      expected: 'skipped_external',
    },
    {
      name: 'mandatory fields',
      html: '<div role="dialog"><textarea aria-required="true"></textarea></div>',
      expected: 'skipped_mandatory_fields',
    },
  ] as const;

  for (const { name, html, expected } of cases) {
    await t.test(name, async () => {
      const { browser, page } = await localPage(html);
      try {
        assert.equal(
          await getApplicationFailureResult(page.locator('[role="dialog"]')),
          expected,
        );
      } finally {
        await browser.close();
      }
    });
  }
});

test('two-step submit application flow', async () => {
  const html = `
    <div role="dialog" id="modal">
      <button id="continue">Continue</button>
    </div>
  `;
  const { browser, page } = await localPage(html);
  try {
    await page.evaluate(() => {
      const continueBtn = document.getElementById('continue');
      if (continueBtn) {
        continueBtn.addEventListener('click', () => {
          continueBtn.remove();
          const submitBtn = document.createElement('button');
          submitBtn.id = 'submit';
          submitBtn.textContent = 'Submit application';
          const modal = document.getElementById('modal');
          modal?.appendChild(submitBtn);
          submitBtn.addEventListener('click', () => {
            const success = document.createElement('div');
            success.id = 'success-marker';
            success.textContent = 'Application submitted';
            modal?.appendChild(success);
          });
        });
      }
    });
    const modal = page.locator('[role="dialog"]');
    const result = await submitApplication(page, modal);
    assert.equal(result, true);
    const successMarker = await page.locator('#success-marker').isVisible();
    assert.equal(successMarker, true);
  } finally {
    await browser.close();
  }
});
