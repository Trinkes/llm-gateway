// [fork] W23: the playground's request kinds and which models suit each.

export type PlaygroundMode =
  | "chat"
  | "image"
  | "image-edit"
  | "embeddings"
  | "speech"
  | "transcription"
  | "decision";

export interface PlaygroundModeInfo {
  mode: PlaygroundMode;
  label: string;
  path: string;
}

export const PLAYGROUND_MODES: PlaygroundModeInfo[] = [
  { mode: "chat", label: "Chat", path: "/v1/chat/completions" },
  { mode: "image", label: "Image", path: "/v1/images/generations" },
  { mode: "image-edit", label: "Image edit", path: "/v1/images/edits" },
  { mode: "embeddings", label: "Embeddings", path: "/v1/embeddings" },
  { mode: "speech", label: "Speech", path: "/v1/audio/speech" },
  {
    mode: "transcription",
    label: "Transcription",
    path: "/v1/audio/transcriptions",
  },
  { mode: "decision", label: "Decision", path: "/v1/systemone" },
];

export function modeInfo(mode: PlaygroundMode): PlaygroundModeInfo {
  return PLAYGROUND_MODES.find((m) => m.mode === mode) ?? PLAYGROUND_MODES[0];
}

// Model ids say little about what they serve; these name hints only order the
// list, every model stays selectable.
const IMAGE =
  /image|diffusion|\bsd[-_.\d]|sdxl|flux|dall-?e|imagen|z-image|qwen-image|sd-cpp/i;
const HINTS: Record<Exclude<PlaygroundMode, "chat">, RegExp> = {
  image: IMAGE,
  "image-edit": IMAGE,
  embeddings: /embed|bge|\be5\b|gte|nomic|minilm|mxbai|jina/i,
  speech: /tts|speech|voice|voca|kokoro|piper/i,
  transcription: /whisper|stt|transcri|parakeet|asr/i,
  decision: /decision|systemone|\bd3\b|-d3-/i,
};

function matchesSomeHint(id: string): boolean {
  return Object.values(HINTS).some((re) => re.test(id));
}

/** Whether a model id looks like it serves `mode`. */
export function suitsMode(mode: PlaygroundMode, id: string): boolean {
  return mode === "chat" ? !matchesSomeHint(id) : HINTS[mode].test(id);
}

/** Model ids split into the ones that look right for `mode` and the rest. */
export function rankModels(
  mode: PlaygroundMode,
  ids: string[],
): { suggested: string[]; others: string[] } {
  const sorted = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  return {
    suggested: sorted.filter((id) => suitsMode(mode, id)),
    others: sorted.filter((id) => !suitsMode(mode, id)),
  };
}
