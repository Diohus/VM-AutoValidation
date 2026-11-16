# Instructions for Codex

## Project goal
Build a Vietnamese interactive laboratory result review demo for physician workflow feedback. Preserve the existing usable demo while improving it in small, reviewable increments.

## Scope and boundaries
- Use synthetic fixtures only. Never import patient records, identifiers, credentials or real clinical notes into source, tests or external services.
- This is a workflow prototype, not a clinically validated autoverification product.
- Keep simulation labels visible. Do not invent clinical thresholds, model accuracy, confidence scores, approvals or production readiness.
- No real signing, LIS writes, result release, diagnosis or treatment recommendations.
- A history or disease context must never override a mandatory technical hold.
- Missing, not ordered, pending, failed and not applicable must be distinct states in the target data model. Never encode missing as 0.
- Preserve result versions and time-aware context when implementing the target data model.
- Keep physician feedback separate from training labels. A final signed result is not automatically a valid label for the initial result.

## Working conventions
- Read README.md and docs before changes. Inspect current source rather than assuming the target database already exists.
- Prefer the current small dependency-free setup unless a requested feature clearly needs a new dependency.
- Separate fixtures, pure evaluation logic, UI and persistence. Do not scatter clinical logic through rendering functions.
- Escape user-entered text before rendering. Never use eval or new Function for configurable rule expressions.
- Keep Vietnamese UI and accessible form labels. Preserve desktop and small-screen usability.
- Do not introduce authentication, cloud storage, LLM APIs or external connections without an actual requirement.
- All changes to rules need tests covering triggered, not applicable and missing-data behavior where relevant. Test interactions between mandatory and optional checks.

## Validation
Run `npm test` and `npm run check`. For UI changes, run the local server and inspect the affected interaction when browser tools are available. Report what was tested and any unverified behavior honestly.

## Delivery
Keep changes on a feature branch when the repository already has a main branch with commits. Give a concise description of changes, checks and remaining limitations. Do not claim changes were pushed or a PR was opened unless verified.
