# Glassdoor India Easy Apply support

**Date:** 2026-09-09  
**Status:** Approved in chat

## Goal

Add a Glassdoor India mode to `job-auto-apply` that processes native Glassdoor Easy Apply listings while skipping Indeed, ATS, external, CAPTCHA, and incomplete required-question flows.

## Scope

- Add a dedicated `src/glassdoor/` adapter.
- Add the `pnpm start:glassdoor` command.
- Use Glassdoor India as the default region.
- Let the user log in and set filters in the visible browser before processing.
- Harvest job cards from the current Glassdoor results page.
- Support Glassdoor's `&p=N` pagination, defaulting to one page.
- Process only enabled native Easy Apply actions.
- Reuse the existing persistent browser profile, logger, screenshots, and result categories.
- Add local regression tests and a read-only live smoke check.

## Non-goals

- Do not automate Indeed, affiliate, ATS, employer-site, email, or other external applications.
- Do not answer free-text or screening questions.
- Do not upload or replace a resume.
- Do not bypass Cloudflare, CAPTCHA, login walls, or other access controls.
- Do not add a new browser, scraping, or test dependency.

## Architecture

Create four site-specific files:

- `src/glassdoor/selectors.ts` owns Glassdoor URL patterns and selectors.
- `src/glassdoor/jobs.ts` owns result harvesting, pagination, job navigation, metadata, and Easy Apply detection.
- `src/glassdoor/application.ts` owns modal/new-tab classification, external/CAPTCHA/required-field checks, multi-step navigation, submission, confirmation, and screenshots.
- `src/glassdoor/index.ts` owns the interactive CLI flow and summary counters.

The adapter reuses `launchBrowser`, `getActivePage`, `closeBrowser`, and the existing logger. The generic required-field guard from the Wellfound adapter is reused rather than reimplemented.

Add this package script:

```json
"start:glassdoor": "tsx src/glassdoor/index.ts"
```

## Configuration

The CLI reads these values after `dotenv/config`:

- `GLASSDOOR_JOBS_URL`: optional starting URL. Default: `https://www.glassdoor.co.in/Job/easy-apply-jobs-SRCH_KO0%2C10.htm`
- `GLASSDOOR_MAX_PAGES`: optional positive integer. Default: `1`.

The user can still replace the default URL by navigating to a filtered results page before pressing ENTER. The default keeps the first run scoped to one page so a broad search cannot trigger an unexpectedly large application pass.

## Data flow

1. Launch the persistent browser with the existing profile.
2. Navigate to the configured Glassdoor India Easy Apply URL when the active page is not already on Glassdoor.
3. Wait for the user to log in and adjust filters.
4. After the user presses ENTER, wait at least five seconds for Glassdoor's Cloudflare-managed check and client rendering.
5. If the title still indicates a security challenge or the URL contains a challenge token, save a screenshot and stop with an error.
6. Dismiss a visible cookie or sign-in modal before extracting cards.
7. Harvest cards from `li[data-jobid]`; fall back to `[class*="JobsList_jobListItem"]` if needed.
8. Extract the title, company, location, and canonical `/job-listing/` URL from each card. Preserve the `jl` query parameter when present.
9. For pages after the first, append `p=N` to the current search URL. Stop when a page yields no cards or reaches `GLASSDOOR_MAX_PAGES`.
10. Deduplicate URLs and process them in order.
11. Open each job detail page, read metadata, skip already-applied jobs, and find only native Easy Apply controls.
12. Open the Easy Apply surface and run the application state machine below.
13. Record one result per job, pause briefly between jobs, print the existing-style summary, and close the browser.

## Selectors and classification

Selectors must prefer stable attributes and text, with hashed class-prefix fallbacks:

- Result cards: `li[data-jobid]`, then `[class*="JobsList_jobListItem"]`.
- Card title: `[data-test="job-title"]`, then `a[class*="JobCard_jobTitle"]`.
- Company: `[data-test="employer-name"]`, then `[class*="JobCard_employer"]`.
- Location: `[data-test="emp-location"]`, then `[class*="JobCard_location"]`.
- Job link: `a[href*="/job-listing/"]`.
- Native apply: enabled controls containing `Easy Apply` or a stable Easy Apply test attribute.
- Already applied: visible `Applied` controls or applied badges scoped to the job detail content.
- Dialog: `[role="dialog"]`, `[aria-modal="true"]`, and Glassdoor application-container prefixes.
- External indicators: visible text or links containing `Indeed`, `Apply on employer site`, `Apply on company website`, `Continue to company site`, or an off-domain ATS URL.
- CAPTCHA: reCAPTCHA, hCaptcha, Cloudflare challenge frames, sitekeys, or visible challenge copy.
- Next-step controls: scoped `Next`, `Continue`, or `Review` buttons.
- Final submit controls: scoped `Submit application`, `Send application`, or the final Easy Apply submit action.
- Success: visible `Application submitted`, `Application sent`, `Applied`, or a Glassdoor success test attribute.

The adapter must never use a broad page-level `Apply` selector that could click an external application control.

## Application state machine

For each job:

1. Click the native Easy Apply control while registering a new-page listener.
2. Wait for modal animation/navigation.
3. If a new page opens, close it and classify it as external unless it remains on Glassdoor.
4. Find the visible application dialog. If none appears, save a screenshot and return `skipped_error`.
5. Before every step, check CAPTCHA and external indicators.
6. Before advancing or submitting, run the required-field guard. If any visible field is empty and required by semantic attributes, a required marker, or validation copy, close the surface and return `skipped_mandatory_fields`.
7. Leave optional note and cover-letter fields untouched.
8. If a scoped Next/Continue/Review button is visible, click it and wait for the next step. Limit this loop to five steps.
9. Otherwise find the scoped final submit control. If none exists, save a screenshot and return `skipped_error`.
10. Click submit and wait for a success indicator, dialog closure, or a confirmed URL/state change.
11. Verify the applied state when possible. Treat a confirmed submission without a state-change indicator as `applied` with the existing note.
12. Close any remaining modal before continuing.

A required question on any step prevents submission. The adapter does not invent answers or send user-written content.

## Error handling and safety

- A Cloudflare or login block during initial harvest stops the entire run because the job set is unknown.
- A missing Easy Apply button returns `skipped_no_apply_button`.
- A native form with required empty fields returns `skipped_mandatory_fields`.
- A CAPTCHA returns `skipped_captcha`.
- A new tab or dialog that leads to Indeed, an ATS, an employer site, or another domain returns `skipped_external` and closes the new page.
- A missing form, missing submit control, timeout, or unconfirmed submission saves a timestamped screenshot and returns `skipped_error`.
- Account-level rate-limit or application-cap copy stops the run after closing the dialog.
- All selectors are scoped to the current job detail or application surface so background navigation controls cannot be clicked.

## Testing

Create local Node test-runner tests using Playwright and `page.setContent`:

- Extract titles and canonical URLs from `li[data-jobid]` cards.
- Use the class-prefix fallback when `data-jobid` cards are absent.
- Deduplicate repeated card URLs while preserving `jl`.
- Identify native Easy Apply and reject generic/external Apply controls.
- Detect already-applied state within job content.
- Detect required fields from attributes, label/heading `*`, and validation copy.
- Advance through a Next/Continue step and select the final submit control within a dialog.
- Classify an external/Indeed link and a missing dialog.

Run:

```sh
pnpm exec tsx --test test/glassdoor.test.ts
pnpm run build
```

Run one read-only live smoke against the public Glassdoor India Easy Apply URL after the five-second rendering wait. Report the number of cards and a sample canonical URL. Do not click a job, open an application, log in, or submit.

## Acceptance criteria

- `pnpm start:glassdoor` launches the same visible persistent browser and pauses for user setup.
- A filtered Glassdoor India page yields deduplicated job URLs.
- Pagination honors `GLASSDOOR_MAX_PAGES`.
- Only native Easy Apply jobs reach the submit path.
- Required questions, CAPTCHA, external/Indeed flows, and missing controls are skipped safely.
- A successful native Easy Apply submission is confirmed and counted.
- The local Glassdoor tests and TypeScript build pass.
- README documents the new command, default URL, and environment overrides.
