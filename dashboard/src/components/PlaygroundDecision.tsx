// [fork] W23: the decision model (`/v1/systemone`) in the playground.
import { answerProbabilities, answerValue } from "../lib/decisionAnswer";
import { useGatewayCall } from "../lib/useGatewayCall";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Textarea } from "./Textarea";
import { Button, Label } from "./ui";
import { Scale } from "lucide-react";
import { useState } from "react";

const SAMPLE_QUESTIONS = JSON.stringify(
  {
    needs_human: {
      type: "choice",
      instructions: "Should a person approve this before the assistant acts?",
      criteria: {
        yes: "the action spends money, deletes data or sends something to other people",
        no: "it is safe to do without asking",
      },
    },
  },
  null,
  2,
);

type Answer = Record<string, unknown>;

export function PlaygroundDecision({ model }: { model: string }) {
  const call = useGatewayCall();
  const [state, setState] = useState("");
  const [questions, setQuestions] = useState(SAMPLE_QUESTIONS);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer> | null>(null);
  const [raw, setRaw] = useState<unknown>(null);

  const run = async () => {
    if (!model || !state.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(questions);
    } catch (err) {
      setJsonError(`Questions are not valid JSON: ${(err as Error).message}`);
      return;
    }
    setJsonError(null);
    setAnswers(null);
    const body = { model, state: state.trim(), questions: parsed };
    const res = await call.send(
      "/v1/systemone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { kind: "json", value: body },
    );
    if (!res) return;
    try {
      const reply = (await res.json()) as { answers?: Record<string, Answer> };
      setRaw(reply);
      setAnswers(reply.answers ?? {});
      call.done();
    } catch (err) {
      call.fail((err as Error).message || "Bad reply");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <Label>State</Label>
          <Textarea
            rows={4}
            value={state}
            placeholder="Send an email to the whole team saying the launch moved to next month."
            onChange={(e) => setState(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => void run()}
            loading={call.busy}
            disabled={!model || !state.trim()}
          >
            <Scale size={14} /> Decide
          </Button>
        </div>
        {jsonError && <p className="text-sm text-red-600">{jsonError}</p>}
        <PlaygroundCallMeta meta={call.meta} error={call.error} />
        {answers && (
          <div className="space-y-2">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-1 pr-2">Question</th>
                  <th className="py-1 pr-2">Answer</th>
                  <th className="py-1">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(answers).map(([id, a]) => {
                  const confidence = a.confidence;
                  const probabilities = answerProbabilities(a);
                  return (
                    <tr key={id} className="border-t border-gray-100">
                      <td className="py-1 pr-2 font-mono text-xs">{id}</td>
                      <td className="py-1 pr-2">
                        <span className="font-medium">{answerValue(a)}</span>
                        {probabilities && (
                          <span className="ml-2 text-xs text-gray-500">
                            {probabilities}
                          </span>
                        )}
                      </td>
                      <td className="py-1">
                        {typeof confidence === "number"
                          ? confidence.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer select-none">
                Raw reply
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto rounded bg-gray-50 p-2">
                {JSON.stringify(raw, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
      <PlaygroundSettings>
        <div>
          <Label>Questions (JSON)</Label>
          <Textarea
            rows={16}
            className="font-mono text-xs"
            spellCheck={false}
            value={questions}
            onChange={(e) => setQuestions(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500">
            {"{id: {type: choice|score, instructions, criteria}}"}
          </p>
        </div>
      </PlaygroundSettings>
    </div>
  );
}
