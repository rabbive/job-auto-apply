import path from 'path';
import { Page, Locator, BrowserContext } from 'playwright';
import { GD, GLASSDOOR_DOMAIN_RE } from './selectors.js';
import * as log from '../logger.js';

const SCREENSHOTS_DIR = path.resolve('screenshots');

/**
 * Clicks the Easy Apply button and detects what Glassdoor does next.
 *
 * Returns a Locator scoped to the application dialog, or `null` if
 * the flow is external or unrecognisable.
 */
export async function openApplication(
  page: Page,
  context: BrowserContext,
  applyButton: Locator,
): Promise<Locator | null> {
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
      return null; // External ATS in new tab → skip
    }
  }

  // 2. Current tab navigated?
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    if (!GLASSDOOR_DOMAIN_RE.test(urlAfter)) return null; // External redirect
  }

  // 3. Dialog appeared?
  const dialog = page.locator('[role="dialog"]').first();
  if (await dialog.isVisible().catch(() => false)) {
    log.info('Detected Glassdoor application dialog');
    return dialog;
  }

  // 4. Nothing detected
  const screenshotPath = await takeDebugScreenshot(page, 'apply_no_form_detected');
  log.info(`No application form detected. Screenshot saved: ${screenshotPath}`);
  return null;
}

/**
 * Checks whether the dialog is routing to an external application.
 */
export async function isExternalApplication(modal: Locator): Promise<boolean> {
  const externalText = await modal.evaluate((el) => {
    const text = el.innerText.toLowerCase();
    return text.includes('continue to company site') ||
           text.includes('apply on employer site') ||
           text.includes('apply on company site');
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
    const text = el.innerText.toLowerCase();
    return text.includes('too many applications') ||
           text.includes('try again later');
  });
  return rateLimitText;
}

/**
 * Reused from wellfound — detects mandatory unfilled fields.
 */
export async function hasMandatoryAdditionalFields(modal: Locator): Promise<boolean> {
  return modal.evaluate((el) => {
    const SKIP_TYPES = new Set(['file', 'hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio']);

    const fields = Array.from(
      el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      ),
    );

    const requiredMessage =
      /(?:this (?:question|field) is required|requires? that you .* to apply)/i;

    for (const field of fields) {
      if (field instanceof HTMLInputElement && SKIP_TYPES.has(field.type)) continue;

      const labels = Array.from(el.querySelectorAll('label'));
      const labelText = labels
        .filter((label) => {
          if (field.id && label.htmlFor === field.id) return true;
          return field.closest('label') === label || field.parentElement?.querySelector('label') === label;
        })
        .map((label) => label.textContent?.trim() ?? '')
        .join(' ');

      let hasRequiredMarker = /\*\s*$/.test(labelText);
      let hasRequiredMessage = false;
      let ancestor = field.parentElement;
      for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
        const precedingText = ancestor.previousElementSibling?.textContent?.trim() ?? '';
        if (/\*\s*$/.test(precedingText)) hasRequiredMarker = true;
        if (requiredMessage.test(ancestor.innerText)) {
          hasRequiredMessage = true;
          break;
        }
      }

      const isRequired =
        field.required ||
        field.getAttribute('aria-required') === 'true' ||
        hasRequiredMarker ||
        hasRequiredMessage;

      if (!isRequired) continue;

      const value =
        field instanceof HTMLSelectElement
          ? field.value
          : field.value?.trim() ?? '';

      if (!value) return true;
    }

    return false;
  });
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

  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}
