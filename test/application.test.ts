import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { hasMandatoryAdditionalFields } from '../src/wellfound/application.js';

async function hasMandatoryField(html: string): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="dialog">${html}</div>`);
    return await hasMandatoryAdditionalFields(page.locator('[role="dialog"]'));
  } finally {
    await browser.close();
  }
}

test('detects an empty field marked required in its label', async () => {
  assert.equal(await hasMandatoryField('<label for="note">Cover Letter*</label><textarea id="note"></textarea>'), true);
});

test('detects an empty textarea with a required validation message', async () => {
  assert.equal(await hasMandatoryField('<div><span>What interests you about working here?*</span></div><div><textarea></textarea></div><div>This question is required</div>'), true);
});

test('detects a required marker in the heading before a textarea', async () => {
  assert.equal(await hasMandatoryField('<div><h4>Cover Letter<span>*</span></h4></div><div><textarea></textarea></div>'), true);
});

test('detects a visible unchecked required checkbox', async () => {
  assert.equal(await hasMandatoryField('<label><input type="checkbox" required> I agree</label>'), true);
});

test('detects a visible required radio group with no selected choice', async () => {
  const html = '<fieldset aria-required="true"><legend>Work authorization</legend><label><input type="radio" name="authorized" value="yes"> Yes</label><label><input type="radio" name="authorized" value="no"> No</label></fieldset>';
  assert.equal(await hasMandatoryField(html), true);
});

test('allows a selected required radio group', async () => {
  const html = '<fieldset aria-required="true"><legend>Work authorization</legend><label><input type="radio" name="authorized" value="yes" checked> Yes</label><label><input type="radio" name="authorized" value="no"> No</label></fieldset>';
  assert.equal(await hasMandatoryField(html), false);
});

test('ignores hidden, disabled, and resume file inputs', async () => {
  const html = '<input required hidden><textarea required disabled></textarea><input type="file" required accept="application/pdf">';
  assert.equal(await hasMandatoryField(html), false);
});
