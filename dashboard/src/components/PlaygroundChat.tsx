// [fork] W23: chat completions in the playground, streamed or not, with
// optional image attachments for vision models. Nothing is kept after a reload.
import { fileToDataUrl } from "../lib/playgroundFiles";
import { readSse } from "../lib/sseEvents";
import { useGatewayCall } from "../lib/useGatewayCall";
import { PlaygroundCallMeta } from "./PlaygroundCallMeta";
import { PlaygroundSettings } from "./PlaygroundSettings";
import { Textarea } from "./Textarea";
import { Button, Input, Label } from "./ui";
import { ImagePlus, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  reasoning?: string;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }[];
  usage?: Usage;
}

function toApiMessage(m: ChatMessage) {
  if (m.role === "assistant" || !m.images?.length) {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: "text", text: m.content }] : []),
      ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

function numberOrUndefined(raw: string): number | undefined {
  return raw.trim() === "" || Number.isNaN(Number(raw))
    ? undefined
    : Number(raw);
}

export function PlaygroundChat({ model }: { model: string }) {
  const call = useGatewayCall();
  const [system, setSystem] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [topP, setTopP] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const updateLast = (patch: (m: ChatMessage) => ChatMessage) =>
    setMessages((all) => [...all.slice(0, -1), patch(all[all.length - 1])]);

  const run = async () => {
    if (!model || call.busy) return;
    const next =
      input.trim() || images.length
        ? [
            ...messages,
            { role: "user" as const, content: input.trim(), images },
          ]
        : messages;
    if (next.length === 0) return;
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setImages([]);
    setUsage(null);

    const body = {
      model,
      messages: [
        ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
        ...next.map(toApiMessage),
      ],
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(numberOrUndefined(temperature) !== undefined
        ? { temperature: numberOrUndefined(temperature) }
        : {}),
      ...(numberOrUndefined(maxTokens) !== undefined
        ? { max_tokens: numberOrUndefined(maxTokens) }
        : {}),
      ...(numberOrUndefined(topP) !== undefined
        ? { top_p: numberOrUndefined(topP) }
        : {}),
    };
    const res = await call.send(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { kind: "json", value: body },
    );
    if (!res) {
      setMessages((all) =>
        all[all.length - 1]?.content || all[all.length - 1]?.reasoning
          ? all
          : all.slice(0, -1),
      );
      return;
    }

    try {
      if (stream && res.body) {
        await readSse(res.body, (data) => {
          if (data === "[DONE]") return;
          let chunk: ChatChunk;
          try {
            chunk = JSON.parse(data) as ChatChunk;
          } catch {
            return;
          }
          if (chunk.usage) setUsage(chunk.usage);
          const delta = chunk.choices?.[0]?.delta;
          const text = delta?.content ?? "";
          const thought = delta?.reasoning_content ?? delta?.reasoning ?? "";
          if (text || thought) {
            updateLast((m) => ({
              ...m,
              content: m.content + text,
              reasoning: thought ? (m.reasoning ?? "") + thought : m.reasoning,
            }));
          }
        });
      } else {
        const json = (await res.json()) as ChatChunk;
        const msg = json.choices?.[0]?.message;
        if (json.usage) setUsage(json.usage);
        updateLast((m) => ({
          ...m,
          content: msg?.content ?? "",
          reasoning: msg?.reasoning_content ?? msg?.reasoning ?? undefined,
        }));
      }
      call.done();
    } catch (err) {
      call.fail(
        call.signal()?.aborted
          ? "Stopped"
          : (err as Error).message || "Stream failed",
      );
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files) return;
    const urls = await Promise.all([...files].map(fileToDataUrl));
    setImages((prev) => [...prev, ...urls]);
  };

  const usageText = usage
    ? `${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out tokens`
    : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="flex min-h-[60vh] flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 p-4">
          <Label>System</Label>
          <Textarea
            rows={2}
            value={system}
            placeholder="You are a helpful assistant."
            onChange={(e) => setSystem(e.target.value)}
          />
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 && (
            <p className="py-10 text-center text-sm text-gray-400">
              Send a message to start.
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`group rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-indigo-50" : "bg-gray-50"
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-500">
                {m.role}
                {!call.busy && (
                  <button
                    type="button"
                    className="invisible text-gray-400 hover:text-red-600 group-hover:visible"
                    onClick={() =>
                      setMessages((all) => all.filter((_, j) => j !== i))
                    }
                    aria-label="Remove message"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {m.reasoning && (
                <details className="mb-2 text-xs text-gray-500">
                  <summary className="cursor-pointer select-none">
                    Reasoning
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap">{m.reasoning}</p>
                </details>
              )}
              {m.images?.length ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {m.images.map((src, j) => (
                    <img
                      key={j}
                      src={src}
                      alt=""
                      className="h-20 w-20 rounded object-cover"
                    />
                  ))}
                </div>
              ) : null}
              <p className="whitespace-pre-wrap break-words text-gray-900">
                {m.content ||
                  (call.busy && i === messages.length - 1 ? "…" : "")}
              </p>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <div className="space-y-2 border-t border-gray-100 p-4">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((src, i) => (
                <div key={i} className="relative">
                  <img
                    src={src}
                    alt=""
                    className="h-14 w-14 rounded object-cover"
                  />
                  <button
                    type="button"
                    className="absolute -right-1 -top-1 rounded-full bg-gray-800 p-0.5 text-white"
                    onClick={() =>
                      setImages((all) => all.filter((_, j) => j !== i))
                    }
                    aria-label="Remove image"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            rows={3}
            value={input}
            placeholder="Message (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus size={14} /> Image
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={call.busy || messages.length === 0}
              onClick={() => {
                setMessages([]);
                setUsage(null);
              }}
            >
              <Trash2 size={14} /> Clear
            </Button>
            <div className="ml-auto">
              {call.busy ? (
                <Button variant="secondary" onClick={call.stop}>
                  <Square size={14} /> Stop
                </Button>
              ) : (
                <Button onClick={() => void run()} disabled={!model}>
                  <Send size={14} /> Send
                </Button>
              )}
            </div>
          </div>
          <PlaygroundCallMeta
            meta={call.meta}
            error={call.error}
            extra={usageText}
          />
        </div>
      </div>
      <PlaygroundSettings>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={stream}
            onChange={(e) => setStream(e.target.checked)}
          />
          Stream
        </label>
        <div>
          <Label>Temperature</Label>
          <Input
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="default"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
          />
        </div>
        <div>
          <Label>Max tokens</Label>
          <Input
            type="number"
            min="1"
            placeholder="default"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
        </div>
        <div>
          <Label>Top P</Label>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            placeholder="default"
            value={topP}
            onChange={(e) => setTopP(e.target.value)}
          />
        </div>
      </PlaygroundSettings>
    </div>
  );
}
