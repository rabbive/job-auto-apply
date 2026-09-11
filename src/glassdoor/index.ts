import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import 'dotenv/config';

import { closeBrowser, getActivePage, launchBrowser } from '../browser.js';
import * as log from '../logger.js';
import {
  dismissModal,
  hasCaptcha,
  hasGlassdoorRateLimit,
  hasMandatoryAdditionalFields,
  isExternalApplication,
  openApplication,
  submitApplication,
  takeDebugScreenshot,
} from './application.js';
import {
  findEasyApplyButton,
  getJobListings,
  getJobMeta,
  isAlreadyApplied,
  isCloudflareBlocked,
  openJob,
} from './jobs.js';
import { GLASSDOOR_DOMAIN_RE } from './selectors.js';
import type { ApplicationResult } from '../wellfound/application.js';

const DEFAULT_GLASSDOOR_JOBS_URL =
  'https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm';

export function parseMaxPages(value: string | undefined): number {
  if (value === undefined) return 1;

  const maxPages = Number(value);
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('GLASSDOOR_MAX_PAGES must be a positive integer');
  }

  return maxPages;
}

type JobResult = ApplicationResult | 'blocked';

interface Stats {
  applied: number;
  already_applied: number;
  skipped_mandatory_fields: number;
  skipped_external: number;
  skipped_captcha: number;
  skipped_no_apply_button: number;
  skipped_rate_limited: number;
  skipped_error: number;
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function printSummary(stats: Stats): void {
  log.sectionHeader('Finished');
  log.summaryLine('Applied', stats.applied, '\x1b[32m');
  log.summaryLine('Already applied', stats.already_applied, '\x1b[90m');
  log.summaryLine('Skipped — mandatory fields', stats.skipped_mandatory_fields, '\x1b[33m');
  log.summaryLine('Skipped — external app', stats.skipped_external, '\x1b[33m');
  log.summaryLine('Skipped — CAPTCHA', stats.skipped_captcha, '\x1b[31m');
  log.summaryLine('Skipped — no Apply button', stats.skipped_no_apply_button, '\x1b[90m');
  log.summaryLine('Skipped — rate limited', stats.skipped_rate_limited, '\x1b[31m');
  log.summaryLine('Skipped — error', stats.skipped_error, '\x1b[31m');
  log.divider();
}

async function dismissInitialModal(page: Page): Promise<void> {
  const modal = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ hasText: /cookie|sign in|log in/i })
    .first();

  if (await modal.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

async function isLoginBlocked(page: Page): Promise<boolean> {
  if (/\/(login|signin)/i.test(new URL(page.url()).pathname)) return true;

  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

async function stopIfBlocked(page: Page): Promise<boolean> {
  const cloudflareBlocked = await isCloudflareBlocked(page);
  const loginBlocked = await isLoginBlocked(page);

  if (!cloudflareBlocked && !loginBlocked) return false;

  const screenshot = await takeDebugScreenshot(
    page,
    cloudflareBlocked ? 'cloudflare_blocked' : 'login_blocked',
  );
  log.error(
    `${cloudflareBlocked ? 'Cloudflare challenge' : 'Glassdoor login wall'} detected. Screenshot: ${screenshot}`,
  );
  return true;
}

async function processJob(
  context: Awaited<ReturnType<typeof launchBrowser>>,
  jobUrl: string,
  processed: Set<string>,
): Promise<JobResult> {
  if (processed.has(jobUrl)) {
    log.skip('Already processed in this run');
    return 'already_applied';
  }
  processed.add(jobUrl);

  const page = await getActivePage(context);
  log.step('Opening job');

  try {
    await openJob(page, jobUrl);
  } catch (err) {
    const screenshot = await takeDebugScreenshot(page, 'job_navigation_failed');
    log.error(`Navigation failed: ${(err as Error).message}. Screenshot: ${screenshot}`);
    return 'skipped_error';
  }

  if (await stopIfBlocked(page)) return 'blocked';

  const meta = await getJobMeta(page);
  log.info(`${meta.company} — ${meta.role}`);

  if (await isAlreadyApplied(page)) {
    log.skip('Already applied');
    return 'already_applied';
  }

  const applyButton = await findEasyApplyButton(page);
  if (!applyButton) {
    log.skip('No native Easy Apply button found');
    return 'skipped_no_apply_button';
  }

  const modal = await openApplication(page, context, applyButton);
  if (!modal) {
    log.skip('External application or no application form');
    return 'skipped_external';
  }

  if (await hasCaptcha(modal)) {
    const screenshot = await takeDebugScreenshot(page, 'captcha');
    log.error(`CAPTCHA detected. Screenshot: ${screenshot}`);
    await dismissModal(page, modal);
    return 'skipped_captcha';
  }

  if (await isExternalApplication(modal)) {
    log.skip('External application');
    await dismissModal(page, modal);
    return 'skipped_external';
  }

  if (await hasMandatoryAdditionalFields(modal)) {
    log.skip('Mandatory question or field detected');
    await dismissModal(page, modal);
    return 'skipped_mandatory_fields';
  }

  if (await hasGlassdoorRateLimit(modal)) {
    log.error('Glassdoor application limit reached. Stopping run.');
    await dismissModal(page, modal);
    return 'skipped_rate_limited';
  }

  const submitted = await submitApplication(page, modal);
  if (!submitted) {
    if (await hasGlassdoorRateLimit(modal)) {
      log.error('Glassdoor application limit reached. Stopping run.');
      await dismissModal(page, modal);
      return 'skipped_rate_limited';
    }

    const screenshot = await takeDebugScreenshot(page, 'submit_failed');
    log.error(`Submission failed. Screenshot: ${screenshot}`);
    await dismissModal(page, modal);
    return 'skipped_error';
  }

  log.success('Applied');
  await dismissModal(page, modal);
  return 'applied';
}

async function main(): Promise<void> {
  const maxPages = parseMaxPages(process.env.GLASSDOOR_MAX_PAGES);
  const jobsUrl = process.env.GLASSDOOR_JOBS_URL ?? DEFAULT_GLASSDOOR_JOBS_URL;

  log.banner();
  log.raw('  (Glassdoor India mode)\n');

  const context = await launchBrowser();

  try {
    const page = await getActivePage(context);

    if (!GLASSDOOR_DOMAIN_RE.test(new URL(page.url()).hostname)) {
      await page.goto(jobsUrl, { waitUntil: 'domcontentloaded' });
    }

    log.raw('\n1. Log in to Glassdoor if needed.');
    log.raw('2. Set your filters on the visible results page.');
    log.raw('3. Only native Easy Apply jobs will be submitted.');
    log.divider();

    await waitForEnter('   Press ENTER when your filtered results are ready…');
    await page.waitForTimeout(5000);
    await dismissInitialModal(page);

    if (await stopIfBlocked(page)) return;

    const jobUrls = await getJobListings(page, maxPages);
    if (await stopIfBlocked(page)) return;

    if (jobUrls.length === 0) {
      log.error('No Glassdoor job listings found on the current results page.');
      return;
    }

    log.raw(`\nStarting automation — ${jobUrls.length} job(s) to process.\n`);

    const stats: Stats = {
      applied: 0,
      already_applied: 0,
      skipped_mandatory_fields: 0,
      skipped_external: 0,
      skipped_captcha: 0,
      skipped_no_apply_button: 0,
      skipped_rate_limited: 0,
      skipped_error: 0,
    };
    const processed = new Set<string>();

    for (let i = 0; i < jobUrls.length; i++) {
      const jobUrl = jobUrls[i];
      log.jobHeader(i + 1, jobUrls.length, jobUrl);

      try {
        const result = await processJob(context, jobUrl, processed);

        if (result === 'blocked') {
          stats.skipped_error++;
          break;
        }

        stats[result]++;
        if (result === 'skipped_rate_limited') break;
      } catch (err) {
        const activePage = await getActivePage(context);
        const screenshot = await takeDebugScreenshot(activePage, 'unexpected_error');
        log.error(`Unexpected error: ${(err as Error).message}. Screenshot: ${screenshot}`);
        stats.skipped_error++;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    printSummary(stats);
  } finally {
    await closeBrowser(context);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nFatal error:', err);
    process.exit(1);
  });
}
