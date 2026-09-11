import { mkdir } from 'node:fs/promises';
import path from 'path';
import { Page, Locator, BrowserContext } from 'playwright';
import { GD, GLASSDOOR_DOMAIN_RE } from './selectors.js';
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

  await applyButton.click();

  // Allow time for modal animation or new tab.
  await page.waitForTimeout(2500);
  context.off('page', tabHandler);

  // 1. New tab opened?
  if (newTabPage) {
    const tabUrl = (newTabPage as Page).url();
    await (newTabPage as Page).close().catch(() => {});

    if (!GLASSDOOR_DOMAIN_RE.test(tabUrl)) {
      return { kind: 'external' }; // External ATS in new tab → skip
    }
  }

  // 2. Current tab navigated?
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    if (!GLASSDOOR_DOMAIN_RE.test(urlAfter)) return { kind: 'external' }; // External redirect
  }

  // 3. Dialog appeared?
  const dialog = page.locator('[role="dialog"]').first();
  if (await dialog.isVisible().catch(() => false)) {
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
  const externalText = await modal.evaluate((el) => {
    const text = (el.textContent ?? '').toLowerCase();
    return text.includes('continue to company site') ||
           text.includes('apply on employer site') ||
           text.includes('apply on company site') ||
           text.includes('apply on indeed');
  });
  return externalText;
}

export async function hasCaptcha(modal: Locator): Promise<boolean> {
  return modal
    .locator(GD.captcha)
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Detects Glassdoor rate-limit copy.
 */
export async function hasGlassdoorRateLimit(modal: Locator): Promise<boolean> {
  const rateLimitText = await modal.evaluate((el) => {
    const text = (el.textContent ?? '').toLowerCase();
    return text.includes('too many applications') ||
           text.includes('try again later');
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

    // Look for Continue/Next/Review buttons
    const continueBtn = modal.locator('button').filter({
      hasText: /continue|next|review/i,
    }).first();

    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // Look for final Submit button
    const submitBtn = modal.locator('button').filter({
      hasText: /submit application|submit|apply/i,
    }).first();

    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();

      // Wait for success: success marker visible, modal detached, or success text
      const success = await Promise.race([
        modal
          .locator(':has-text("Application submitted"), :has-text("submitted")')
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(() => true)
          .catch(() => false),

        modal
          .waitFor({ state: 'detached', timeout: 10_000 })
          .then(() => true)
          .catch(() => false),

        page
          .locator('#success-marker')
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(() => true)
          .catch(() => false),
      ]);

      return success;
    }

    // No more buttons found
    break;
  }

  log.info('No submit button found after max steps');
  await takeDebugScreenshot(page, 'no_submit_button');
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
