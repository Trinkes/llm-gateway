// [fork] W23: one `/v1/systemone` answer as table text.

/** The answer's value: the field named by its `type` (`choice`, `score`…). */
export function answerValue(answer: Record<string, unknown>): string {
  const type = typeof answer.type === "string" ? answer.type : null;
  const value =
    type && type in answer
      ? answer[type]
      : Object.entries(answer).find(
          ([k, v]) =>
            k !== "type" &&
            k !== "confidence" &&
            (typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean"),
        )?.[1];
  if (value === undefined || value === null) return "—";
  return typeof value === "number"
    ? String(Number(value.toFixed(3)))
    : String(value);
}

/** `yes 0.96 · no 0.04` from the answer's `probabilities`, most likely first. */
export function answerProbabilities(answer: Record<string, unknown>): string {
  const p = answer.probabilities;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "";
  return Object.entries(p as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(" · ");
}
