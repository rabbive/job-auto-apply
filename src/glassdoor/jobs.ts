import { Page, Locator } from 'playwright';
import { GD, GLASSDOOR_JOB_PATH_RE, isTrustedGlassdoorUrl } from './selectors.js';
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
    if (!isTrustedGlassdoorUrl(url)) return null;

    // Reject non-job-listing paths (e.g., search URLs).
    if (!GLASSDOOR_JOB_PATH_RE.test(url.pathname)) return null;

    const jobId = url.searchParams.get('jl');
    if (!jobId) return null;

    return `${url.origin}${url.pathname}?jl=${encodeURIComponent(jobId)}`;
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
      const href = await titleLink.evaluate((link) => (link as HTMLAnchorElement).href);
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

    if (await isCloudflareBlocked(page)) {
      throw new Error('Glassdoor blocked during pagination');
    }

    const jobs = await extractJobListings(page);
    if (jobs.length === 0) break;
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
  const title = (await page.title()).toLowerCase();
  const url = new URL(page.url());
  return title.includes('security') || title.includes('cloudflare') || title.includes('just a moment') ||
    [...url.searchParams.keys()].some((key) => key.toLowerCase() === '__cf_chl_tk') ||
    url.hostname.toLowerCase() === 'challenges.cloudflare.com';
}

/**
 * Checks if the job has already been applied to (scoped to main/[role=main]).
 */
export async function isAlreadyApplied(page: Page): Promise<boolean> {
  const main = page.locator('main, [role="main"]').first();
  const candidates = main.locator(GD.alreadyApplied);
  return candidates.evaluateAll((elements) => elements.some((element) => {
    const text = (element.textContent ?? element.getAttribute('aria-label') ?? '').trim().toLowerCase();
    const style = window.getComputedStyle(element);
    return text === 'applied' && style.display !== 'none' && style.visibility !== 'hidden';
  })).catch(() => false);
}

/**
 * Returns the native Easy Apply button if visible and enabled, or null.
 * Rejects external/employer-site/Indeed buttons.
 */
export async function findEasyApplyButton(page: Page): Promise<Locator | null> {
  for (const btn of await page.locator(GD.easyApplyButton).all()) {
    if (!(await btn.isVisible().catch(() => false)) || await btn.isDisabled().catch(() => true)) continue;
    if ((await btn.innerText().catch(() => '')).trim().toLowerCase() === 'easy apply') return btn;
  }
  return null;
}

/**
 * Reads company and role from the page (title and heading fallback).
 */
export async function getJobMeta(page: Page): Promise<{ company: string; role: string }> {
  try {
    const title = await page.title();
    const heading = await page.locator('h1, h2').first().innerText().catch(() => '');
    const detailCompany = await page.locator(GD.company).first().innerText().catch(() => '');

    const role = heading || title || 'Unknown Role';

    // Parse company from title (handles "Company - Role", "Role at Company", etc.).
    let company = detailCompany || 'Unknown Company';
    if (!detailCompany && title.includes(' - ')) {
      company = title.split(' - ')[0];
    } else if (!detailCompany && title.toLowerCase().includes(' at ')) {
      company = title.split(/ at /i)[1] || title;
    } else if (!detailCompany) {
      company = title;
    }

    return { role, company };
  } catch {
    return { role: 'Unknown Role', company: 'Unknown Company' };
  }
}
