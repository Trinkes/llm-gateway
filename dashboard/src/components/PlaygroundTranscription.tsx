// [fork] W23: speech to text in the playground, from a file or the microphone.
import { useGatewayCall } from "../lib/useGatewayCall";
import { useRecorder } from "../lib/useRecorder";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Button, Input, Label } from "./ui";
import { FileAudio, Mic, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface TranscriptReply {
  text?: string;
  language?: string;
  duration?: number;
}

export function PlaygroundTranscription({ model }: { model: string }) {
  const call = useGatewayCall();
  const recorder = useRecorder();
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [reply, setReply] = useState<TranscriptReply | null>(null);

  useEffect(() => {
    if (recorder.recording) setFile(recorder.recording);
  }, [recorder.recording]);

  const preview = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const run = async () => {
    if (!model || !file) return;
    setReply(null);
    const format = verbose ? "verbose_json" : "json";
    const form = new FormData();
    form.set("model", model);
    form.set("file", file, file.name);
    form.set("response_format", format);
    if (language.trim()) form.set("language", language.trim());
    if (prompt.trim()) form.set("prompt", prompt.trim());
    const res = await call.send(
      "/v1/audio/transcriptions",
      { method: "POST", body: form },
      {
        kind: "form",
        fields: [
          ["model", model],
          ["file", { fileName: file.name }],
          ["response_format", format],
          ...(language.trim()
            ? ([["language", language.trim()]] as [string, string][])
            : []),
          ...(prompt.trim()
            ? ([["prompt", prompt.trim()]] as [string, string][])
            : []),
        ],
      },
    );
    if (!res) return;
    try {
      setReply((await res.json()) as TranscriptReply);
      call.done();
    } catch (err) {
      call.fail((err as Error).message || "Bad reply");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <FileAudio size={14} /> Choose audio
            <input
              type="file"
              accept="audio/*,video/*"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {recorder.active ? (
            <Button variant="danger" onClick={recorder.stop}>
              <Square size={14} /> Stop recording
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void recorder.start()}>
              <Mic size={14} /> Record
            </Button>
          )}
          {file && (
            <span className="truncate text-xs text-gray-500">{file.name}</span>
          )}
        </div>
        {recorder.error && (
          <p className="text-sm text-red-600">{recorder.error}</p>
        )}
        {preview && <audio controls src={preview} className="w-full" />}
        <div className="flex justify-end">
          <Button
            onClick={() => void run()}
            loading={call.busy}
            disabled={!model || !file}
          >
            Transcribe
          </Button>
        </div>
        <PlaygroundCallMeta
          meta={call.meta}
          error={call.error}
          extra={
            reply?.duration != null
              ? `${reply.duration.toFixed(1)} s of audio`
              : null
          }
        />
        {reply && (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-sm text-gray-900">
              {reply.text || <span className="text-gray-400">(empty)</span>}
            </p>
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer select-none">
                Raw reply
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto rounded bg-gray-50 p-2">
                {JSON.stringify(reply, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
      <PlaygroundSettings>
        <div>
          <Label>Language</Label>
          <Input
            placeholder="auto (e.g. pt)"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          />
        </div>
        <div>
          <Label>Prompt</Label>
          <Input
            placeholder="optional context"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(e) => setVerbose(e.target.checked)}
          />
          Verbose (segments)
        </label>
      </PlaygroundSettings>
    </div>
  );
}
