# Glassdoor India Easy Apply support implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** Add a Glassdoor India CLI mode that harvests filtered listings and submits only native Easy Apply applications with no unanswered required fields.

**Architecture:** Keep Glassdoor in a dedicated adapter under src/glassdoor. Reuse the existing Playwright browser/profile, logger, screenshots, result categories, and generic required-field guard. Keep Cloudflare waits, selectors, pagination, and application handling inside the adapter.

**Tech Stack:** TypeScript, Node.js 18+, pnpm, Playwright, Node built-in test runner, tsx.

**Spec:** docs/superpowers/specs/2026-09-09-glassdoor-design.md

## Global Constraints

- Default region is Glassdoor India.
- Default URL is https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm.
- GLASSDOOR_MAX_PAGES defaults to 1 and must be a positive integer when set.
- Submit only native Easy Apply flows.
- Skip Indeed, ATS, employer-site, affiliate, external, CAPTCHA, and empty required-field flows.
- Never answer free-text or screening questions.
- Never upload or replace a resume.
- Wait at least five seconds after the user confirms the results page before harvesting.
- Stop with a screenshot if Cloudflare or a login wall blocks initial harvesting.
- Do not add dependencies.

### Task 1: Add selectors and listing extraction

**Files:**
- Create: src/glassdoor/selectors.ts
- Create: src/glassdoor/jobs.ts
- Create: test/glassdoor.test.ts

**Interfaces:**
- normalizeJobUrl(href: string, pageUrl: string): string | null
- extractJobListings(page: Page): Promise<GlassdoorJob[]>
- getJobListings(page: Page, maxPages: number): Promise<string[]>
- openJob(page: Page, jobUrl: string): Promise<string>
- isCloudflareBlocked(page: Page): Promise<boolean>
- isAlreadyApplied(page: Page): Promise<boolean>
- findEasyApplyButton(page: Page): Promise<Locator | null>
- getJobMeta(page: Page): Promise<{ company: string; role: string }>

- [ ] **Step 1: Write failing tests**

Create local page.setContent fixtures before implementation:

~~~ts
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
~~~

- [ ] **Step 2: Run the test and verify RED**

Run: pnpm exec tsx --test test/glassdoor.test.ts

Expected: failure because src/glassdoor/jobs.ts and its exports do not exist.

- [ ] **Step 3: Implement the minimal listing adapter**

Create selectors for Glassdoor India, result cards, title/company/location, job-listing links, native Easy Apply, applied state, dialogs, CAPTCHA, and external copy.

Implement jobs.ts so normalizeJobUrl resolves relative URLs, rejects non-Glassdoor hosts and non-job-listing paths, and preserves jl. extractJobListings reads card metadata, filters incomplete cards, and deduplicates by URL. getJobListings harvests the current page, then pages p=2 through p=maxPages with five seconds on the first page and three seconds later. openJob waits for DOM content plus five seconds. isCloudflareBlocked checks title Security/Cloudflare and URL __cf_chl_tk. isAlreadyApplied scopes to main/[role=main]. findEasyApplyButton returns only a visible enabled native Easy Apply control. getJobMeta reads title and heading fallback.

- [ ] **Step 4: Run the test and verify GREEN**

Run: pnpm exec tsx --test test/glassdoor.test.ts

Expected: listing, URL, deduplication, and Easy Apply tests pass.

- [ ] **Step 5: Commit**

~~~sh
git add src/glassdoor/selectors.ts src/glassdoor/jobs.ts test/glassdoor.test.ts
git commit -m 'feat: add Glassdoor listing adapter'
~~~

### Task 2: Add the Easy Apply state machine

**Files:**
- Create: src/glassdoor/application.ts
- Modify: test/glassdoor.test.ts

**Interfaces:**
- openApplication(page: Page, context: BrowserContext, applyButton: Locator): Promise<Locator | null>
- isExternalApplication(modal: Locator): Promise<boolean>
- hasCaptcha(modal: Locator): Promise<boolean>
- hasGlassdoorRateLimit(modal: Locator): Promise<boolean>
- submitApplication(page: Page, modal: Locator): Promise<boolean>
- dismissModal(page: Page, modal: Locator): Promise<void>
- takeDebugScreenshot(page: Page, label: string): Promise<string>

- [ ] **Step 1: Write failing application tests**

Add these local dialog fixtures, reusing the localPage helper from Task 1:

~~~ts
import {
  hasCaptcha,
  hasGlassdoorRateLimit,
  isExternalApplication,
} from '../src/glassdoor/application.js';

test('classifies employer-site copy as external', async () => {
  const { browser, page } = await localPage('<div role="dialog"><p>Continue to company site</p></div>');
  try {
    assert.equal(await isExternalApplication(page.locator('[role="dialog"]')), true);
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
~~~

Add a two-step fixture with a Continue button that replaces itself with a Submit application button and a success marker. Assert submitApplication returns true.

- [ ] **Step 2: Run the test and verify RED**

Run: pnpm exec tsx --test test/glassdoor.test.ts

Expected: failure because src/glassdoor/application.ts does not exist.

- [ ] **Step 3: Implement the state machine**

Register the new-page listener before clicking Easy Apply. Close new tabs and classify off-domain or Indeed destinations as external. Detect the first visible Glassdoor dialog and screenshot missing forms. Before every step, check CAPTCHA, external copy, and the reused hasMandatoryAdditionalFields guard. Leave optional notes untouched. Click scoped Next/Continue/Review controls for at most five steps, then click only a scoped final submit button and wait for success, modal detachment, or a confirmed state change. Detect account-cap copy, dismiss without throwing, and use the existing timestamped screenshot convention.

- [ ] **Step 4: Run tests and verify GREEN**

Run: pnpm exec tsx --test test/glassdoor.test.ts

Expected: all listing and application tests pass.

- [ ] **Step 5: Commit**

~~~sh
git add src/glassdoor/application.ts test/glassdoor.test.ts
git commit -m 'feat: add Glassdoor Easy Apply flow'
~~~

### Task 3: Add CLI, configuration, and README

**Files:**
- Create: src/glassdoor/index.ts
- Modify: package.json
- Modify: README.md
- Modify: test/glassdoor.test.ts

**Interfaces:**
- parseMaxPages(value: string | undefined): number
- GLASSDOOR_JOBS_URL and GLASSDOOR_MAX_PAGES environment overrides
- pnpm start:glassdoor

- [ ] **Step 1: Write failing configuration test**

Import parseMaxPages from src/glassdoor/index.ts; the guarded main call must not launch during import.

~~~ts
test('parses the Glassdoor page limit', () => {
  assert.equal(parseMaxPages(undefined), 1);
  assert.equal(parseMaxPages('3'), 3);
  assert.throws(() => parseMaxPages('0'));
  assert.throws(() => parseMaxPages('nope'));
});
~~~

- [ ] **Step 2: Run the test and verify RED**

Run: pnpm exec tsx --test test/glassdoor.test.ts

Expected: failure because the CLI helper does not exist.

- [ ] **Step 3: Implement the CLI and package script**

Add package.json script start:glassdoor = tsx src/glassdoor/index.ts. Implement parseMaxPages with default one and positive-integer validation. Load dotenv/config, use the India Easy Apply URL by default, launch the existing browser, pause for login/filter setup, wait five seconds after ENTER, stop with a screenshot on Cloudflare/login block, harvest up to maxPages, process each job with the adapter state machine, stop on account-limit copy, print the existing summary, and close the browser. Guard the main() call with a fileURLToPath(import.meta.url) check so tests can import parseMaxPages without launching a browser.

Update README with Glassdoor India startup steps, the default URL, the native Easy Apply-only rule, and GLASSDOOR_JOBS_URL / GLASSDOOR_MAX_PAGES overrides.

- [ ] **Step 4: Run local checks**

Run:
~~~sh
pnpm exec tsx --test test/glassdoor.test.ts
pnpm run build
git diff --check
~~~

Expected: all tests pass, the build succeeds, and diff check is clean.

- [ ] **Step 5: Commit**

~~~sh
git add src/glassdoor/index.ts package.json README.md test/glassdoor.test.ts
git commit -m 'feat: add Glassdoor India CLI'
~~~

### Task 4: Live smoke and final verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the read-only live smoke**

Open https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm in the existing visible browser, wait for load and five seconds, and report card count plus one canonical URL. Do not log in, click a job, open an application, or submit.

- [ ] **Step 2: Verify the CLI checkpoint**

Run pnpm start:glassdoor with desktop permission. Confirm Glassdoor India opens and the CLI pauses at the manual ENTER prompt. Do not press ENTER in this verification.

- [ ] **Step 3: Run final checks**

Run:
~~~sh
pnpm exec tsx --test test/glassdoor.test.ts
pnpm run build
git status --short
~~~

Expected: tests and build pass, with only intended Glassdoor source/tests/docs changes remaining.

- [ ] **Step 4: Handoff**

Report the new command, default URL, environment overrides, test/build output, and any Cloudflare/login limitation. Do not claim live application submission unless the user separately authorizes it.
