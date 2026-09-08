# AGENTS.md — Binding Instructions for Coding Agents

This repository is a hackathon PoC: an **autonomous shift handoff system** that tracks
operational events during a shift and produces a handoff containing only what still
matters (unresolved work, unresolved problems, conflicts, and items requiring a human
decision).

Every agent working in this repository MUST follow the rules below. They override any
general habit to "add more" or "prepare for the future". When in doubt, build less and
verify what exists.

---

## 1. Scope discipline

- Build the smallest useful thing first. Never add speculative features.
- Do not implement infrastructure merely because it may be useful later.
- Do not add authentication, cloud deployment, Kubernetes, queues, microservices,
  analytics, elaborate design systems, or similar infrastructure unless the current
  milestone explicitly requires them.
- Prefer deleting unnecessary complexity over extending it.
- Every feature must directly support the current product milestone.
- The non-goals list in the README (`Explicitly Out of Scope`) is binding until the
  user explicitly changes it.

## 2. Test-driven development (TDD)

All meaningful business logic must be developed using TDD:

1. Write or update a failing test that describes the intended behavior.
2. Run the test and verify that it fails **for the expected reason**.
3. Implement the minimum code required to make it pass.
4. Run the relevant tests.
5. Refactor only after tests pass.
6. Run the full test suite before considering the task complete.

Additional requirements:

- Never write a large implementation first and add superficial tests afterward.
- Bug fixes require a regression test that reproduces the bug **before** the fix.
- Tests must test behavior rather than implementation details wherever practical.
- Do not mock pure domain logic. Domain code is deterministic and testable directly.
- External systems (LLMs, databases, HTTP) may be faked behind interfaces in tests.

## 3. Verification

Never claim something works unless it has actually been run or tested.

Before completing any task:

- run the relevant tests
- run the full test suite (`npm test`)
- run lint/typecheck if configured (`npm run typecheck`)
- execute the application path affected by the change when practical

If something cannot be verified, explicitly state that it remains unverified.
Warnings and failed commands must not be silently ignored.
Never fabricate command output.

## 4. Code quality

Prefer:

- simple functions, explicit types, clear domain models
- deterministic behavior
- small modules, descriptive names
- clear boundaries between domain logic and external services

Avoid:

- giant files (split when a file stops having one clear job)
- unnecessary inheritance and premature abstractions
- framework magic and hidden global state
- duplicated business rules
- vague names such as `manager`, `handler`, `helper`, or `utils` when a more specific
  domain term exists

Comments should explain WHY something non-obvious exists, not narrate obvious code.

## 5. Architecture

- Core shift-state reasoning must not depend directly on: a web framework, a
  database, AWS, a specific LLM provider, Freebuff, or UI code.
- Keep core domain logic independently testable (plain TypeScript, no I/O).
- External systems sit behind narrow interfaces defined by the domain, not the vendor.
- For the PoC, prefer a modular monolith. Do not create microservices.

Layout rule: `src/domain/` must import only from the standard library and other domain
modules. Anything with I/O lives outside `src/domain/`.

## 6. AI/LLM discipline

- Do not use an LLM for logic that can be reliably expressed deterministically.
  Deterministic code owns: IDs, timestamps, state transitions, persistence, filtering,
  validation, sorting, conflict bookkeeping.
- An LLM may only interpret messy natural-language reports (Phase 5 ingestion).
- The flow is always:

  natural-language report → LLM structured extraction → schema validation →
  deterministic domain engine → state update

- Never allow arbitrary LLM output to directly mutate state without schema validation.
- Any LLM call must: use structured input, request structured output, validate the
  returned schema, fail safely, and be replaceable in tests (deterministic fake).
- The system must fully work with the LLM integration disabled.
- Never ask an LLM "what is the current state" from raw history; the state machine is
  the source of truth.

## 7. Data correctness

- Never silently discard contradictory information. Conflicts stay visible until
  explicitly reconciled by a human decision.
- Resolved events must not appear as unresolved merely because they occurred earlier.
- Historical events remain available even after the current state changes.
- Chronology is authoritative: an older event never overwrites a newer known state.
- The system distinguishes: event history, current state, unresolved issues, conflicts,
  human-decision-required items.

## 8. Git / change discipline

- Make focused changes. Do not rewrite unrelated files.
- Do not perform broad formatting changes unrelated to the task.
- Do not remove existing functionality unless necessary and explained.
- Never commit secrets, credentials, `.env` contents, API keys, or generated build
  artifacts (node_modules, dist, *.sqlite files, etc.).

**Repository-specific git rules (binding):**

- The human owner of this repository is the ONLY contributor. Never add Co-Authored-By
  trailers, attribution footers, or "Generated with ..." lines of any kind — including
  Codebuff, Freebuff, or any other tool/agent — to any commit message.
- Never alter `git config`, never create commits impersonating another identity, and
  never push to remotes unless the user explicitly asks.
- Commit locally only. Small, descriptive commits tied to one task each.

## 9. Dependencies

- Prefer the standard library and existing dependencies.
- Every new dependency must solve a concrete current problem.
- Do not install a large framework for something that can reasonably be implemented
  simply. Record any new dependency and its justification in the commit message.

## 10. Documentation

- The README must reflect what actually exists, never planned functionality disguised
  as completed functionality.
- Keep a short section titled `Current PoC Scope` and another titled
  `Explicitly Out of Scope`. Update them when scope changes.
- Keep the local run instructions exact and current: one command for dev, one for tests.

## 11. Agent behavior

When beginning a task:

1. Inspect the repository (structure, git status, current branch).
2. Read this AGENTS.md.
3. Inspect relevant tests.
4. Understand existing behavior before editing.

When finishing a task, report:

- what changed
- tests added/changed
- commands actually run
- whether they passed
- known limitations
- the next smallest logical milestone

Do not provide fabricated command output. Do not mark TODOs as completed unless
implemented and verified.

---

## Project conventions

- Language: TypeScript (strict). Runtime: Node.js. Test runner: node:test.
- Package manager: npm. Do not switch without user approval.
- Tests live next to the code they test (`*.test.ts`).
- Domain tests first: every new domain behavior starts as a failing test in
  `src/domain/*.test.ts`.
- No default exports; named exports only.
