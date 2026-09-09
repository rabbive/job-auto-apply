import { Page, Locator } from 'playwright';
import { GD, GLASSDOOR_DOMAIN_RE, GLASSDOOR_JOB_PATH_RE } from './selectors.js';
import * as log from '../logger.js';

export interface GlassdoorJob {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
}

/**
 * Normalizes a job URL, resolving relative paths and preserving jl parameter.
 * Returns null for non-Glassdoor hosts or non-job-listing paths.
 */
export function normalizeJobUrl(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(href, pageUrl);

    // Reject non-Glassdoor hosts.
    if (!GLASSDOOR_DOMAIN_RE.test(url.hostname)) return null;

    // Reject non-job-listing paths (e.g., search URLs).
    if (!GLASSDOOR_JOB_PATH_RE.test(url.pathname)) return null;

    // Preserve jl parameter and full URL.
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Extracts job listings from the current page, filters incomplete cards,
 * and deduplicates by URL.
 */
export async function extractJobListings(page: Page): Promise<GlassdoorJob[]> {
  const cards = await page.locator(GD.jobCard).all();
  const jobs: GlassdoorJob[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    try {
      const titleLink = card.locator(GD.jobTitle).first();
      const href = await titleLink.getAttribute('href');
      const title = await titleLink.innerText();
      const company = await card.locator(GD.company).first().innerText();
      const location = await card.locator(GD.location).first().innerText();

      if (!href || !title || !company || !location) continue;

      const url = normalizeJobUrl(href, page.url());
      if (!url) continue;

      // Deduplicate by URL.
      if (seen.has(url)) continue;
      seen.add(url);

      // Extract jobId from data-jobid or derive from URL jl parameter.
      const jobId = (await card.getAttribute('data-jobid')) || new URL(url).searchParams.get('jl') || url.split('/').pop() || 'unknown';

      jobs.push({ jobId, url, title, company, location });
    } catch {
      // Skip incomplete cards.
      continue;
    }
  }

  return jobs;
}

/**
 * Harvests job URLs from the current page, then pages through p=2 to p=maxPages.
 * Waits 5 seconds on the first page and 3 seconds on subsequent pages.
 */
export async function getJobListings(page: Page, maxPages: number): Promise<string[]> {
  const allUrls = new Set<string>();

  // First page.
  await page.waitForTimeout(5000);
  const firstPageJobs = await extractJobListings(page);
  firstPageJobs.forEach((job) => allUrls.add(job.url));

  // Subsequent pages.
  for (let p = 2; p <= maxPages; p++) {
    const currentUrl = new URL(page.url());
    currentUrl.searchParams.set('p', String(p));
    await page.goto(currentUrl.href);
    await page.waitForTimeout(3000);

    const jobs = await extractJobListings(page);
    jobs.forEach((job) => allUrls.add(job.url));
  }

  return Array.from(allUrls);
}

/**
 * Opens a job URL and waits for DOM content plus 5 seconds.
 */
export async function openJob(page: Page, jobUrl: string): Promise<string> {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  return page.url();
}

/**
 * Checks if the page is blocked by Cloudflare.
 */
export async function isCloudflareBlocked(page: Page): Promise<boolean> {
  const title = await page.title();
  if (title.includes('Security') || title.includes('Cloudflare')) return true;
  if (page.url().includes('__cf_chl_tk')) return true;
  return false;
}

/**
 * Checks if the job has already been applied to (scoped to main/[role=main]).
 */
export async function isAlreadyApplied(page: Page): Promise<boolean> {
  const main = page.locator('main, [role="main"]').first();
  return main.locator(GD.alreadyApplied).first().isVisible().catch(() => false);
}

/**
 * Returns the native Easy Apply button if visible and enabled, or null.
 * Rejects external/employer-site/Indeed buttons.
 */
export async function findEasyApplyButton(page: Page): Promise<Locator | null> {
  const btn = page.locator(GD.easyApplyButton).first();
  if (!(await btn.isVisible().catch(() => false))) return null;
  if (await btn.isDisabled().catch(() => false)) return null;

  // Reject external application buttons.
  const text = await btn.innerText().catch(() => '');
  const rejectPatterns = ['employer site', 'company site', 'Indeed', 'external'];
  if (rejectPatterns.some((pattern) => text.toLowerCase().includes(pattern.toLowerCase()))) {
    return null;
  }

  return btn;
}

/**
 * Reads company and role from the page (title and heading fallback).
 */
export async function getJobMeta(page: Page): Promise<{ company: string; role: string }> {
  try {
    const title = await page.title();
    const heading = await page.locator('h1, h2').first().innerText().catch(() => '');

    const role = heading || title || 'Unknown Role';

    // Parse company from title (handles "Company - Role", "Role at Company", etc.).
    let company = 'Unknown Company';
    if (title.includes(' - ')) {
      company = title.split(' - ')[0];
    } else if (title.toLowerCase().includes(' at ')) {
      company = title.split(/ at /i)[1] || title;
    } else {
      company = title;
    }

    return { role, company };
  } catch {
    return { role: 'Unknown Role', company: 'Unknown Company' };
  }
}
