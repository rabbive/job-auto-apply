## Final safety-fix wave — 2026-09-11

- Replaced substring-based Glassdoor domain checks with parsed, anchored allowlisting for glassdoor.com and glassdoor.co.in (including subdomains), rejecting lookalike hosts.
- Restricted Easy Apply and final-submit actions to exact native labels or stable attributes. Every in-modal navigation and final-submit click rechecks visible external, employer-site, Indeed, and ATS links.
- Submission now requires an explicit Glassdoor success state (exact confirmation text in a success/status element); a generic dialog close is not success. URL changes are logged only as a state transition while confirmation is awaited.
- Extended shared mandatory-field detection to enabled, visible required checkboxes and radio groups, while ignoring hidden, disabled, and file controls.
- Added selector fallbacks for JobsList cards, job metadata, native dialogs, and applied controls; canonicalized job URLs to origin/path plus jl.
- Pagination stops at the first empty page and raises on a Cloudflare block after navigation. Cloudflare, CAPTCHA, account-limit, external-link, modal, negative-applied, and pagination coverage now uses local intercepted fixtures only.
- Added listener cleanup with try/finally, detail-company metadata preference, and a narrower README selector-update note.

Verification:

- Red phase: `pnpm exec tsx --test test/application.test.ts test/glassdoor.test.ts` failed against the pre-fix source for host allowlisting, selectors, pagination, CAPTCHA/account cap, external-link detection, required choices, and unverified submission closure.
- Green phase: `pnpm exec tsx --test test/application.test.ts test/glassdoor.test.ts` passed (32 tests).
- Build: `pnpm run build` passed.
- Whitespace: `git diff --check` passed.

Test-generated screenshots from the red/green runs were removed. Existing screenshot files were retained.
