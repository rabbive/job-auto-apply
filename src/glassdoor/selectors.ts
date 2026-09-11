/**
 * Glassdoor India DOM selectors.
 */
export const GD = {
  /** Job listing card container (data-jobid or class prefix fallback). */
  jobCard: '[data-jobid], [class^="JobsList_jobListItem"], [class*=" JobsList_jobListItem"]',

  /** Job title link within a card. */
  jobTitle: '[data-test="job-title"], [class^="JobCard_jobTitle"], [class*=" JobCard_jobTitle"]',

  /** Company name within a card. */
  company: '[data-test="employer-name"], [class^="JobCard_employerName"], [class*=" JobCard_employerName"]',

  /** Location within a card. */
  location: '[data-test="emp-location"], [class^="JobCard_location"], [class*=" JobCard_location"]',

  /** Native Easy Apply button (rejects "Apply on employer site"). */
  easyApplyButton: '[data-test="easy-apply-button"], button',

  /** Already applied indicator. */
  alreadyApplied: 'button, [data-test="applied"], [data-test="application-applied"], [aria-label="Applied"]',

  applicationDialog: '[role="dialog"], [aria-modal="true"], [class^="application-container"], [class*=" application-container"]',

  /** Cloudflare challenge page. */
  cloudflare: [
    'title:has-text("Security")',
    'title:has-text("Cloudflare")',
  ].join(', '),

  /** CAPTCHA indicators. */
  captcha: 'iframe, .g-recaptcha, .h-captcha, [data-sitekey], [class*="turnstile"], [id*="captcha"]',
} as const;

export const GLASSDOOR_JOB_PATH_RE = /\/job-listing\//;

/** True only for Glassdoor's two supported registrable domains and their subdomains. */
export function isTrustedGlassdoorUrl(value: string | URL): boolean {
  try {
    const url = typeof value === 'string' ? new URL(value) : value;
    const host = url.hostname.toLowerCase();
    return host === 'glassdoor.com' || host.endsWith('.glassdoor.com') ||
      host === 'glassdoor.co.in' || host.endsWith('.glassdoor.co.in');
  } catch {
    return false;
  }
}

/** Default Glassdoor India Easy Apply jobs search URL. */
export const GLASSDOOR_INDIA_JOBS_URL =
  'https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm';
