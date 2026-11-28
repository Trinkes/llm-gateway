// [fork] W23: text to speech in the playground.
import { audioExtension } from "../lib/playgroundFiles";
import { useGatewayCall } from "../lib/useGatewayCall";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Textarea } from "./Textarea";
import { Button, Input, Label } from "./ui";
import { Download, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

const FORMATS = ["wav", "mp3", "opus", "aac", "flac"];

export function PlaygroundSpeech({ model }: { model: string }) {
  const call = useGatewayCall();
  const [input, setInput] = useState("");
  const [voice, setVoice] = useState("");
  const [format, setFormat] = useState("wav");
  const [speed, setSpeed] = useState("");
  const [audio, setAudio] = useState<{
    url: string;
    format: string;
    bytes: number;
  } | null>(null);

  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio.url);
    },
    [audio],
  );

  const run = async () => {
    if (!model || !input.trim()) return;
    setAudio(null);
    const body = {
      model,
      input: input.trim(),
      response_format: format,
      ...(voice.trim() ? { voice: voice.trim() } : {}),
      ...(Number(speed) > 0 ? { speed: Number(speed) } : {}),
    };
    const res = await call.send(
      "/v1/audio/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { kind: "json", value: body },
    );
    if (!res) return;
    try {
      const blob = await res.blob();
      setAudio({ url: URL.createObjectURL(blob), format, bytes: blob.size });
      call.done();
    } catch (err) {
      call.fail((err as Error).message || "Bad reply");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <Label>Text</Label>
          <Textarea
            rows={5}
            value={input}
            maxLength={4096}
            placeholder="Bom dia. A reunião foi adiada para quinta-feira às 15h30."
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => void run()}
            loading={call.busy}
            disabled={!model || !input.trim()}
          >
            <Volume2 size={14} /> Speak
          </Button>
        </div>
        <PlaygroundCallMeta
          meta={call.meta}
          error={call.error}
          extra={audio ? `${(audio.bytes / 1024).toFixed(1)} KiB` : null}
        />
        {audio && (
          <div className="flex items-center gap-3">
            <audio controls autoPlay src={audio.url} className="w-full" />
            <a
              href={audio.url}
              download={`speech.${audioExtension(audio.format)}`}
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              <Download size={12} /> Download
            </a>
          </div>
        )}
      </div>
      <PlaygroundSettings>
        <div>
          <Label>Voice</Label>
          <Input
            list="playground-voices"
            placeholder="server default"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          />
          <datalist id="playground-voices">
            {["F3", "M1", "alloy", "nova"].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div>
          <Label>Format</Label>
          <select
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Speed</Label>
          <Input
            type="number"
            step="0.05"
            min="0.25"
            max="4"
            placeholder="1.0"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          />
        </div>
      </PlaygroundSettings>
    </div>
  );
}
