/**
 * Glassdoor India DOM selectors.
 */
export const GD = {
  /** Job listing card container (data-jobid or class prefix fallback). */
  jobCard: 'li[data-jobid], li[class*="JobCard"]',

  /** Job title link within a card. */
  jobTitle: '[data-test="job-title"]',

  /** Company name within a card. */
  company: '[data-test="employer-name"]',

  /** Location within a card. */
  location: '[data-test="emp-location"]',

  /** Native Easy Apply button (rejects "Apply on employer site"). */
  easyApplyButton: '[data-test="easy-apply-button"]',

  /** Already applied indicator. */
  alreadyApplied: [
    ':has-text("Applied")',
    'button:has-text("Applied")',
    '[data-test*="applied"]',
  ].join(', '),

  /** Cloudflare challenge page. */
  cloudflare: [
    'title:has-text("Security")',
    'title:has-text("Cloudflare")',
  ].join(', '),

  /** CAPTCHA indicators. */
  captcha: [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '.g-recaptcha',
    '[data-sitekey]',
    'iframe[src*="challenges.cloudflare.com"]',
  ].join(', '),
} as const;

export const GLASSDOOR_DOMAIN_RE = /glassdoor\.(com|co\.in)/;
export const GLASSDOOR_JOB_PATH_RE = /\/job-listing\//;

/** Default Glassdoor India jobs search URL (CLI integration in Task 3). */
export const GLASSDOOR_INDIA_JOBS_URL = 'https://www.glassdoor.co.in/Job/jobs.htm';
