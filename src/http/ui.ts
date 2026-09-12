/**
 * Server-rendered shell + vanilla JS client. No framework, no build step
 * (AGENTS.md §4/§9): the PoC needs functional clarity, not polish machinery.
 *
 * Design intent (submission milestone): an operational console, not an AI toy.
 * A neutral surface system, one accent for action, four semantic status tokens,
 * and hierarchy carried by type scale and spacing rather than color. Status is
 * never color-only — every chip carries an icon *and* a word, so the four states
 * stay distinguishable in grayscale, for color-blind readers, and in a
 * compressed screen recording.
 *
 * All colors are CSS custom properties below so contrast can be audited in one
 * place (see ui.test.ts and the contrast check in the README).
 */

const KIND_OPTIONS = [
  ["problem_reported", "Problem reported"],
  ["cleared", "Cleared / unblocked"],
  ["work_completed", "Work completed"],
  ["status_claimed", "Status claimed (needs claim)"],
] as const;

const KIND_OPTIONS_HTML = KIND_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

const STATUS_LABELS: Record<string, string> = {
  open: "OPEN",
  resolved: "RESOLVED",
  conflicted: "CONFLICT",
  decided: "DECIDED",
};

/**
 * Status icons are drawn inline (currentColor) rather than pulled from an icon
 * font or emoji: they stay crisp at small sizes, inherit the chip's semantic
 * color, and never depend on a network font.
 */
const STATUS_ICONS: Record<string, string> = {
  open:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6v3.7l2.4 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  conflicted:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M8 2.1 14.5 13.6H1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.6v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.9" fill="currentColor"/></svg>',
  resolved:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M3.2 8.4 6.4 11.6 12.8 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  decided:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.3 8.3 7.2 10.2 10.9 6.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const TRACE_ICONS: Record<string, string> = {
  success:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3.2 8.4 6.4 11.6 12.8 4.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

const KINDS_WITH_CLAIM = ["status_claimed"];

export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Shift Handoff — operational continuity for shift teams</title>
<style>
  /* ---- Design tokens: one place to audit palette, rhythm, and radii ---- */
  :root {
    /* System stack only: nothing is bundled or fetched, so the UI renders
       identically with no network and cannot shift because a webfont is
       missing (the recording machine's UI font is the only variable). */
    --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

    /* Ink: 1 = primary, 2 = secondary, 3 = meta. All AA on white and on surface-2. */
    --ink-1: #0f1319;
    --ink-2: #3b444f;
    --ink-3: #5f6874;

    --surface-0: #f1f3f6;   /* page */
    --surface-1: #ffffff;   /* panels */
    --surface-2: #f7f9fb;   /* insets, table stripes */
    --surface-3: #eaeef2;   /* sunken / inert */

    --line-1: #dbe0e7;      /* panel borders */
    --line-2: #e9edf1;      /* internal dividers */
    --line-strong: #7a848f; /* interactive control borders (>=3:1 on white) */

    --accent: #1c4a70;
    --accent-ink: #163d5d;
    --accent-hover: #143a5a;
    --accent-soft: #eaf1f7;
    --focus: #2f6fb5;

    /* Semantics: distinct hue + distinct icon + distinct word. */
    --open-ink: #8a4a05;   --open-bg: #fdf3e4;   --open-line: #edd4ad;
    --conflict-ink: #9d1f28; --conflict-bg: #fdeeef; --conflict-line: #f0cfd3;
    --resolved-ink: #4f5a66; --resolved-bg: #eff2f5; --resolved-line: #dde2e8;
    --decided-ink: #14507f;  --decided-bg: #eaf1f8;  --decided-line: #cbdceb;

    --trace-bg: #10151c;
    --trace-line: #26313f;
    --trace-ink: #dbe2ea;
    --trace-ink-2: #9db0c4;
    --trace-ok: #6cd79b;
    --trace-bad: #ff9d94;

    --radius-xs: 3px;
    --radius-sm: 5px;
    --radius-md: 8px;

    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-5: 1.5rem;
    --space-6: 2rem;
    --space-7: 3rem;

    --shadow-1: 0 1px 2px rgba(15, 19, 25, 0.05);
    --shadow-2: 0 10px 24px -14px rgba(15, 19, 25, 0.28);

    --wrap: 1140px;
  }

  * { box-sizing: border-box; }

  /* Our component classes set display, which would otherwise beat the UA's
     [hidden] rule and leave "hidden" fields and previews on screen. */
  [hidden] { display: none !important; }

  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--surface-0);
    color: var(--ink-1);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: 1.55;
    font-feature-settings: "tnum" 1;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 var(--space-5) var(--space-7); }

  /* ---- Focus: one consistent, high-contrast ring everywhere ---- */
  :where(a, button, input, select, summary, [tabindex]):focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    border-radius: var(--radius-xs);
  }
  :where(button, input, select):focus:not(:focus-visible) { outline: none; }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  .skip-link {
    position: absolute; left: var(--space-4); top: -3rem;
    background: var(--accent); color: #fff; text-decoration: none;
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
    font-size: 0.9rem; font-weight: 600; transition: top 120ms ease;
  }
  .skip-link:focus { top: var(--space-3); }

  /* ---- App bar: identity + the one-sentence explanation ---- */
  .appbar { background: var(--surface-1); border-bottom: 1px solid var(--line-1); }
  .appbar__inner {
    max-width: var(--wrap); margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-4);
    display: grid; gap: var(--space-3) var(--space-5);
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
  }
  .brand { display: flex; align-items: center; gap: var(--space-3); grid-column: 1; }
  .mark {
    width: 30px; height: 30px; border-radius: 7px; background: var(--accent);
    color: #fff; display: grid; place-items: center; flex: none;
  }
  .wordmark { margin: 0; font-size: 1.28rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; }
  .eyebrow {
    font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--ink-3); margin: 0;
  }
  .product { display: grid; gap: 2px; }
  .badge-poc {
    font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-2);
    border: 1px solid var(--line-1); background: var(--surface-2);
    border-radius: var(--radius-xs); padding: 2px 6px;
  }
  .tagline {
    grid-column: 1 / -1; margin: 0; max-width: 72ch; color: var(--ink-2);
    font-size: 1.02rem; line-height: 1.5;
  }
  .tagline strong { color: var(--ink-1); font-weight: 650; }
  .appbar__actions { grid-column: 2; grid-row: 1; justify-self: end; }

  /* ---- Status system ---- */
  .legend { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: 0; padding: 0; list-style: none; }
  .legend__item { display: flex; align-items: center; gap: var(--space-2); font-size: 0.84rem; color: var(--ink-3); }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    font-family: var(--font-mono); font-size: 0.71rem; font-weight: 600;
    letter-spacing: 0.07em; text-transform: uppercase;
    border: 1px solid; border-radius: var(--radius-xs);
    padding: 2px 6px 2px 5px; white-space: nowrap; vertical-align: middle;
  }
  .chip--open { color: var(--open-ink); background: var(--open-bg); border-color: var(--open-line); }
  .chip--conflicted { color: var(--conflict-ink); background: var(--conflict-bg); border-color: var(--conflict-line); }
  .chip--resolved { color: var(--resolved-ink); background: var(--resolved-bg); border-color: var(--resolved-line); }
  .chip--decided { color: var(--decided-ink); background: var(--decided-bg); border-color: var(--decided-line); }

  /* ---- Panels ---- */
  .panel {
    background: var(--surface-1); border: 1px solid var(--line-1);
    border-radius: var(--radius-md); box-shadow: var(--shadow-1);
  }
  .panel--emphasis { box-shadow: var(--shadow-2); }
  .panel__head {
    padding: var(--space-4) var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--line-2);
    display: grid; gap: 2px;
  }
  .panel__title { margin: 0; font-size: 1.02rem; font-weight: 650; letter-spacing: -0.01em; }
  .panel__hint { margin: 0; font-size: 0.86rem; color: var(--ink-3); }
  .panel__body { padding: var(--space-4); }

  /* ---- Buttons and fields ---- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
    font: inherit; font-size: 0.92rem; font-weight: 550; line-height: 1.2;
    color: var(--ink-1); background: var(--surface-1);
    border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
    padding: 0.5rem 0.85rem; cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); border-color: var(--ink-3); }
  .btn:active:not(:disabled) { background: var(--surface-3); }
  .btn:disabled { color: var(--ink-3); background: var(--surface-2); border-color: var(--line-1); cursor: not-allowed; }
  .btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn--primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn--primary:active:not(:disabled) { background: var(--accent-ink); }
  .btn--ghost { border-color: var(--line-1); color: var(--ink-2); background: transparent; }
  .btn--ghost:hover:not(:disabled) { background: var(--surface-2); border-color: var(--line-strong); color: var(--ink-1); }
  .btn--choice { justify-content: flex-start; text-align: left; }

  .field { display: grid; gap: 4px; min-width: 0; }
  .field__label {
    font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--ink-3);
  }
  input[type="text"], input[type="datetime-local"], input[type="file"], input:not([type]), select {
    font: inherit; font-size: 0.94rem; color: var(--ink-1);
    background: var(--surface-1);
    border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
    padding: 0.48rem 0.6rem; min-width: 0; max-width: 100%;
  }
  input::placeholder { color: var(--ink-3); opacity: 1; }
  input:disabled, select:disabled { background: var(--surface-2); color: var(--ink-3); }
  input[type="file"] { padding: 0.34rem 0.4rem; }
  input[type="file"]::file-selector-button {
    font: inherit; font-size: 0.88rem; font-weight: 550; margin-right: var(--space-2);
    color: var(--ink-1); background: var(--surface-2);
    border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
    padding: 0.32rem 0.6rem; cursor: pointer;
  }
  input[type="file"]::file-selector-button:hover { background: var(--surface-3); }

  .meta { margin: var(--space-2) 0 0; font-size: 0.84rem; color: var(--ink-3); }
  .meta b { color: var(--ink-2); font-weight: 600; }
  .mono { font-family: var(--font-mono); font-size: 0.8rem; }

  .alert {
    margin: var(--space-2) 0 0; padding: var(--space-2) var(--space-3);
    font-size: 0.88rem; font-weight: 550;
    color: var(--conflict-ink); background: var(--conflict-bg);
    border: 1px solid var(--conflict-line); border-radius: var(--radius-sm);
  }
  .alert:empty { display: none; }

  /* ---- Layout: interaction on the left, operational truth in a right rail.
     The two columns are independent stacks: a single grid of rows would couple
     panel heights and open dead space in the shorter column. ---- */
  .workspace { display: grid; gap: var(--space-5); margin-top: var(--space-5); align-items: start; }
  .col { display: grid; gap: var(--space-5); align-content: start; min-width: 0; }
  @media (min-width: 1000px) {
    .workspace { grid-template-columns: minmax(0, 7fr) minmax(0, 4.3fr); }
  }

  /* ---- Toolbar (shift setup; hidden in presentation view) ---- */
  .toolbar { padding: var(--space-4); display: grid; gap: var(--space-3); }
  .toolbar__row { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end; }
  .toolbar__row .field--grow { flex: 1 1 12rem; }
  .toolbar__end { margin-left: auto; }

  details.disclosure { border-top: 1px solid var(--line-2); padding-top: var(--space-3); }
  details.disclosure > summary {
    cursor: pointer; font-size: 0.86rem; font-weight: 550; color: var(--ink-2);
    list-style: none; display: flex; align-items: center; gap: var(--space-2);
  }
  details.disclosure > summary::-webkit-details-marker { display: none; }
  details.disclosure > summary::before { content: "▸"; color: var(--ink-3); font-size: 0.8rem; }
  details.disclosure[open] > summary::before { content: "▾"; }
  .steps { margin: var(--space-3) 0 0; padding-left: 1.3rem; color: var(--ink-2); font-size: 0.89rem; }
  .steps li { margin: 0.15rem 0; }
  .steps em { color: var(--ink-1); font-style: normal; font-weight: 550; }

  /* ---- Agent ---- */
  .agent-form { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
  .agent-form .field { flex: 1 1 16rem; }
  /* The acting identity is short and fixed-width enough not to compete with the
     message field, and it stays visible in presentation view. */
  .agent-form .field--actor { flex: 0 1 12rem; }
  .reply {
    margin: var(--space-4) 0 0; padding: var(--space-1) 0 var(--space-1) var(--space-3);
    border-left: 3px solid var(--accent); font-size: 1rem; color: var(--ink-1);
  }
  .reply__label {
    display: block;    font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--ink-3); margin-bottom: 2px;
  }
  .trace { margin-top: var(--space-4); background: var(--trace-bg); border: 1px solid var(--trace-line); border-radius: var(--radius-sm); overflow: hidden; }
  .trace__head {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: 6px var(--space-3); border-bottom: 1px solid var(--trace-line);
    font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--trace-ink-2);
  }
  .trace__list { margin: 0; padding: var(--space-2) 0; list-style: none; }
  .trace__row {
    display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: var(--space-2);
    align-items: baseline; padding: 3px var(--space-3);
    font-family: var(--font-mono); font-size: 0.82rem; color: var(--trace-ink);
  }
  .trace__row--error { background: rgba(255, 157, 148, 0.08); }
  .trace__status { display: grid; place-items: center; }
  .trace__status--success { color: var(--trace-ok); }
  .trace__status--error { color: var(--trace-bad); }
  .trace__tool { font-weight: 650; color: #fff; }
  .trace__detail { color: var(--trace-ink-2); min-width: 0; overflow-wrap: anywhere; }
  .trace__flag {
    font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--trace-bad); font-weight: 600;
  }
  .trace__empty { padding: var(--space-2) var(--space-3); font-family: var(--font-mono); font-size: 0.79rem; color: var(--trace-ink-2); }
  .agent-note { margin: var(--space-3) 0 0; font-size: 0.84rem; color: var(--ink-3); }

  /* ---- Report ---- */
  .report-block { display: grid; gap: var(--space-3); }
  .report-block + .report-block { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--line-2); }
  .report-block__title { margin: 0; font-size: 0.92rem; font-weight: 650; }
  .report-block__hint { margin: 0; font-size: 0.84rem; color: var(--ink-3); }
  .inline-form { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
  .inline-form .field { flex: 1 1 14rem; }
  .photo-preview { display: flex; gap: var(--space-3); align-items: flex-start; margin: 0; }
  .photo-preview img {
    width: 88px; height: 66px; object-fit: cover; border-radius: var(--radius-xs);
    border: 1px solid var(--line-1); background: var(--surface-2);
  }
  .result { margin: var(--space-3) 0 0; font-size: 0.88rem; color: var(--ink-2); }
  .result:empty { display: none; }
  .result code { font-family: var(--font-mono); font-size: 0.82rem; color: var(--ink-1); }

  #eventForm { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
  .grid-2 { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }

  /* ---- Current state ---- */
  .cards { display: grid; gap: var(--space-3); }
  .card {
    border: 1px solid var(--line-1); border-left-width: 3px; border-radius: var(--radius-sm);
    padding: var(--space-3); background: var(--surface-1);
  }
  .card--open { border-left-color: var(--open-ink); }
  .card--conflicted { border-left-color: var(--conflict-ink); background: var(--conflict-bg); border-color: var(--conflict-line); }
  /* Resolved items recede: the rail here is decorative (the chip carries the
     state), so it is allowed to sit below the 3:1 non-text contrast bar. */
  .card--resolved { border-left-color: #c9d0d8; background: var(--surface-2); }
  .card--resolved .card__subject, .card--resolved .card__desc { color: var(--ink-2); }
  .card--decided { border-left-color: var(--decided-ink); background: var(--decided-bg); border-color: var(--decided-line); }
  .card__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .card__subject { margin: 0; font-size: 0.97rem; font-weight: 650; }
  .card__desc { margin: var(--space-2) 0 0; font-size: 0.88rem; color: var(--ink-2); overflow-wrap: anywhere; }
  .claims { margin: var(--space-2) 0 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  .claims li { display: flex; align-items: baseline; gap: var(--space-2); font-size: 0.86rem; }
  .claims__value { font-family: var(--font-mono); font-size: 0.8rem; color: var(--ink-1); }
  .claims__time { font-family: var(--font-mono); font-size: 0.74rem; color: var(--ink-3); }
  .card__decision { margin: var(--space-2) 0 0; font-size: 0.88rem; color: var(--ink-1); }
  .card__decision span {
    font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--ink-3); margin-right: var(--space-2);
  }
  /* A decision shown on a conflicted item is one a human reopened, so it is
     labelled as superseded rather than presented as current truth. */
  .card__decision--superseded span { color: var(--conflict-ink); }
  .card__provenance { margin: 2px 0 0; font-size: 0.85rem; color: var(--ink-2); }
  .card__provenance b { color: var(--ink-1); font-weight: 600; }
  .card__blocked { margin: var(--space-2) 0 0; font-size: 0.82rem; color: var(--ink-3); }
  .review {
    margin-top: var(--space-3); padding: var(--space-3);
    background: var(--surface-1); border: 1px solid var(--conflict-line);
    border-radius: var(--radius-sm);
  }
  .review__title {
    margin: 0; display: flex; align-items: center; gap: var(--space-2);
    font-size: 0.86rem; font-weight: 650; color: var(--conflict-ink);
  }
  .review__hint { margin: 4px 0 var(--space-3); font-size: 0.83rem; color: var(--ink-2); }
  .review__choices { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-end; }
  .review__choices .field { flex: 1 1 13rem; }
  /* Reopening is the inverse of deciding, so it borrows the review layout with
     the decided palette: it reads as part of the same audit surface. */
  .review--decided { border-color: var(--decided-line); }
  .review--decided .review__title { color: var(--decided-ink); }
  .empty { margin: 0; font-size: 0.88rem; color: var(--ink-3); }

  /* Mutation feedback. Stays rendered while empty (a display:none live region
     is not reliably announced) but collapses to zero height. */
  .mutation {
    margin: 0; padding: 0 0 0 var(--space-3); border-left: 3px solid transparent;
    font-size: 0.88rem; font-weight: 550; color: var(--ink-1);
  }
  .mutation:not(:empty) { margin-top: var(--space-3); border-left-color: var(--accent); }

  /* In-flight feedback: a second click cannot submit the same human action. */
  .btn[aria-busy="true"] { cursor: progress; opacity: 0.65; }

  /* ---- Handoff ---- */
  .handoff { display: grid; gap: var(--space-4); }
  .handoff__block { display: grid; gap: var(--space-2); }
  .handoff__title {
    margin: 0; display: flex; align-items: center; gap: var(--space-2);
    font-size: 0.8rem; font-weight: 650; letter-spacing: 0.02em; color: var(--ink-2);
  }
  .handoff__count {
    font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-3);
    border: 1px solid var(--line-1); border-radius: var(--radius-xs);
    padding: 0 5px; background: var(--surface-2);
  }
  .handoff__list { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-2); }
  .handoff__list li {
    padding-left: var(--space-3); border-left: 2px solid var(--line-1); font-size: 0.9rem;
  }
  .handoff__list li strong { font-weight: 650; }
  .handoff__list li.handoff__review { border-left-color: var(--conflict-ink); }
  .handoff__stats {
    margin: 0; padding-top: var(--space-3); border-top: 1px solid var(--line-2);
    display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5);
    font-size: 0.83rem; color: var(--ink-2);
  }
  .handoff__stats div { display: flex; align-items: baseline; gap: var(--space-2); }
  .handoff__stats dt { color: var(--ink-3); }
  .handoff__stats dd { margin: 0; font-family: var(--font-mono); font-weight: 650; color: var(--ink-1); }
  .handoff__noise { margin: 0; font-size: 0.82rem; color: var(--ink-3); }

  /* ---- Event history ---- */
  .timeline { margin: 0; padding: 0; list-style: none; display: grid; gap: 0; }
  .timeline > li {
    display: grid; grid-template-columns: 5.4rem minmax(0, 1fr); gap: var(--space-4);
    padding: var(--space-3) 0; border-top: 1px solid var(--line-2);
  }
  .timeline > li:first-child { border-top: 0; }
  .timeline time { font-family: var(--font-mono); font-size: 0.79rem; color: var(--ink-3); padding-top: 2px; }
  .event__head { margin: 0; font-size: 0.94rem; font-weight: 650; }
  /* History metadata stays quiet: every row carries one, so it must not
     compete with the subject or the status chips. */
  .event__kind {
    font-family: var(--font-mono); font-size: 0.69rem; font-weight: 500; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--ink-3); margin-left: var(--space-2);
  }
  .event__desc { margin: 2px 0 0; font-size: 0.88rem; color: var(--ink-2); overflow-wrap: anywhere; }
  .event__desc b { color: var(--ink-1); font-weight: 600; }

  .evidence {
    margin: var(--space-3) 0 0; padding: var(--space-3);
    display: flex; gap: var(--space-4); align-items: flex-start;
    background: var(--surface-2); border: 1px solid var(--line-1); border-radius: var(--radius-sm);
  }
  .evidence img {
    width: 132px; height: 100px; object-fit: cover; display: block;
    border: 1px solid var(--line-1); border-radius: var(--radius-xs); background: var(--surface-1);
  }
  .evidence figcaption { display: grid; gap: 2px; font-size: 0.83rem; color: var(--ink-2); overflow-wrap: anywhere; }
  .evidence__label {
    font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--ink-3);
  }
  .evidence__file { font-family: var(--font-mono); font-size: 0.78rem; color: var(--ink-2); }

  /* ---- Presentation view: hide editor chrome, keep the product ---- */
  body.present .admin, body.present .editor-only { display: none !important; }

  /* ---- Reduced motion ---- */
  @media (prefers-reduced-motion: reduce) {
    * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
  }

  @media (max-width: 700px) {
    .wrap, .appbar__inner { padding-left: var(--space-4); padding-right: var(--space-4); }
    .timeline > li { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
    .evidence { flex-direction: column; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>

<header class="appbar">
  <div class="appbar__inner">
    <div class="brand">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="17" height="17" focusable="false">
          <path d="M4 6.5h9.5M11 3.5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M16 13.5H6.5M9 10.5l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="product">
        <span class="eyebrow">Operational continuity</span>
        <h1 class="wordmark">Shift Handoff</h1>
      </span>
      <span class="badge-poc">PoC</span>
    </div>
    <div class="appbar__actions">
      <button id="presentBtn" class="btn btn--ghost" type="button" aria-pressed="false">Presentation view</button>
    </div>
    <p class="tagline">
      An append-only record of the shift, reduced to <strong>what still needs action</strong>.
      The agent runs the tools; the engine owns the truth — so a conflict stays visible until a human settles it.
    </p>
    <ul class="legend" aria-label="Status key">
      <li class="legend__item"><span class="chip chip--open">${STATUS_ICONS.open}<span>Open</span></span> still needs action</li>
      <li class="legend__item"><span class="chip chip--conflicted">${STATUS_ICONS.conflicted}<span>Conflict</span></span> contradictory reports, needs a human</li>
      <li class="legend__item"><span class="chip chip--decided">${STATUS_ICONS.decided}<span>Decided</span></span> closed by a human</li>
      <li class="legend__item"><span class="chip chip--resolved">${STATUS_ICONS.resolved}<span>Resolved</span></span> closed by events</li>
    </ul>
  </div>
</header>

<div class="wrap">
  <main id="main">
    <section class="panel toolbar admin" aria-labelledby="setupHeading">
      <h2 id="setupHeading" class="sr-only">Shift setup</h2>
      <div class="toolbar__row">
        <span class="field">
          <label class="field__label" for="shiftSelect">Shift</label>
          <select id="shiftSelect"></select>
        </span>
        <button id="loadBtn" class="btn" type="button">Load</button>
        <span class="field field--grow">
          <label class="field__label" for="newShiftName">New shift</label>
          <input id="newShiftName" type="text" placeholder="Night shift · Dock B">
        </span>
        <button id="createBtn" class="btn" type="button">Create</button>
        <button id="demoBtn" class="btn btn--primary" type="button">Load demo shift</button>
        <button id="endBtn" class="btn btn--ghost toolbar__end" type="button">End shift</button>
      </div>
      <p id="shiftMeta" class="meta"></p>
      <p id="error" class="alert" role="alert"></p>
      <details class="disclosure">
        <summary>Demo flow — five beats</summary>
        <ol class="steps">
          <li><em>Load demo shift</em> seeds a night shift as real events.</li>
          <li><em>Current state</em> shows routine issues already resolved and D104 conflicting.</li>
          <li>Ask the agent <em>“What should we do with D104?”</em> — it refuses to decide and asks for a human.</li>
          <li>Record the human decision on D104 (or ask for it explicitly) — the item becomes decided, attributed to whoever is named in <em>Acting as</em>.</li>
          <li>Optional: <em>Reopen decision</em> on D104 with a reason — it returns to conflict, and the original decision stays in history.</li>
          <li><em>Handoff</em> collapses to the one thing still open: the missed freezer inspection.</li>
        </ol>
      </details>
    </section>

    <div class="workspace">
      <div class="col col--main">
      <section id="agentSection" class="panel panel--emphasis" aria-labelledby="agentHeading" hidden>
        <div class="panel__head">
          <h2 id="agentHeading" class="panel__title">Talk to the shift agent</h2>
          <p class="panel__hint">Ask for the handoff, report what you see, or ask what still matters.</p>
        </div>
        <div class="panel__body">
          <form id="agentForm" class="agent-form">
            <span class="field field--actor">
              <label class="field__label" for="actor">Acting as</label>
              <input id="actor" type="text" value="Shift Supervisor" autocomplete="off">
            </span>
            <span class="field">
              <label class="field__label" for="agentText">Message</label>
              <input id="agentText" type="text" placeholder="Aisle 7 is blocked. / What does the morning shift need to know?" autocomplete="off">
            </span>
            <button id="agentBtn" class="btn btn--primary" type="submit">Send</button>
          </form>
          <p class="agent-note">Whoever is named here is recorded as the actor on any decision or reopen this turn makes — nothing is attributed without it. Every turn is a tool call against the deterministic engine; the trace below shows which tool ran and whether it succeeded.</p>
          <p id="agentReply" class="reply" hidden aria-live="polite"></p>
          <div id="agentTrace" class="trace" hidden aria-live="polite"></div>
        </div>
      </section>

      <section id="reportSection" class="panel" aria-labelledby="reportHeading" hidden>
        <div class="panel__head">
          <h2 id="reportHeading" class="panel__title">Report</h2>
          <p class="panel__hint">Plain words, or a photo with a short note. Unreadable reports are refused, never guessed.</p>
        </div>
        <div class="panel__body">
          <div class="report-block">
            <h3 class="report-block__title">Photo evidence</h3>
            <form id="photoForm" class="inline-form">
              <span class="field">
                <label class="field__label" for="photoFile">Image</label>
                <input type="file" id="photoFile" accept="image/png,image/jpeg,image/webp,image/gif">
              </span>
              <span class="field">
                <label class="field__label" for="photoNote">Note</label>
                <input id="photoNote" type="text" placeholder="Aisle 7 is blocked." autocomplete="off">
              </span>
              <button id="photoBtn" class="btn" type="submit">Attach photo</button>
            </form>
            <figure id="photoPreview" class="photo-preview" hidden>
              <img id="photoPreviewImg" alt="">
              <figcaption id="photoPreviewText" class="meta"></figcaption>
            </figure>
            <p id="photoResult" class="result" aria-live="polite"></p>
          </div>

          <div class="report-block editor-only">
            <h3 class="report-block__title">In plain words</h3>
            <form id="nlForm" class="inline-form">
              <span class="field">
                <label class="field__label" for="nlText">Report</label>
                <input id="nlText" type="text" placeholder="Pallet 83 couldn't go out because aisle 7 is blocked" autocomplete="off">
              </span>
              <button id="nlBtn" class="btn" type="submit">Add report</button>
            </form>
            <p id="nlResult" class="result" aria-live="polite"></p>
            <p class="report-block__hint">Understood: problems with or without a cause, cleared, completed, and dispositions such as “case D104 should go to claims”.</p>
          </div>

          <div class="report-block editor-only">
            <h3 class="report-block__title">Exact event</h3>
            <details class="disclosure">
              <summary>Add a structured event</summary>
              <form id="eventForm">
                <div class="grid-2">
                  <span class="field">
                    <label class="field__label" for="occurredAt">When</label>
                    <input type="datetime-local" id="occurredAt" required>
                  </span>
                  <span class="field">
                    <label class="field__label" for="kind">Kind</label>
                    <select id="kind">${KIND_OPTIONS_HTML}</select>
                  </span>
                </div>
                <span class="field">
                  <label class="field__label" for="subject">Subject</label>
                  <input id="subject" type="text" placeholder="aisle 7" required>
                </span>
                <span class="field">
                  <label class="field__label" for="description">Description</label>
                  <input id="description" type="text" placeholder="what happened" required>
                </span>
                <span class="field" id="claimLabel" hidden>
                  <label class="field__label" for="claim">Claim</label>
                  <input id="claim" type="text" placeholder="send to claims">
                </span>
                <div class="grid-2">
                  <span class="field">
                    <label class="field__label" for="blockedBy">Blocked by (optional)</label>
                    <input id="blockedBy" type="text" placeholder="aisle 7">
                  </span>
                  <span class="field">
                    <label class="field__label" for="source">Source</label>
                    <input id="source" type="text" value="operator">
                  </span>
                </div>
                <span><button class="btn" type="submit">Add event</button></span>
              </form>
            </details>
          </div>
        </div>
      </section>

      <section id="historySection" class="panel" aria-labelledby="historyHeading" hidden>
        <div class="panel__head">
          <h2 id="historyHeading" class="panel__title">Event history</h2>
          <p class="panel__hint">Append-only. Nothing is edited or deleted; resolved work stays on the record.</p>
        </div>
        <div class="panel__body">
          <ol id="historyList" class="timeline"></ol>
        </div>
      </section>
      </div>

      <div class="col col--rail">
      <section id="stateSection" class="panel" aria-labelledby="stateHeading" hidden>
        <div class="panel__head">
          <h2 id="stateHeading" class="panel__title">Current state</h2>
          <p class="panel__hint">Folded from the event log in chronological order.</p>
        </div>
        <div class="panel__body">
          <div id="stateList" class="cards"></div>
          <p id="mutationResult" class="mutation" role="status" aria-live="polite"></p>
        </div>
      </section>

      <section id="handoffSection" class="panel" aria-labelledby="handoffHeading" hidden>
        <div class="panel__head">
          <h2 id="handoffHeading" class="panel__title">Handoff</h2>
          <p class="panel__hint">What the incoming shift actually needs.</p>
        </div>
        <div class="panel__body">
          <div id="handoffContent" class="handoff"></div>
        </div>
      </section>

      </div>
    </div>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);
const STATUS_LABELS = ${JSON.stringify(STATUS_LABELS)};
const STATUS_ICONS = ${JSON.stringify(STATUS_ICONS)};
const TRACE_ICONS = ${JSON.stringify(TRACE_ICONS)};
const KINDS_WITH_CLAIM = new Set(${JSON.stringify(KINDS_WITH_CLAIM)});

let currentShift = null;

// The alert element is always in the DOM so the live region exists before it
// changes; the stylesheet collapses it while it is empty.
function showError(msg) { $("error").textContent = msg || ""; }

async function api(path, options) {
  const res = await fetch(path, options && { ...options, headers: { "content-type": "application/json" } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}

function localNowForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

async function refreshShiftList() {
  const shifts = await api("/api/shifts");
  $("shiftSelect").innerHTML = shifts
    .map((s) => \`<option value="\${esc(s.id)}">\${esc(s.name)}\${s.endedAt ? " (ended)" : ""}</option>\`)
    .join("");
  if (currentShift) $("shiftSelect").value = currentShift.id;
}

async function loadShift() {
  showError("");
  const id = $("shiftSelect").value;
  if (!id) return;
  const [state, handoff] = await Promise.all([api(\`/api/shifts/\${id}/state\`), api(\`/api/shifts/\${id}/handoff\`)]);
  currentShift = state.shift;

  const ended = Boolean(currentShift.endedAt);
  $("shiftMeta").innerHTML = \`<b>\${esc(currentShift.name)}</b> · started \${fmt(currentShift.startedAt)}\${ended ? " · ended " + fmt(currentShift.endedAt) : ""}\`;
  $("reportSection").hidden = ended;
  $("endBtn").disabled = ended;
  $("agentSection").hidden = ended;

  $("historySection").hidden = false;
  $("historyList").innerHTML = state.events.map(renderEvent).join("") || "<li class='empty'>No events yet.</li>";

  $("stateSection").hidden = false;
  $("stateList").innerHTML = state.items.map(itemCard).join("") || "<p class='empty'>No operational items yet.</p>";

  $("handoffSection").hidden = false;
  $("handoffContent").innerHTML = renderHandoff(handoff);
}

function renderEvent(event) {
  const claim = event.claim ? \` · claim: <span class="claims__value">\${esc(event.claim)}</span>\` : "";
  // Human actions carry who authorized them and why; the append-only log is
  // only an audit trail if that attribution is visible in it.
  const provenance = event.actor || event.note
    ? \` · \${event.actor ? \`by <b>\${esc(event.actor)}</b>\` : "attributed"}\${event.note ? \` — “\${esc(event.note)}”\` : ""}\`
    : "";
  return \`<li>
    <time datetime="\${esc(event.occurredAt)}">\${fmt(event.occurredAt)}</time>
    <div>
      <p class="event__head">\${esc(event.subject)}<span class="event__kind">\${esc(event.kind)}</span></p>
      <p class="event__desc">\${esc(event.description)}\${claim}\${provenance}</p>
      \${renderEvidence(event)}
    </div>
  </li>\`;
}

function renderEvidence(event) {
  const evidence = event.evidence || [];
  if (!evidence.length) return "";
  return evidence
    .map((ev) => \`<figure class="evidence">
      <a href="/api/shifts/\${encodeURIComponent(event.shiftId)}/evidence/\${encodeURIComponent(ev.id)}" target="_blank" rel="noopener">
        <img src="/api/shifts/\${encodeURIComponent(event.shiftId)}/evidence/\${encodeURIComponent(ev.id)}" alt="Photo evidence attached to this report: \${esc(ev.note || ev.fileName)}">
      </a>
      <figcaption>
        <span class="evidence__label">Photo evidence</span>
        <span class="evidence__file">\${esc(ev.fileName)}</span>
        \${ev.note ? \`<span>\${esc(ev.note)}</span>\` : ""}
      </figcaption>
    </figure>\`)
    .join("");
}

function chip(status) {
  const label = STATUS_LABELS[status] || status;
  return \`<span class="chip chip--\${status}">\${STATUS_ICONS[status] || ""}<span>\${esc(label)}</span></span>\`;
}

function itemCard(item) {
  const claims = (item.claims || []).length
    ? \`<ul class="claims">\${item.claims
        .map((c) => \`<li><span class="claims__value">\${esc(c.value)}</span><span class="claims__time">\${fmt(c.occurredAt)}</span></li>\`)
        .join("")}</ul>\`
    : "";
  // A decision shown on a conflicted item is one a human reopened: it stays on
  // the record, but it is labelled as superseded rather than as current truth.
  const superseded = Boolean(item.status === "conflicted" && item.decision);
  const decision = item.decision
    ? \`<p class="card__decision\${superseded ? " card__decision--superseded" : ""}"><span>\${superseded ? "Reopened" : "Decision"}</span>\${esc(item.decision.value)}</p>\`
    : "";
  const provenance = item.reopened ? reopenProvenanceLine(item) : item.decision && (item.decision.actor || item.decision.note)
    ? \`<p class="card__provenance\">\${item.decision.actor ? \`Recorded by <b>\${esc(item.decision.actor)}</b>\` : "Recorded"}\${item.decision.note ? \` — “\${esc(item.decision.note)}”\` : ""}</p>\`
    : "";
  // One button per distinct canonical claim: the human picks between what was
  // actually reported — the system never invents options for them.
  const reported = item.claims || [];
  const choices = [...new Set(reported.map((c) => c.canonicalValue))]
    .map((canonical) => {
      const label = reported.find((c) => c.canonicalValue === canonical).value;
      return \`<button type="button" class="btn btn--choice decisionBtn" data-item="\${esc(item.canonicalSubject)}" data-claim="\${esc(canonical)}">\${esc(label)}</button>\`;
    })
    .join("");
  const review = item.status === "conflicted" && choices
    ? \`<div class="review" role="group" aria-label="Record a human decision for \${esc(item.subject)}">
        <p class="review__title">\${STATUS_ICONS.conflicted}Human decision required</p>
        <p class="review__hint">\${superseded ? "The previous decision was reopened, so this needs a new human choice." : "The agent will not choose for you. Pick the outcome that is actually true."}</p>
        <div class="review__choices">\${choices}</div>
      </div>\`
    : "";
  // Reopening is a human action with the same authority as deciding, so it is
  // offered only on a currently decided item and always sends the named actor.
  const reopen = item.status === "decided"
    ? \`<div class="review review--decided" role="group" aria-label="Reopen the decision for \${esc(item.subject)}">
        <p class="review__title">\${STATUS_ICONS.decided}Decision recorded by a human</p>
        <p class="review__hint">If that decision was wrong, reopen it. Nothing is deleted: the decision stays in history and the item returns to conflict.</p>
        <div class="review__choices">
          <span class="field">
            <label class="field__label" for="reopenReason-\${safeId(item.canonicalSubject)}">Reason (optional)</label>
            <input id="reopenReason-\${safeId(item.canonicalSubject)}" type="text" placeholder="Claims ticket was created in error" autocomplete="off">
          </span>
          <button type="button" class="btn reopenBtn" data-item="\${esc(item.canonicalSubject)}">Reopen decision</button>
        </div>
      </div>\`
    : "";
  const blocked = item.blockedByCanonicalSubject
    ? \`<p class="card__blocked">Blocked by \${esc(item.blockedByCanonicalSubject)}</p>\`
    : "";

  return \`<article class="card card--\${item.status}">
    <div class="card__head">
      <h3 class="card__subject">\${esc(item.subject)}</h3>
      \${chip(item.status)}
    </div>
    <p class="card__desc">\${esc(item.description)}</p>
    \${claims}\${decision}\${provenance}\${blocked}\${review}\${reopen}
  </article>\`;
}

function renderHandoff(handoff) {
  const action = handoff.requiresAction || [];
  const review = handoff.requiresHumanReview || [];
  const actionItems = action.length
    ? action.map((i) => \`<li><strong>\${esc(i.subject)}</strong> — \${esc(i.description)}</li>\`).join("")
    : "<li class='empty'>Nothing outstanding.</li>";
  const reviewItems = review.length
    ? review.map((i) => \`<li class="handoff__review"><strong>\${esc(i.subject)}</strong> — conflicting reports: \${i.claims.map((c) => "“" + esc(c.value) + "”").join(" vs ")}. A human must settle this.</li>\`).join("")
    : "<li class='empty'>No conflicts.</li>";
  const noise = (handoff.resolvedDuringShiftCount + handoff.decidedDuringShiftCount) > 0
    ? \`<p class="handoff__noise">\${handoff.resolvedDuringShiftCount + handoff.decidedDuringShiftCount} closed items are counted, not listed — history keeps them.</p>\`
    : "";
  return \`
    <div class="handoff__block">
      <h3 class="handoff__title">Requires action <span class="handoff__count">\${action.length}</span></h3>
      <ul class="handoff__list">\${actionItems}</ul>
    </div>
    <div class="handoff__block">
      <h3 class="handoff__title">Requires human review <span class="handoff__count">\${review.length}</span></h3>
      <ul class="handoff__list">\${reviewItems}</ul>
    </div>
    <dl class="handoff__stats">
      <div><dt>Resolved during shift</dt><dd>\${handoff.resolvedDuringShiftCount}</dd></div>
      <div><dt>Decided by a human</dt><dd>\${handoff.decidedDuringShiftCount}</dd></div>
    </dl>
    \${noise}\`;
}

function fmt(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function safeId(value) { return String(value).replace(/[^a-z0-9]+/gi, "-"); }
/**
 * Attribution for a reopened decision: who undid it, and why. This is shown
 * instead of the decision's own provenance, because the reopen is the human
 * action that put the item back into conflict.
 */
function reopenProvenanceLine(item) {
  return \`<p class="card__provenance">Reopened by <b>\${esc(item.reopened.actor || "an unnamed human")}</b>\${item.reopened.note ? \` — “\${esc(item.reopened.note)}”\` : ""}</p>\`;
}
/** The acting identity the client records on any human action in this session. */
function currentActor() { return $("actor").value.trim(); }

/**
 * Disable the given buttons for the duration of a mutation. Human actions are
 * single-shot: a double click must not append the same decision twice, and the
 * disabled state is the visible proof that the request is in flight.
 */
async function withBusy(buttons, work) {
  const list = buttons.filter(Boolean);
  list.forEach((button) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
  try {
    return await work();
  } finally {
    list.forEach((button) => { button.disabled = false; button.removeAttribute("aria-busy"); });
  }
}
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("kind").addEventListener("change", () => { $("claimLabel").hidden = !KINDS_WITH_CLAIM.has($("kind").value); });

$("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  try {
    await api(\`/api/shifts/\${currentShift.id}/events\`, {
      method: "POST",
      body: JSON.stringify({
        occurredAt: new Date($("occurredAt").value).toISOString(),
        kind: $("kind").value,
        subject: $("subject").value,
        description: $("description").value,
        claim: $("claim").value || undefined,
        blockedBy: $("blockedBy").value || undefined,
        source: $("source").value || "operator",
      }),
    });
    $("eventForm").reset();
    $("source").value = "operator";
    $("occurredAt").value = localNowForInput();
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("createBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api("/api/shifts", { method: "POST", body: JSON.stringify({ name: $("newShiftName").value }) });
    $("newShiftName").value = "";
    await refreshShiftList();
    $("shiftSelect").selectedIndex = 0;
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("demoBtn").addEventListener("click", async () => {
  showError("");
  try {
    const shift = await api("/api/demo-shift", { method: "POST" });
    currentShift = shift;
    await refreshShiftList();
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("loadBtn").addEventListener("click", loadShift);

$("presentBtn").addEventListener("click", () => {
  const on = document.body.classList.toggle("present");
  $("presentBtn").setAttribute("aria-pressed", String(on));
  const url = new URL(window.location.href);
  if (on) url.searchParams.set("present", "1"); else url.searchParams.delete("present");
  window.history.replaceState({}, "", url);
});

// Human-authority actions on items — deciding a conflict and reopening a
// decision. Delegated because the cards are re-rendered after every change.
$("stateList").addEventListener("click", async (e) => {
  const decisionBtn = e.target.closest(".decisionBtn");
  const reopenBtn = e.target.closest(".reopenBtn");
  if ((!decisionBtn && !reopenBtn) || !currentShift) return;
  showError("");
  $("mutationResult").textContent = "";
  const item = (decisionBtn || reopenBtn).dataset.item;
  // Every human action on the board is locked while one is in flight, so two
  // clicks cannot append two decisions for the same item.
  const peers = Array.from(document.querySelectorAll(".decisionBtn, .reopenBtn"));
  await withBusy(peers, async () => {
    try {
      if (decisionBtn) {
        const result = await api(\`/api/shifts/\${currentShift.id}/items/\${encodeURIComponent(item)}/decision\`, {
          method: "POST",
          body: JSON.stringify({ claim: decisionBtn.dataset.claim, actor: currentActor() }),
        });
        $("mutationResult").textContent = \`Decision recorded: \${result.item.subject} is decided as \${result.item.decision.value}.\`;
      } else {
        const reason = document.getElementById("reopenReason-" + safeId(item));
        const result = await api(\`/api/shifts/\${currentShift.id}/items/\${encodeURIComponent(item)}/reopen\`, {
          method: "POST",
          body: JSON.stringify({ actor: currentActor(), reason: reason ? reason.value : "" }),
        });
        $("mutationResult").textContent = \`Decision reopened: \${result.item.subject} is conflicted again and needs a new human decision.\`;
      }
      await loadShift();
    } catch (err) { showError(err.message); }
  });
});

$("photoFile").addEventListener("change", () => {
  const file = $("photoFile").files && $("photoFile").files[0];
  const preview = $("photoPreview");
  if (!file) {
    preview.hidden = true;
    $("photoPreviewImg").removeAttribute("src");
    $("photoPreviewText").textContent = "";
    return;
  }
  $("photoPreviewImg").src = URL.createObjectURL(file);
  $("photoPreviewImg").alt = \`Selected photo: \${file.name}\`;
  $("photoPreviewText").textContent = \`\${file.name} · \${Math.max(1, Math.round(file.size / 1024))} KB\`;
  preview.hidden = false;
});

$("photoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  $("photoResult").textContent = "";
  const file = $("photoFile").files && $("photoFile").files[0];
  if (!file) { showError("Choose an image first."); return; }
  const note = $("photoNote").value.trim();
  if (!note) { showError("Add a short note so the report can be interpreted."); return; }
  await withBusy([$("photoBtn")], async () => {
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the image."));
      reader.readAsDataURL(file);
    });
    const event = await api(\`/api/shifts/\${currentShift.id}/events/photo\`, {
      method: "POST",
      body: JSON.stringify({ image: dataUrl, note, fileName: file.name, occurredAt: new Date($("occurredAt").value).toISOString() }),
    });
    $("photoResult").innerHTML = \`Stored as evidence on <code>\${esc(event.subject)}</code> · \${esc(event.kind)}\`;
    $("photoForm").reset();
    $("photoPreview").hidden = true;
    $("photoPreviewImg").removeAttribute("src");
    $("photoPreviewText").textContent = "";
    await loadShift();
  } catch (err) { showError(err.message); }
  });
});

$("nlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  $("nlResult").textContent = "";
  await withBusy([$("nlBtn")], async () => {
  try {
    const event = await api(\`/api/shifts/\${currentShift.id}/events/nl\`, {
      method: "POST",
      body: JSON.stringify({ text: $("nlText").value, occurredAt: new Date($("occurredAt").value).toISOString() }),
    });
    // Show the structured event the interpreter derived (validated + persisted).
    $("nlResult").innerHTML = \`Understood as <code>\${esc(event.kind)}</code> · <code>\${esc(event.subject)}</code>\${event.claim ? " · claim: <code>" + esc(event.claim) + "</code>" : ""}\${event.blockedBy ? " · blocked by <code>" + esc(event.blockedBy) + "</code>" : ""}\`;
    $("nlText").value = "";
    await loadShift();
  } catch (err) { showError(err.message); }
  });
});

$("agentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  $("agentReply").hidden = true;
  $("agentTrace").hidden = true;
  const text = $("agentText").value.trim();
  if (!text || !currentShift) return;
  await withBusy([$("agentBtn")], async () => {
  try {
    const result = await api(\`/api/shifts/\${currentShift.id}/agent\`, {
      method: "POST",
      body: JSON.stringify({ message: text, actor: currentActor() }),
    });
    $("agentReply").innerHTML = \`<span class="reply__label">Agent reply</span>\${esc(result.response || "")}\`;
    $("agentReply").hidden = false;

    const trace = result.toolTrace || [];
    $("agentTrace").innerHTML = trace.length
      ? \`<div class="trace__head"><span>Tool trace</span><span>\${trace.length} call\${trace.length === 1 ? "" : "s"}</span></div>
         <ol class="trace__list">\${trace
           .map((t) => \`<li class="trace__row\${t.status === "success" ? "" : " trace__row--error"}">
              <span class="trace__status trace__status--\${t.status === "success" ? "success" : "error"}">\${TRACE_ICONS[t.status === "success" ? "success" : "error"]}</span>
              <span class="trace__tool">\${esc(t.tool)}</span>
              <span class="trace__detail">\${esc(t.summary)}\${t.status === "success" ? "" : " <span class='trace__flag'>failed</span>"}</span>
            </li>\`)
           .join("")}</ol>\`
      : \`<div class="trace__head"><span>Tool trace</span><span>0 calls</span></div><p class="trace__empty">No tools were called — this reply came from the model alone, so treat it as unreliable.</p>\`;
    $("agentTrace").hidden = false;

    if (!result.ok) showError("Agent turn failed: " + (result.error || "unknown error"));
    $("agentText").value = "";
    await loadShift();
  } catch (err) { showError(err.message); }
  });
});

$("endBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api(\`/api/shifts/\${currentShift.id}/end\`, { method: "POST" });
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("occurredAt").value = localNowForInput();
if (new URL(window.location.href).searchParams.get("present") === "1") {
  document.body.classList.add("present");
  $("presentBtn").setAttribute("aria-pressed", "true");
}
refreshShiftList().then(loadShift).catch(() => {});
</script>
</body>
</html>`;
}
