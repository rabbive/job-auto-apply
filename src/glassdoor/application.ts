import { mkdir } from 'node:fs/promises';
import path from 'path';
import { Page, Locator, BrowserContext } from 'playwright';
import { GD, isTrustedGlassdoorUrl } from './selectors.js';
import * as log from '../logger.js';
import { hasMandatoryAdditionalFields } from '../wellfound/application.js';

export { hasMandatoryAdditionalFields };

const SCREENSHOTS_DIR = path.resolve('screenshots');

export type OpenApplicationResult =
  | { kind: 'modal'; modal: Locator }
  | { kind: 'external' }
  | { kind: 'missing' };

/**
 * Clicks the Easy Apply button and detects what Glassdoor does next.
 *
 * Returns the application dialog or an explicit external/missing outcome.
 */
export async function openApplication(
  page: Page,
  context: BrowserContext,
  applyButton: Locator,
): Promise<OpenApplicationResult> {
  const urlBefore = page.url();

  // Register BEFORE clicking — a new tab may open immediately.
  let newTabPage: Page | null = null;
  const tabHandler = (p: Page) => { newTabPage = p; };
  context.on('page', tabHandler);

  try {
    await applyButton.click();
    // Allow time for modal animation or new tab.
    await page.waitForTimeout(2500);
  } finally {
    context.off('page', tabHandler);
  }

  // 1. New tab opened?
  if (newTabPage) {
    const tabUrl = (newTabPage as Page).url();
    await (newTabPage as Page).close().catch(() => {});

    if (!isTrustedGlassdoorUrl(tabUrl)) {
      return { kind: 'external' }; // External ATS in new tab → skip
    }
  }

  // 2. Current tab navigated?
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    if (!isTrustedGlassdoorUrl(urlAfter)) return { kind: 'external' }; // External redirect
  }

  // 3. Dialog appeared?
  const dialog = page.locator(GD.applicationDialog).first();
  if (await dialog.isVisible().catch(() => false)) {
    if (await isExternalApplication(dialog)) return { kind: 'external' };
    log.info('Detected Glassdoor application dialog');
    return { kind: 'modal', modal: dialog };
  }

  // 4. Nothing detected
  const screenshotPath = await takeDebugScreenshot(page, 'apply_no_form_detected');
  log.info(`No application form detected. Screenshot saved: ${screenshotPath}`);
  return { kind: 'missing' };
}

/**
 * Checks whether the dialog is routing to an external application.
 */
export async function isExternalApplication(modal: Locator): Promise<boolean> {
  const indicators = await modal.locator('a[href], button, [role="button"]').evaluateAll((elements) =>
    elements.filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }).map((element) => ({
      href: element instanceof HTMLAnchorElement ? element.href : '',
      text: (element.textContent ?? '').trim().toLowerCase(),
    })),
  ).catch(() => [] as Array<{ href: string; text: string }>);

  return indicators.some(({ href, text }) =>
    Boolean(href && !isTrustedGlassdoorUrl(href)) ||
    /(?:continue to|apply on) (?:the )?(?:company|employer) site|apply on indeed|external application/.test(text),
  );
}

export async function hasCaptcha(modal: Locator): Promise<boolean> {
  return modal.evaluate((el) => {
    for (const element of Array.from(el.querySelectorAll('iframe, .g-recaptcha, .h-captcha, [data-sitekey], [class*="turnstile"], [id*="captcha"]'))) {
      const elementStyle = window.getComputedStyle(element);
      if (elementStyle.display === 'none' || elementStyle.visibility === 'hidden') continue;
      const frame = element as HTMLIFrameElement;
      const hint = `${frame.src ?? ''} ${frame.title ?? ''} ${element.className ?? ''} ${element.id ?? ''}`.toLowerCase();
      if (/captcha|recaptcha|hcaptcha|turnstile|challenge/.test(hint)) return true;
    }
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      /(?:captcha|security challenge|verify you are human|checking your browser)/i.test(el.textContent ?? '');
  }).catch(() => false);
}

/**
 * Detects Glassdoor rate-limit copy.
 */
export async function hasGlassdoorRateLimit(modal: Locator): Promise<boolean> {
  const rateLimitText = await modal.evaluate((el) => {
    const text = (el.textContent ?? '').toLowerCase();
    return /\byou have reached your application limit\.?/i.test(text);
  });
  return rateLimitText;
}

/**
 * Multi-step submission flow:
 * - Check CAPTCHA, external copy, and mandatory fields before each step
 * - Click Continue/Next/Review for max 5 steps
 * - Click final Submit button
 * - Wait for success marker, modal detachment, or state change
 */
export async function submitApplication(
  page: Page,
  modal: Locator,
): Promise<boolean> {
  const MAX_STEPS = 5;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Pre-flight checks
    if (await hasCaptcha(modal)) {
      log.info('CAPTCHA detected — skipping application');
      return false;
    }

    if (await isExternalApplication(modal)) {
      log.info('External application detected — skipping');
      return false;
    }

    if (await hasGlassdoorRateLimit(modal)) {
      log.info('Rate limit detected — skipping application');
      return false;
    }

    if (await hasMandatoryAdditionalFields(modal)) {
      log.info('Mandatory additional fields detected — skipping application');
      await takeDebugScreenshot(page, 'missing_mandatory_fields');
      return false;
    }

    // Only exact in-form navigation labels can progress the application.
    const continueBtn = await findExactButton(modal, ['continue', 'next', 'review', 'review application']);

    if (continueBtn) {
      if (await isExternalApplication(modal)) return false;
      await continueBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    const submitBtn = await findFinalSubmitButton(modal);

    if (submitBtn) {
      // Re-check immediately before the irreversible click.
      if (await isExternalApplication(modal)) return false;
      const urlBefore = page.url();
      await submitBtn.click();
      return verifySubmission(page, modal, urlBefore);
    }

    // No more buttons found
    break;
  }

  log.info('No submit button found after max steps');
  await takeDebugScreenshot(page, 'no_submit_button');
  return false;
}

async function findExactButton(modal: Locator, labels: string[]): Promise<Locator | null> {
  for (const button of await modal.locator('button').all()) {
    if (!(await button.isVisible().catch(() => false)) || await button.isDisabled().catch(() => true)) continue;
    if (labels.includes((await button.innerText().catch(() => '')).trim().toLowerCase())) return button;
  }
  return null;
}

async function findFinalSubmitButton(modal: Locator): Promise<Locator | null> {
  const stable = modal.locator('button[data-test="submit-application"], button[data-test="submitApplication"]');
  for (const button of await stable.all()) {
    if (await button.isVisible().catch(() => false) && !(await button.isDisabled().catch(() => true))) return button;
  }
  return findExactButton(modal, ['submit application', 'send application']);
}

/** Confirms a submission from an explicit success state, never dialog closure alone. */
export async function verifySubmission(page: Page, modal: Locator, urlBefore: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  let navigationLogged = false;
  while (Date.now() < deadline) {
    const success = page.locator('[data-test="application-success"], [data-test="application-submitted"], [role="status"], [role="alert"]');
    const confirmed = await success.evaluateAll((elements) => elements.some((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        /^(?:application sent|application submitted)$/i.test((element.textContent ?? '').trim());
    })).catch(() => false);
    if (confirmed) return true;

    if (page.url() !== urlBefore && !navigationLogged) {
      navigationLogged = true;
      log.info('Application URL changed; waiting for explicit submission confirmation');
    }
    if (await isExternalApplication(modal)) return false;
    await page.waitForTimeout(250);
  }
  log.info('Application submit had no explicit confirmation');
  return false;
}

/**
 * Dismisses the application modal.
 */
export async function dismissModal(page: Page, modal: Locator): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(600);

  const stillVisible = await modal.isVisible().catch(() => false);
  if (stillVisible) {
    const closeBtn = modal.locator('button[aria-label*="close" i], button[aria-label*="dismiss" i]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(400);
    }
  }
}

/**
 * Takes a debug screenshot with timestamp.
 */
export async function takeDebugScreenshot(
  page: Page,
  label: string,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[^a-z0-9-_]/gi, '_').slice(0, 60);
  const file = path.join(SCREENSHOTS_DIR, `${ts}_${safe}.png`);

  await mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}
