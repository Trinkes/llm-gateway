// [fork] W23: decision answers as playground table text.
import {
  answerProbabilities,
  answerValue,
} from "../../../dashboard/src/lib/decisionAnswer";
import { describe, expect, it } from "vitest";

const choice = {
  type: "choice",
  choice: "yes",
  probabilities: { no: 0.041, yes: 0.959 },
  confidence: 0.75,
};

describe("answerValue", () => {
  it("reads the field named by the answer's type", () => {
    expect(answerValue(choice)).toBe("yes");
    expect(answerValue({ type: "score", score: 0.81234 })).toBe("0.812");
  });

  it("falls back to the first plain field without a matching type", () => {
    expect(answerValue({ type: "noul", confidence: 0.5, verdict: true })).toBe(
      "true",
    );
    expect(answerValue({ confidence: 0.5, label: "maybe" })).toBe("maybe");
  });

  it("shows a dash when there is no value", () => {
    expect(answerValue({ type: "choice", choice: null })).toBe("—");
    expect(answerValue({ confidence: 0.5 })).toBe("—");
  });
});

describe("answerProbabilities", () => {
  it("lists probabilities most likely first", () => {
    expect(answerProbabilities(choice)).toBe("yes 0.96 · no 0.04");
  });

  it("is empty without a probabilities object", () => {
    expect(answerProbabilities({})).toBe("");
    expect(answerProbabilities({ probabilities: [0.5] })).toBe("");
    expect(answerProbabilities({ probabilities: { a: "x" } })).toBe("");
  });
});
