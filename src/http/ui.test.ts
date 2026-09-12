import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderUi } from "./ui.ts";

/**
 * The UI is a server-rendered string, so these are structural checks rather
 * than DOM assertions (no jsdom in this project). They exist to keep the
 * accessibility work from silently regressing during later edits: every form
 * control must have a label, status must never be color-only, and live regions
 * must exist before their content does.
 */
const html = renderUi();

/** Ids of elements that can receive focus from the keyboard. */
function focusableIds(): string[] {
  return [...html.matchAll(/<(?:input|select|button|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
}

function labelledIds(): Set<string> {
  const labelled = new Set<string>();
  for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) labelled.add(m[1]!);
  return labelled;
}

describe("UI shell accessibility", () => {
  // Recording/reliability guard: a webfont that is not bundled would either
  // shift the layout when missing or add a network dependency to a UI that is
  // otherwise fully offline.
  it("uses a bundled-free system font stack and fetches no fonts", () => {
    assert.match(html, /--font-sans: system-ui,/);
    assert.match(html, /--font-mono: ui-monospace,/);
    assert.doesNotMatch(html, /@font-face/);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|use\.typekit|cdn\./);
    assert.doesNotMatch(html, /"Inter"/);
  });

  it("declares the document language and an explicit color scheme", () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="color-scheme" content="light">/);
  });

  it("uses landmarks and a meaningful heading outline, with a skip link", () => {
    assert.match(html, /<header class="appbar">/);
    assert.match(html, /<main id="main">/);
    assert.match(html, /class="skip-link" href="#main"/);
    // Exactly one h1, carried by the product wordmark, then sections and items.
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "the page needs exactly one h1");
    assert.match(html, /<h1 class="wordmark">Shift Handoff<\/h1>/);
    const h2s = html.match(/<h2\b/g) ?? [];
    assert.ok(h2s.length >= 5, `expected section headings, found ${h2s.length}`);
    // The h1 must come before the first h2 in document order.
    assert.ok(html.indexOf("<h1") < html.indexOf("<h2"), "h1 must precede the section headings");
    // At most one visually-hidden heading label; no real heading is hidden.
    const hiddenHeadings = [...html.matchAll(/<h[1-6][^>]*class="sr-only"/g)];
    assert.ok(hiddenHeadings.length <= 1, `only the setup label may be sr-only, found ${hiddenHeadings.length}`);
  });

  it("gives every form control a real label", () => {
    const labelled = labelledIds();
    for (const id of focusableIds()) {
      // #endBtn is a shift-level action in the setup toolbar, described by its
      // own text; every field-like control must be label-linked.
      if (["loadBtn", "createBtn", "demoBtn", "endBtn", "presentBtn", "agentBtn", "photoBtn", "nlBtn"].includes(id)) continue;
      assert.ok(labelled.has(id), `control #${id} has no <label for>`);
    }
  });

  it("keeps the four statuses distinguishable without color", () => {
    // Each status is a chip that carries an icon and an uppercase word, so the
    // legend and the cards stay readable in grayscale and for color-blind users.
    for (const status of ["open", "conflicted", "resolved", "decided"]) {
      assert.match(html, new RegExp(`chip--${status}`), `missing ${status} chip`);
    }
    for (const word of ["Open", "Conflict", "Resolved", "Decided"]) {
      assert.match(html, new RegExp(`>${word}<`), `missing the word ${word}`);
    }
    assert.ok((html.match(/<svg /g) ?? []).length >= 4, "status icons must be inline svg (no icon font)");
  });

  it("announces dynamic results through live regions that exist up front", () => {
    for (const id of ["agentReply", "agentTrace", "photoResult", "nlResult", "mutationResult"]) {
      assert.match(html, new RegExp(`id="${id}"[^>]*aria-live="polite"`), `#${id} must be a polite live region`);
    }
    assert.match(html, /id="error" class="alert" role="alert"/);
    // A live region that is display:none while empty is not reliably announced,
    // so the mutation region collapses to zero height instead of being hidden.
    assert.doesNotMatch(html, /\.mutation:empty \{[^}]*display: none/);
  });

  it("names the acting human and records them on human actions", () => {
    assert.match(html, /<label class="field__label" for="actor">Acting as<\/label>/);
    assert.match(html, /id="actor" type="text" value="Shift Supervisor"/);
    // The client must send the actor with both human-authority requests.
    assert.match(html, /actor: currentActor\(\)/);
    assert.match(html, /function currentActor\(\)/);
  });

  it("offers a labelled reopen action for a decided item", () => {
    assert.match(html, /class="btn reopenBtn"/);
    assert.match(html, /Reopen decision/);
    assert.match(html, /for="reopenReason-\$\{safeId\(item\.canonicalSubject\)\}">Reason \(optional\)/);
    assert.match(html, /id="reopenReason-\$\{safeId\(item\.canonicalSubject\)\}"/);
    // Reopening is offered only on decided items, and never on a conflict.
    assert.match(html, /item\.status === "decided"/);
  });

  it("shows decision provenance and marks a reopened decision as superseded", () => {
    assert.match(html, /card__provenance/);
    assert.match(html, /Recorded by <b>/);
    assert.match(html, /card__decision--superseded/);
    assert.match(html, /Reopened/);
    // A reopened item explains itself: who undid the decision, and why.
    assert.match(html, /function reopenProvenanceLine\(item\)/);
    assert.match(html, /Reopened by <b>/);
    assert.match(html, /item\.reopened\.note/);
  });

  it("shows who authorized a human action in the append-only history", () => {
    assert.match(html, /event\.actor \|\| event\.note/);
    assert.match(html, /by <b>\$\{esc\(event\.actor\)\}<\/b>/);
  });

  it("locks human-action buttons while a mutation is in flight", () => {
    assert.match(html, /async function withBusy\(buttons, work\)/);
    assert.match(html, /button\.setAttribute\("aria-busy", "true"\)/);
    assert.match(html, /\.btn\[aria-busy="true"\]/);
    assert.match(html, /querySelectorAll\("\.decisionBtn, \.reopenBtn"\)/);
  });

  it("is fully keyboard operable and respects reduced motion", () => {
    assert.match(html, /:focus-visible/);
    assert.match(html, /prefers-reduced-motion: reduce/);
    // Submit-by-Enter is available: the three quick actions are real forms.
    for (const form of ["agentForm", "photoForm", "nlForm"]) {
      assert.match(html, new RegExp(`<form id="${form}"`), `#${form} must be a form`);
    }
    // The decision buttons are native buttons, not clickable divs.
    assert.match(html, /class="btn btn--choice decisionBtn"/);
    assert.doesNotMatch(html, /onclick=/);
  });

  it("pulls its palette from custom properties so contrast stays auditable", () => {
    assert.match(html, /--ink-1: #0f1319/);
    assert.match(html, /--accent: #1c4a70/);
    for (const token of ["--open-ink", "--conflict-ink", "--resolved-ink", "--decided-ink"]) {
      assert.match(html, new RegExp(`${token}:`), `missing ${token}`);
    }
  });

  // Contrast is computed from the tokens actually rendered into the page, so
  // changing a hex value can never quietly drop below WCAG AA.
  describe("WCAG AA contrast", () => {
    const tokens = new Map<string, string>();
    for (const m of html.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)) tokens.set(m[1]!, m[2]!);

    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const pair = (a: string, b: string): [string, string] => {
      const resolve = (name: string) => tokens.get(name) ?? name;
      const value = [resolve(a), resolve(b)];
      assert.ok(value.every((v) => /^#[0-9a-f]{6}$/.test(v)), `unknown color token in ${a} / ${b}`);
      return value as [string, string];
    };

    const textPairs: Array<[string, string, string]> = [
      ["body text", "ink-1", "surface-1"],
      ["body text on page", "ink-1", "surface-0"],
      ["body text on inset", "ink-1", "surface-2"],
      ["secondary text", "ink-2", "surface-1"],
      ["secondary text on inset", "ink-2", "surface-2"],
      ["secondary text on conflict", "ink-2", "conflict-bg"],
      ["secondary text on decided", "ink-2", "decided-bg"],
      ["meta text", "ink-3", "surface-1"],
      ["meta text on page", "ink-3", "surface-0"],
      ["meta text on inset", "ink-3", "surface-2"],
      ["meta text on conflict", "ink-3", "conflict-bg"],
      ["chip: open", "open-ink", "open-bg"],
      ["chip: conflict", "conflict-ink", "conflict-bg"],
      ["chip: resolved", "resolved-ink", "resolved-bg"],
      ["chip: decided", "decided-ink", "decided-bg"],
      ["trace text", "trace-ink", "trace-bg"],
      ["trace detail", "trace-ink-2", "trace-bg"],
      ["trace success", "trace-ok", "trace-bg"],
      ["trace failure", "trace-bad", "trace-bg"],
      ["primary button label", "#ffffff", "accent"],
      ["primary button hover label", "#ffffff", "accent-hover"],
    ];

    for (const [label, fg, bg] of textPairs) {
      const ratio = contrast(...pair(fg, bg));
      assert.ok(ratio >= 4.5, `${label} needs 4.5:1, got ${ratio.toFixed(2)}:1`);
    }

    // Non-text contrast (WCAG 1.4.11): control boundaries and the focus ring.
    const uiPairs: Array<[string, string, string]> = [
      ["input border", "line-strong", "surface-1"],
      ["input border on inset", "line-strong", "surface-2"],
      ["focus ring", "focus", "surface-1"],
      ["focus ring on page", "focus", "surface-0"],
      ["focus ring on inset", "focus", "surface-2"],
    ];
    for (const [label, fg, bg] of uiPairs) {
      const ratio = contrast(...pair(fg, bg));
      assert.ok(ratio >= 3, `${label} needs 3:1, got ${ratio.toFixed(2)}:1`);
    }
  });

  // Component classes set `display`, which silently defeats the user-agent
  // [hidden] rule — that is how a "hidden" photo preview once rendered as an
  // empty box. One global guard keeps every hidden element actually hidden.
  it("guarantees the hidden attribute wins over component display rules", () => {
    assert.match(html, /\[hidden\] \{ display: none !important; \}/);
    // Elements that start hidden and are revealed by script must rely on it.
    for (const id of ["photoPreview", "claimLabel", "agentReply", "agentTrace"]) {
      assert.match(html, new RegExp(`id="${id}"[^>]*\\shidden`), `#${id} should start hidden`);
    }
  });

  it("keeps the editor chrome separable from the product view", () => {
    // Presentation view hides setup + editor only; the product surfaces stay.
    assert.match(html, /body\.present \.admin, body\.present \.editor-only \{ display: none !important; \}/);
    for (const productSection of ["agentSection", "stateSection", "handoffSection", "historySection"]) {
      assert.ok(!new RegExp(`${productSection}[^>]*editor-only`).test(html), `#${productSection} must stay visible in presentation view`);
    }
  });
});
