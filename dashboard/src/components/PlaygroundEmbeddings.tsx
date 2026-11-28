// [fork] W23: embeddings in the playground: one input per line, the vectors'
// size and the cosine similarity of every pair.
import { useGatewayCall } from "../lib/useGatewayCall";
import { cosineSimilarity, vectorNorm } from "../lib/vectors";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Textarea } from "./Textarea";
import { Button, Input, Label } from "./ui";
import { Sigma } from "lucide-react";
import { useState } from "react";

interface EmbeddingsReply {
  data?: { index?: number; embedding?: number[] }[];
  usage?: { prompt_tokens?: number };
}

function cellTone(sim: number | null): string {
  if (sim === null) return "";
  if (sim > 0.8) return "bg-emerald-50 font-semibold text-emerald-700";
  if (sim > 0.5) return "text-emerald-700";
  return "";
}

export function PlaygroundEmbeddings({ model }: { model: string }) {
  const call = useGatewayCall();
  const [text, setText] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [inputs, setInputs] = useState<string[]>([]);
  const [vectors, setVectors] = useState<number[][]>([]);
  const [tokens, setTokens] = useState<number | null>(null);

  const run = async () => {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!model || lines.length === 0) return;
    setVectors([]);
    setTokens(null);
    const body = {
      model,
      input: lines,
      ...(Number(dimensions) > 0 ? { dimensions: Number(dimensions) } : {}),
    };
    const res = await call.send(
      "/v1/embeddings",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { kind: "json", value: body },
    );
    if (!res) return;
    try {
      const reply = (await res.json()) as EmbeddingsReply;
      const rows = [...(reply.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      setInputs(lines);
      setVectors(rows.map((r) => r.embedding ?? []));
      setTokens(reply.usage?.prompt_tokens ?? null);
      call.done();
    } catch (err) {
      call.fail((err as Error).message || "Bad reply");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <Label>Inputs (one per line)</Label>
          <Textarea
            rows={6}
            value={text}
            placeholder={
              "O gato dorme no sofá.\nThe cat sleeps on the couch.\nA fatura vence amanhã."
            }
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => void run()}
            loading={call.busy}
            disabled={!model || !text.trim()}
          >
            <Sigma size={14} /> Embed
          </Button>
        </div>
        <PlaygroundCallMeta
          meta={call.meta}
          error={call.error}
          extra={tokens !== null ? `${tokens} tokens` : null}
        />
        {vectors.length > 0 && (
          <div className="space-y-4">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-2">#</th>
                  <th className="py-1 pr-2">Input</th>
                  <th className="py-1 pr-2">Dims</th>
                  <th className="py-1 pr-2">Norm</th>
                  <th className="py-1">First values</th>
                </tr>
              </thead>
              <tbody className="text-gray-800">
                {vectors.map((v, i) => (
                  <tr key={i} className="border-t border-gray-100 align-top">
                    <td className="py-1 pr-2">{i + 1}</td>
                    <td
                      className="max-w-xs truncate py-1 pr-2"
                      title={inputs[i]}
                    >
                      {inputs[i]}
                    </td>
                    <td className="py-1 pr-2">{v.length}</td>
                    <td className="py-1 pr-2">{vectorNorm(v).toFixed(3)}</td>
                    <td className="py-1 font-mono text-gray-500">
                      [
                      {v
                        .slice(0, 6)
                        .map((x) => x.toFixed(4))
                        .join(", ")}
                      {v.length > 6 ? ", …" : ""}]
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {vectors.length > 1 && (
              <div>
                <Label>Cosine similarity</Label>
                <div className="overflow-x-auto">
                  <table className="text-xs">
                    <thead>
                      <tr>
                        <th />
                        {vectors.map((_, j) => (
                          <th key={j} className="px-2 py-1 text-gray-500">
                            {j + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {vectors.map((a, i) => (
                        <tr key={i}>
                          <th className="px-2 py-1 text-gray-500">{i + 1}</th>
                          {vectors.map((b, j) => {
                            const sim = cosineSimilarity(a, b);
                            return (
                              <td
                                key={j}
                                className={`px-2 py-1 text-center font-mono ${cellTone(sim)}`}
                              >
                                {sim === null ? "—" : sim.toFixed(3)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <PlaygroundSettings>
        <div>
          <Label>Dimensions</Label>
          <Input
            type="number"
            min="1"
            placeholder="model default"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
          />
        </div>
      </PlaygroundSettings>
    </div>
  );
}
