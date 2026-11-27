// [fork] W15: OpenAI-compatible image generations for OpenAI-compatible
// providers (typically a self-hosted image server behind a vpc binding).
// [fork] W20: the shared flow (policy, vpc fetcher, rate limit, request row,
// heartbeat) lives in vpc-route.ts.
import { imageOutputTokens, isPriceableSize } from "../metrics/image-tokens";
import { imageCount } from "../metrics/request-kinds";
import {
  invalid,
  serveVpcRoute,
  type RouteRequest,
  type VpcRouteInput,
  type VpcRouteSpec,
} from "./vpc-route";

export { IMAGE_GRACE_MS, IMAGE_HEARTBEAT_MS, IMAGE_MAX_MS } from "./vpc-route";

export type ImageGenerationsInput = VpcRouteInput;

interface ImageRequestBody {
  model?: unknown;
  prompt?: unknown;
  size?: unknown;
  quality?: unknown;
  n?: unknown;
  [key: string]: unknown;
}

const IMAGE_GENERATIONS: VpcRouteSpec = {
  kind: "image",
  what: "image generations",
  heartbeat: true,
  priced: true,
  async parse(request): Promise<RouteRequest | Response> {
    let body: ImageRequestBody;
    try {
      const json = await request.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return invalid("Invalid request body");
      }
      body = json as ImageRequestBody;
    } catch {
      return invalid("Invalid request body");
    }
    const rawModel = typeof body.model === "string" ? body.model.trim() : "";
    if (!rawModel) return invalid("model is required");
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return invalid("prompt is required");
    }
    // [fork] W19: only a size we can price reaches the upstream.
    if (!isPriceableSize(body.size)) {
      return invalid("size must be WIDTHxHEIGHT or auto");
    }
    return {
      rawModel,
      contentType: "application/json",
      // [fork] W19: the request's size, quality and n as output tokens.
      tokens: imageOutputTokens(body),
      units: imageCount(body.n),
      body: (upstreamModel) =>
        JSON.stringify({
          ...body,
          // [fork] W19: the upstream renders the image count that was charged.
          ...("n" in body ? { n: imageCount(body.n) } : {}),
          // [fork] W19: a null size was priced as unset, so it is sent as unset.
          ...(body.size === null ? { size: undefined } : {}),
          model: upstreamModel,
        }),
    };
  },
  send: (client, body, init) =>
    client.imageGenerations(body as string, { signal: init.signal }),
};

export function imageGenerationsV2(
  input: ImageGenerationsInput,
): Promise<Response> {
  return serveVpcRoute(input, IMAGE_GENERATIONS);
}
