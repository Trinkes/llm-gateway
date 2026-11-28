// [fork] W23: try any model the gateway serves, the way a client would: the
// page issues itself an API key (POST /api/playground/key) and calls /v1/*.
// Nothing is stored: a reload starts over.
import { PlaygroundChat } from "../components/PlaygroundChat";
import { PlaygroundDecision } from "../components/PlaygroundDecision";
import { PlaygroundEmbeddings } from "../components/PlaygroundEmbeddings";
import { PlaygroundImage } from "../components/PlaygroundImage";
import { PlaygroundModelPicker } from "../components/PlaygroundModelPicker";
import { PlaygroundSpeech } from "../components/PlaygroundSpeech";
import { PlaygroundTranscription } from "../components/PlaygroundTranscription";
import { Badge, Label } from "../components/ui";
import { errorText, gatewayFetch, playgroundKey } from "../lib/playgroundKey";
import {
  PLAYGROUND_MODES,
  rankModels,
  type PlaygroundMode,
} from "../lib/playgroundModes";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

const MODEL_STORAGE = "playground.models";

function readChosen(): Partial<Record<PlaygroundMode, string>> {
  try {
    return JSON.parse(localStorage.getItem(MODEL_STORAGE) ?? "{}");
  } catch {
    return {};
  }
}

function saveChosen(chosen: Partial<Record<PlaygroundMode, string>>): void {
  try {
    localStorage.setItem(MODEL_STORAGE, JSON.stringify(chosen));
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

function isMode(value: string | null): value is PlaygroundMode {
  return PLAYGROUND_MODES.some((m) => m.mode === value);
}

async function fetchModels(): Promise<string[]> {
  const { res } = await gatewayFetch("/v1/models");
  const body = await res.text();
  if (!res.ok) throw new Error(errorText(res.status, body));
  const parsed = JSON.parse(body) as { data?: { id?: unknown }[] };
  return (parsed.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
}

function panelFor(mode: PlaygroundMode, model: string): ReactNode {
  switch (mode) {
    case "chat":
      return <PlaygroundChat model={model} />;
    case "image":
      return <PlaygroundImage model={model} edit={false} />;
    case "image-edit":
      return <PlaygroundImage model={model} edit />;
    case "embeddings":
      return <PlaygroundEmbeddings model={model} />;
    case "speech":
      return <PlaygroundSpeech model={model} />;
    case "transcription":
      return <PlaygroundTranscription model={model} />;
    case "decision":
      return <PlaygroundDecision model={model} />;
  }
}

export function PlaygroundPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("mode");
  const mode: PlaygroundMode = isMode(requested) ? requested : "chat";
  const [visited, setVisited] = useState<PlaygroundMode[]>([mode]);
  const [chosen, setChosen] = useState(readChosen);

  useEffect(() => {
    setVisited((v) => (v.includes(mode) ? v : [...v, mode]));
  }, [mode]);

  const key = useQuery({
    queryKey: ["playground-key"],
    queryFn: () => playgroundKey(),
    staleTime: Infinity,
    retry: false,
  });
  const models = useQuery({
    queryKey: ["playground-models"],
    queryFn: fetchModels,
    enabled: key.isSuccess,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // A mode without a stored choice starts on its first suggested model.
  const modelFor = (m: PlaygroundMode): string => {
    const stored = chosen[m];
    if (stored !== undefined) return stored;
    const ids = models.data ?? [];
    return rankModels(m, ids).suggested[0] ?? ids[0] ?? "";
  };

  const choose = (model: string) => {
    const next = { ...chosen, [mode]: model };
    setChosen(next);
    saveChosen(next);
  };

  const keyError = key.error as Error | null;
  const modelsError = models.error as Error | null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Playground</h1>
          <p className="text-sm text-gray-500">
            Call any model through the gateway. Nothing is saved; usage shows
            under the "Playground" API key.
          </p>
        </div>
        {key.data && (
          <Badge
            tone="indigo"
            title="Issued for this tab; replaced automatically when it expires"
          >
            <KeyRound size={12} /> {key.data.key.slice(0, 12)}… · expires{" "}
            {new Date(key.data.expiresAt * 1000).toLocaleString([], {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </Badge>
        )}
      </div>

      {keyError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not issue a playground API key: {keyError.message}
          {/admin|owner|forbidden|permission/i.test(keyError.message)
            ? " (owners and admins only)"
            : ""}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <nav className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
          {PLAYGROUND_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              onClick={() => setParams({ mode: m.mode }, { replace: true })}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                m.mode === mode
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <div className="min-w-[260px] flex-1 sm:max-w-md">
          <Label>Model</Label>
          <PlaygroundModelPicker
            mode={mode}
            models={models.data ?? null}
            value={modelFor(mode)}
            onChange={choose}
            loading={key.isLoading || models.isLoading}
          />
        </div>
      </div>
      {modelsError && (
        <p className="text-sm text-amber-700">
          Could not list models ({modelsError.message}); type a model id
          instead.
        </p>
      )}

      {visited.map((m) => (
        <div key={m} hidden={m !== mode}>
          {panelFor(m, modelFor(m))}
        </div>
      ))}
    </div>
  );
}
