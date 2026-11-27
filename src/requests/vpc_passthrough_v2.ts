// [fork] W20: passthrough routes for self-hosted servers behind a vpc
// provider: OpenAI-compatible image edits, audio transcriptions and speech,
// and llama.cpp's `/v1/systemone` (typed decisions). Each reuses the image
// route's flow (vpc-route.ts): same auth, policy, rate limit and one request
// row per request, under its own kind (request-kinds.ts).
import { imageOutputTokens, isPriceableSize } from "../metrics/image-tokens";
import { imageCount } from "../metrics/request-kinds";
import { transcriptionUsage } from "../metrics/transcription-usage";
import {
  invalid,
  serveVpcRoute,
  type RouteRequest,
  type VpcRouteInput,
  type VpcRouteSpec,
} from "./vpc-route";

type JsonBody = Record<string, unknown>;

async function readJson(request: Request): Promise<JsonBody | Response> {
  try {
    const json = await request.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return invalid("Invalid request body");
    }
    return json as JsonBody;
  } catch {
    return invalid("Invalid request body");
  }
}

async function readForm(request: Request): Promise<FormData | Response> {
  try {
    return await request.formData();
  } catch {
    return invalid("Request body must be multipart/form-data");
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The form again, with `model` set to the upstream's id and `overrides` applied. */
function copyForm(form: FormData, overrides: Record<string, string>): FormData {
  const copy = new FormData();
  for (const [key, value] of form.entries()) {
    if (key in overrides) continue;
    copy.append(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) copy.set(key, value);
  return copy;
}

/**
 * Refuse a field given twice or as a file: the gateway reads the first value
 * while an upstream may use another, so a priced field (size, quality, n) or
 * the routing `model` could differ from what was checked.
 */
function singleTextFields(
  form: FormData,
  names: string[],
): Response | undefined {
  for (const name of names) {
    const values = form.getAll(name);
    if (values.length > 1) return invalid(`${name} must be given once`);
    if (values.length === 1 && typeof values[0] !== "string") {
      return invalid(`${name} must be text`);
    }
  }
  return undefined;
}

function isFile(value: unknown): boolean {
  return typeof value === "object" && value !== null && "arrayBuffer" in value;
}

/** A multipart `n` arrives as text; anything but 1..10 counts as 1. */
function formCount(value: unknown): number {
  const raw = text(value);
  return imageCount(/^\d+$/.test(raw) ? Number(raw) : undefined);
}

function postTo(path: string): VpcRouteSpec["send"] {
  return (client, body, init) => client.post(path, body, init);
}

const IMAGE_EDITS: VpcRouteSpec = {
  kind: "image",
  what: "image edits",
  heartbeat: true,
  priced: true,
  // An upstream that crashes on edits must never be reached by accident.
  enabled: (settings) => settings.imageEdits === true,
  async parse(request): Promise<RouteRequest | Response> {
    const form = await readForm(request);
    if (form instanceof Response) return form;
    const repeated = singleTextFields(form, [
      "model",
      "prompt",
      "size",
      "quality",
      "n",
    ]);
    if (repeated) return repeated;
    const rawModel = text(form.get("model"));
    if (!rawModel) return invalid("model is required");
    if (!text(form.get("prompt"))) return invalid("prompt is required");
    const images = [...form.getAll("image"), ...form.getAll("image[]")];
    if (!images.some(isFile)) return invalid("image is required");
    const size = form.get("size") ?? undefined;
    // [fork] W19: only a size we can price reaches the upstream.
    if (!isPriceableSize(size)) {
      return invalid("size must be WIDTHxHEIGHT or auto");
    }
    const n = formCount(form.get("n"));
    return {
      rawModel,
      contentType: null,
      tokens: imageOutputTokens({ size, quality: form.get("quality"), n }),
      units: n,
      body: (upstreamModel) =>
        copyForm(form, {
          model: upstreamModel,
          ...(form.has("n") ? { n: String(n) } : {}),
        }),
    };
  },
  send: postTo("/v1/images/edits"),
};

const TRANSCRIPTIONS: VpcRouteSpec = {
  kind: "transcription",
  what: "transcriptions",
  // Long recordings can take minutes; the JSON reply tolerates leading spaces.
  heartbeat: true,
  // [fork] W21: priced from the reply's `usage` tokens (audio in, text out).
  priced: true,
  replyUsage: transcriptionUsage,
  async parse(request): Promise<RouteRequest | Response> {
    const form = await readForm(request);
    if (form instanceof Response) return form;
    const repeated = singleTextFields(form, ["model"]);
    if (repeated) return repeated;
    const rawModel = text(form.get("model"));
    if (!rawModel) return invalid("model is required");
    if (!isFile(form.get("file"))) return invalid("file is required");
    const format = text(form.get("response_format"));
    return {
      rawModel,
      contentType: null,
      tokens: 0,
      units: null,
      // Heartbeat spaces are only harmless in front of JSON: text, srt and
      // vtt replies are passed through as sent.
      heartbeat:
        format === "" || format === "json" || format === "verbose_json",
      body: (upstreamModel) => copyForm(form, { model: upstreamModel }),
    };
  },
  send: postTo("/v1/audio/transcriptions"),
};

const SPEECH: VpcRouteSpec = {
  kind: "speech",
  what: "speech requests",
  // Binary audio: no heartbeat spaces in front of it.
  heartbeat: false,
  priced: false,
  async parse(request): Promise<RouteRequest | Response> {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const rawModel = text(body.model);
    if (!rawModel) return invalid("model is required");
    if (typeof body.input !== "string" || !body.input.trim()) {
      return invalid("input is required");
    }
    return {
      rawModel,
      contentType: "application/json",
      tokens: 0,
      units: null,
      body: (upstreamModel) =>
        JSON.stringify({ ...body, model: upstreamModel }),
    };
  },
  send: postTo("/v1/audio/speech"),
};

const SYSTEMONE: VpcRouteSpec = {
  kind: "decision",
  what: "systemone requests",
  heartbeat: false,
  priced: false,
  async parse(request): Promise<RouteRequest | Response> {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const rawModel = text(body.model);
    if (!rawModel) return invalid("model is required");
    // The upstream serves one model and takes no `model` field.
    const { model: _model, ...rest } = body;
    void _model;
    return {
      rawModel,
      contentType: "application/json",
      tokens: 0,
      units: null,
      body: () => JSON.stringify(rest),
    };
  },
  send: postTo("/v1/systemone"),
};

export function imageEditsV2(input: VpcRouteInput): Promise<Response> {
  return serveVpcRoute(input, IMAGE_EDITS);
}

export function audioTranscriptionsV2(input: VpcRouteInput): Promise<Response> {
  return serveVpcRoute(input, TRANSCRIPTIONS);
}

export function audioSpeechV2(input: VpcRouteInput): Promise<Response> {
  return serveVpcRoute(input, SPEECH);
}

export function systemoneV2(input: VpcRouteInput): Promise<Response> {
  return serveVpcRoute(input, SYSTEMONE);
}
