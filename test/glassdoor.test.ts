import assert from 'node:assert/strict';
import { access, rmdir } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { getApplicationFailureResult, parseMaxPages } from '../src/glassdoor/index.js';
import {
  extractJobListings,
  findEasyApplyButton,
  getJobListings,
  getJobMeta,
  isAlreadyApplied,
  isCloudflareBlocked,
  normalizeJobUrl,
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

test('extracts cards and canonicalizes tracking variants to their jl URL', async () => {
  const html = `
    <li data-jobid="101"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?utm_source=x&jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>
    <li data-jobid="102"><a data-test="job-title" href="https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?tracking=abc&jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>
  `;
  const { browser, page } = await localPage(html);
  try {
    const jobs = await extractJobListings(page);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, '101');
    assert.equal(jobs[0].url, 'https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101');
  } finally {
    await browser.close();
  }
});

test('uses Glassdoor card and metadata class-prefix fallbacks', async () => {
  const html = '<base href="https://www.glassdoor.co.in/"><div class="JobsList_jobListItem__1"><a class="JobCard_jobTitle__1" href="/job-listing/frontend-JV_IC2.htm?jl=202">Frontend Dev</a><div class="JobCard_employerName__1">Beta Corp</div><div class="JobCard_location__1">Mumbai</div></div>';
  const { browser, page } = await localPage(html);
  try {
    const jobs = await extractJobListings(page);
    assert.deepEqual(
      jobs.map(({ title, company, location }) => ({ title, company, location })),
      [{ title: 'Frontend Dev', company: 'Beta Corp', location: 'Mumbai' }],
    );
  } finally {
    await browser.close();
  }
});

test('rejects search URLs and Glassdoor lookalike hosts', () => {
  assert.equal(normalizeJobUrl('/Job/jobs.htm?sc.keyword=backend', 'https://www.glassdoor.co.in/Job/jobs.htm'), null);
  assert.equal(normalizeJobUrl('https://notglassdoor.com/job-listing/x?jl=1', 'https://www.glassdoor.co.in/Job/jobs.htm'), null);
  assert.equal(normalizeJobUrl('https://glassdoor.com.attacker.example/job-listing/x?jl=1', 'https://www.glassdoor.co.in/Job/jobs.htm'), null);
});

test('finds text-only Easy Apply after rejecting a stable external control', async () => {
  const { browser, page } = await localPage('<button data-test="easy-apply-button">Apply on employer site</button><button>Easy Apply</button>');
  try {
    const button = await findEasyApplyButton(page);
    assert.equal(await button?.innerText(), 'Easy Apply');
  } finally {
    await browser.close();
  }
});

test('rejects external and Indeed Easy Apply controls', async () => {
  const html = '<button data-test="easy-apply-button">Apply on company site</button><button data-test="easy-apply-button">Apply on Indeed</button><button data-test="easy-apply-button">Apply on employer site</button>';
  const { browser, page } = await localPage(html);
  try {
    assert.equal(await findEasyApplyButton(page), null);
  } finally {
    await browser.close();
  }
});

test('detects Cloudflare challenges from case-insensitive title, token, and host without a network request', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('https://www.glassdoor.co.in/**', (route) => route.fulfill({ body: '<title>security check</title>' }));
  await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ body: '<main>challenge</main>' }));
  try {
    await page.goto('https://www.glassdoor.co.in/?__CF_CHL_TK=abc123');
    assert.equal(await isCloudflareBlocked(page), true);
    await page.goto('https://challenges.cloudflare.com/turnstile');
    assert.equal(await isCloudflareBlocked(page), true);
  } finally {
    await browser.close();
  }
});

test('detects applied controls and ignores nearby Not Applied text', async () => {
  const { browser, page } = await localPage('<main><button>Applied</button></main>');
  try {
    assert.equal(await isAlreadyApplied(page), true);
    await page.setContent('<main><div>Not Applied yet</div></main>');
    assert.equal(await isAlreadyApplied(page), false);
  } finally {
    await browser.close();
  }
});

test('uses detail metadata before parsing the page title', async () => {
  const html = '<title>Senior Backend Engineer at TechCorp | Glassdoor</title><h1>Senior Backend Engineer</h1><div data-test="employer-name">Acme Detail</div>';
  const { browser, page } = await localPage(html);
  try {
    assert.deepEqual(await getJobMeta(page), { company: 'Acme Detail', role: 'Senior Backend Engineer' });
  } finally {
    await browser.close();
  }
});

test('stops pagination at the first empty locally intercepted page', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requestedPages: string[] = [];
  await page.route('https://www.glassdoor.co.in/**', async (route) => {
    const url = new URL(route.request().url());
    const currentPage = url.searchParams.get('p') ?? '1';
    requestedPages.push(currentPage);
    const body = currentPage === '1'
      ? '<li data-jobid="101"><a data-test="job-title" href="/job-listing/backend-JV_IC1.htm?jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>'
      : '';
    await route.fulfill({ contentType: 'text/html', body });
  });
  try {
    await page.goto('https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm');
    assert.deepEqual(
      await getJobListings(page, 3),
      ['https://www.glassdoor.co.in/job-listing/backend-JV_IC1.htm?jl=101'],
    );
    assert.deepEqual(requestedPages, ['1', '2']);
  } finally {
    await browser.close();
  }
});

test('stops locally intercepted pagination on a Cloudflare challenge', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requestedPages: string[] = [];
  await page.route('https://www.glassdoor.co.in/**', async (route) => {
    const url = new URL(route.request().url());
    const currentPage = url.searchParams.get('p') ?? '1';
    requestedPages.push(currentPage);
    const body = currentPage === '2'
      ? '<title>just a moment...</title><main>Checking your browser before accessing Glassdoor</main>'
      : '<li data-jobid="101"><a data-test="job-title" href="/job-listing/backend-JV_IC1.htm?jl=101">Backend Engineer</a><div data-test="employer-name">Acme</div><div data-test="emp-location">Bengaluru</div></li>';
    await route.fulfill({ contentType: 'text/html', body });
  });
  try {
    await page.goto('https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm');
    await assert.rejects(getJobListings(page, 3), /Glassdoor blocked during pagination/);
    assert.deepEqual(requestedPages, ['1', '2']);
  } finally {
    await browser.close();
  }
});

test('classifies visible off-domain ATS links as external', async () => {
  const { browser, page } = await localPage('<div role="dialog"><a href="https://jobs.lever.co/acme">Continue</a></div>');
  try {
    assert.equal(await isExternalApplication(page.locator('[role="dialog"]')), true);
  } finally {
    await browser.close();
  }
});

test('opens aria-modal and application-container dialog fallbacks', async () => {
  const { browser, page } = await localPage('<button id="aria">Easy Apply</button><button id="class">Easy Apply</button>');
  try {
    await page.locator('#aria').evaluate((button) => {
      button.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('aria-modal', 'true');
        dialog.textContent = 'Application';
        document.body.append(dialog);
      });
    });
    const ariaOutcome = await openApplication(page, page.context(), page.locator('#aria'));
    assert.equal(ariaOutcome.kind, 'modal');

    await page.locator('[aria-modal="true"]').evaluate((element) => element.remove());
    await page.locator('#class').evaluate((button) => {
      button.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.className = 'application-container__1';
        dialog.textContent = 'Application';
        document.body.append(dialog);
      });
    });
    const classOutcome = await openApplication(page, page.context(), page.locator('#class'));
    assert.equal(classOutcome.kind, 'modal');
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

test('detects any visible challenge marker and only exact application-cap copy', async () => {
  const { browser, page } = await localPage('<div role="dialog"><div class="g-recaptcha" style="display:none"></div><iframe title="Cloudflare security challenge"></iframe><p>Try again later.</p></div>');
  try {
    const modal = page.locator('[role="dialog"]');
    assert.equal(await hasCaptcha(modal), true);
    assert.equal(await hasGlassdoorRateLimit(modal), false);
    await page.setContent('<div role="dialog"><p>You have reached your application limit.</p></div>');
    assert.equal(await hasGlassdoorRateLimit(page.locator('[role="dialog"]')), true);
  } finally {
    await browser.close();
  }
});

test('classifies modal failures with an explicit account cap first', async (t) => {
  const cases = [
    { name: 'application cap before mandatory fields', html: '<div role="dialog"><p>You have reached your application limit.</p><textarea aria-required="true"></textarea></div>', expected: 'skipped_rate_limited' },
    { name: 'CAPTCHA', html: '<div role="dialog"><iframe title="Cloudflare security challenge"></iframe></div>', expected: 'skipped_captcha' },
    { name: 'external application', html: '<div role="dialog"><a href="https://jobs.lever.co/acme">Continue</a></div>', expected: 'skipped_external' },
    { name: 'mandatory fields', html: '<div role="dialog"><textarea aria-required="true"></textarea></div>', expected: 'skipped_mandatory_fields' },
  ] as const;
  for (const { name, html, expected } of cases) {
    await t.test(name, async () => {
      const { browser, page } = await localPage(html);
      try {
        assert.equal(await getApplicationFailureResult(page.locator('[role="dialog"]')), expected);
      } finally {
        await browser.close();
      }
    });
  }
});

test('does not click a final submit when a visible external link is present', async () => {
  const { browser, page } = await localPage('<div role="dialog" id="modal"><a href="https://jobs.lever.co/acme">Continue</a><button>Submit application</button></div>');
  try {
    await page.locator('button').evaluate((button) => {
      button.addEventListener('click', () => button.closest('[role="dialog"]')?.remove());
    });
    assert.equal(await submitApplication(page, page.locator('#modal')), false);
    assert.equal(await page.locator('#modal').isVisible(), true);
  } finally {
    await browser.close();
  }
});

test('does not treat generic Apply controls as final submission', async () => {
  const { browser, page } = await localPage('<div role="dialog" id="modal"><button>Apply</button></div>');
  try {
    await page.locator('button').evaluate((button) => {
      button.addEventListener('click', () => button.closest('[role="dialog"]')?.remove());
    });
    assert.equal(await submitApplication(page, page.locator('#modal')), false);
    assert.equal(await page.locator('#modal').isVisible(), true);
  } finally {
    await browser.close();
  }
});

test('confirms Send application only from exact success copy', async () => {
  const { browser, page } = await localPage('<div role="dialog" id="modal"><button>Send application</button></div>');
  try {
    await page.locator('button').evaluate((button) => {
      button.addEventListener('click', () => {
        const success = document.createElement('div');
        success.setAttribute('role', 'status');
        success.textContent = 'Application sent';
        button.closest('[role="dialog"]')?.append(success);
      });
    });
    assert.equal(await submitApplication(page, page.locator('#modal')), true);
  } finally {
    await browser.close();
  }
});

test('does not count an unverified dialog close as submission success', async () => {
  const { browser, page } = await localPage('<div role="dialog" id="modal"><button>Submit application</button></div>');
  try {
    await page.locator('button').evaluate((button) => {
      button.addEventListener('click', () => button.closest('[role="dialog"]')?.remove());
    });
    assert.equal(await submitApplication(page, page.locator('#modal')), false);
  } finally {
    await browser.close();
  }
});
