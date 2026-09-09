import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { hasMandatoryAdditionalFields } from '../src/wellfound/application.js';

test('detects an empty field marked required in its label', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog">
        <label for="note">Cover Letter*</label>
        <textarea id="note"></textarea>
      </div>
    `);

    const result = await hasMandatoryAdditionalFields(page.locator('[role="dialog"]'));
    assert.equal(result, true);
  } finally {
    await browser.close();
  }
});

test('detects an empty textarea with a required validation message', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog">
        <div><span>What interests you about working here?*</span></div>
        <div><textarea></textarea></div>
        <div>This question is required</div>
      </div>
    `);

    const result = await hasMandatoryAdditionalFields(page.locator('[role="dialog"]'));
    assert.equal(result, true);
  } finally {
    await browser.close();
  }
});

test('detects a required marker in the heading before a textarea', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog">
        <div><h4>Cover Letter<span>*</span></h4></div>
        <div><textarea></textarea></div>
      </div>
    `);

    const result = await hasMandatoryAdditionalFields(page.locator('[role="dialog"]'));
    assert.equal(result, true);
  } finally {
    await browser.close();
  }
});
