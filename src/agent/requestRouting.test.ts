import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalClaim } from "../domain/claims.ts";
import { classifyAgentRequest, extractExplicitHumanDecision, routingDirective } from "./requestRouting.ts";

describe("extractExplicitHumanDecision", () => {
  it("authorizes explicit selection phrasings with the correct subject and claim", () => {
    const cases: Array<[string, string, string]> = [
      ["Send D104 to claims.", "D104", "claims"],
      ["Move the damaged case D104 to salvage", "D104", "salvage"],
      ["Set D104 to discard", "D104", "discard"],
      ["Choose claims for D104", "D104", "claims"],
      ["Pick discard for D104", "D104", "discard"],
      ["I want D104 sent to claims", "D104", "claims"],
      ["I want D104 to be sent to claims", "D104", "claims"],
      ["I want to send D104 to claims", "D104", "claims"],
      ["For D104, use claims", "D104", "claims"],
      ["For D104 use discard", "D104", "discard"],
      ["D104 should go to claims", "D104", "claims"],
      ["D104 must be sent to claims", "D104", "claims"],
      ["Route D104 to claims", "D104", "claims"],
    ];
    for (const [text, subject, claim] of cases) {
      const authorization = extractExplicitHumanDecision(text);
      assert.ok(authorization, `expected authorization for: ${text}`);
      assert.equal(authorization.subject, subject, text);
      assert.equal(authorization.claim, claim, text);
      assert.equal(authorization.canonicalSubject, subject.toLowerCase(), text);
      assert.equal(authorization.canonicalClaim, canonicalClaim(claim), text);
    }
  });

  it("never authorizes a vague or delegated decision request", () => {
    const vague = [
      "What should we do with D104?",
      "Pick whichever makes sense",
      "Which option is better?",
      "Resolve D104",
      "Can you decide D104?",
      "Just pick whichever one makes sense for D104.",
      "Handle D104 however you think is best.",
      "Aisle 7 is blocked.",
      "the vibes are off today",
    ];
    for (const text of vague) {
      assert.equal(extractExplicitHumanDecision(text), undefined, `must NOT authorize: ${text}`);
    }
  });
});

describe("classifyAgentRequest", () => {
  it("classifies operational reports, even uninterpretable ones, as report", () => {
    for (const text of ["Aisle 7 is blocked", "Pallet 83 is finished", "The freezer inspection was missed", "the vibes are off today", "Aisle 7 is clear now."]) {
      assert.equal(classifyAgentRequest(text), "report", text);
    }
  });

  it("classifies state, handoff, and explicit-decision requests distinctly", () => {
    assert.equal(classifyAgentRequest("What should we do with D104?"), "state");
    assert.equal(classifyAgentRequest("What's left for morning shift?"), "handoff");
    assert.equal(classifyAgentRequest("Send D104 to claims"), "decision");
    assert.equal(classifyAgentRequest("For D104, use claims"), "decision");
  });
});

describe("routingDirective", () => {
  it("emits a record_human_decision directive only when explicit human authorization exists", () => {
    const directive = routingDirective({
      routingIntent: "decision",
      humanDecisionAuthorization: {
        subject: "D104",
        canonicalSubject: "d104",
        claim: "claims",
        canonicalClaim: "claims",
      },
    });
    assert.ok(directive);
    assert.match(directive!, /record_human_decision/);
    assert.match(directive!, /D104/);
    assert.match(directive!, /claims/);
  });

  it("emits a report_event directive for report intent", () => {
    const directive = routingDirective({ routingIntent: "report" });
    assert.ok(directive);
    assert.match(directive!, /report_event/);
  });

  it("emits a get_shift_state directive for state intent so the model consults deterministic state", () => {
    const directive = routingDirective({ routingIntent: "state" });
    assert.ok(directive);
    assert.match(directive!, /get_shift_state/);
    assert.match(directive!, /human decision is required/i);
  });

  it("emits nothing when routing is absent or handoff", () => {
    assert.equal(routingDirective({}), undefined);
    assert.equal(routingDirective({ routingIntent: "handoff" }), undefined);
  });
});