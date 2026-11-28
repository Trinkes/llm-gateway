// [fork] W23: image generations and image edits in the playground.
import { imageSrc } from "../lib/playgroundFiles";
import { useGatewayCall } from "../lib/useGatewayCall";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Textarea } from "./Textarea";
import { Button, Input, Label } from "./ui";
import { Download, ImageIcon, ImagePlus, Square, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const SIZES = ["1024x1024", "1344x768", "768x1344", "512x512", "auto"];

interface ImagesReply {
  output_format?: string;
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  error?: string | { message?: string };
}

function replyError(reply: ImagesReply): string | null {
  if (!reply.error) return null;
  return typeof reply.error === "string"
    ? reply.error
    : (reply.error.message ?? "Image request failed");
}

export function PlaygroundImage({
  model,
  edit,
}: {
  model: string;
  edit: boolean;
}) {
  const call = useGatewayCall();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [n, setN] = useState("1");
  const [quality, setQuality] = useState("");
  const [sources, setSources] = useState<File[]>([]);
  const [results, setResults] = useState<string[]>([]);

  const previews = useMemo(
    () => sources.map((f) => URL.createObjectURL(f)),
    [sources],
  );
  useEffect(() => () => previews.forEach(URL.revokeObjectURL), [previews]);

  const run = async () => {
    if (!model || !prompt.trim() || (edit && sources.length === 0)) return;
    setResults([]);
    const count = Math.max(1, Number(n) || 1);
    let res: Response | null;
    if (edit) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt.trim());
      form.set("size", size);
      form.set("n", String(count));
      if (quality) form.set("quality", quality);
      sources.forEach((f) => form.append("image[]", f, f.name));
      res = await call.send(
        "/v1/images/edits",
        { method: "POST", body: form },
        {
          kind: "form",
          fields: [
            ["model", model],
            ["prompt", prompt.trim()],
            ["size", size],
            ["n", String(count)],
            ...(quality ? ([["quality", quality]] as [string, string][]) : []),
            ...sources.map(
              (f) =>
                ["image[]", { fileName: f.name }] as [
                  string,
                  { fileName: string },
                ],
            ),
          ],
        },
      );
    } else {
      const body = {
        model,
        prompt: prompt.trim(),
        size,
        n: count,
        ...(quality ? { quality } : {}),
      };
      res = await call.send(
        "/v1/images/generations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        { kind: "json", value: body },
      );
    }
    if (!res) return;
    try {
      const reply = (await res.json()) as ImagesReply;
      const failure = replyError(reply);
      if (failure) {
        call.fail(failure);
        return;
      }
      setResults(
        (reply.data ?? [])
          .map((item) => imageSrc(item, reply.output_format))
          .filter((src): src is string => src !== null),
      );
      call.done();
    } catch (err) {
      call.fail(
        call.signal()?.aborted
          ? "Stopped"
          : (err as Error).message || "Bad reply",
      );
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        {edit && (
          <div>
            <Label>Source images</Label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              <ImagePlus size={14} />
              {sources.length
                ? `${sources.length} image${sources.length > 1 ? "s" : ""} chosen`
                : "Choose images"}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => setSources([...(e.target.files ?? [])])}
              />
            </label>
            {previews.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {previews.map((src) => (
                  <img
                    key={src}
                    src={src}
                    alt=""
                    className="h-24 rounded object-cover"
                  />
                ))}
              </div>
            )}
          </div>
        )}
        <div>
          <Label>Prompt</Label>
          <Textarea
            rows={4}
            value={prompt}
            placeholder={
              edit
                ? "Replace the bicycle with a blue ceramic vase"
                : "A red bicycle leaning on a white wall"
            }
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
            }}
          />
        </div>
        <div className="flex justify-end">
          {call.busy ? (
            <Button variant="secondary" onClick={call.stop}>
              <Square size={14} /> Stop
            </Button>
          ) : (
            <Button
              onClick={() => void run()}
              disabled={
                !model || !prompt.trim() || (edit && sources.length === 0)
              }
            >
              <Wand2 size={14} /> {edit ? "Edit" : "Generate"}
            </Button>
          )}
        </div>
        <PlaygroundCallMeta meta={call.meta} error={call.error} />
        {call.busy && (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-400">
            <ImageIcon size={18} className="mr-2 animate-pulse" /> Generating…
          </div>
        )}
        {results.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {results.map((src, i) => (
              <figure key={i} className="space-y-1">
                <img
                  src={src}
                  alt={prompt}
                  className="w-full rounded-lg border border-gray-200"
                />
                <a
                  href={src}
                  download={`image-${i + 1}.png`}
                  className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                >
                  <Download size={12} /> Download
                </a>
              </figure>
            ))}
          </div>
        )}
      </div>
      <PlaygroundSettings>
        <div>
          <Label>Size</Label>
          <Input
            list="playground-image-sizes"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
          <datalist id="playground-image-sizes">
            {SIZES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div>
          <Label>Images (n)</Label>
          <Input
            type="number"
            min="1"
            max="4"
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
        </div>
        <div>
          <Label>Quality</Label>
          <Input
            placeholder="default"
            list="playground-image-quality"
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          />
          <datalist id="playground-image-quality">
            {["low", "medium", "high", "standard", "hd"].map((q) => (
              <option key={q} value={q} />
            ))}
          </datalist>
        </div>
      </PlaygroundSettings>
    </div>
  );
}
