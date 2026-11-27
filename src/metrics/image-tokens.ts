// [fork] W19: image generations priced as output tokens, the way OpenAI bills
// gpt-image-1. The count only feeds pricing and the rate-limit estimate; it is
// not stored in the token columns, so image rows stay out of token stats.
import { imageCount } from "./request-kinds";

/** Output tokens of one 1024x1024 image per quality (OpenAI gpt-image-1). */
export const IMAGE_QUALITY_TOKENS = {
  low: 272,
  medium: 1056,
  high: 4160,
} as const;

type ImageQuality = keyof typeof IMAGE_QUALITY_TOKENS;

const BASE_PIXELS = 1024 * 1024;
const SIZE_PATTERN = /^(\d+)x(\d+)$/;

/**
 * Output tokens for an image request: each image's pixel area relative to
 * 1024x1024 times its quality's count, times the image count. A missing,
 * `null`, `auto` or unknown size is 1024x1024; a missing, `auto` or unknown quality
 * is high (the upstream may pick its best).
 */
export function imageOutputTokens(params: {
  size?: unknown;
  quality?: unknown;
  n?: unknown;
}): number {
  const pixels = sizePixels(params.size);
  const perImage = Math.ceil(
    (pixels / BASE_PIXELS) * IMAGE_QUALITY_TOKENS[quality(params.quality)],
  );
  return perImage * imageCount(params.n);
}

/**
 * Whether a request's size can be priced as asked: missing, `null` (some
 * client libraries send it for unset fields), `auto`, or `WIDTHxHEIGHT` with
 * both sides positive. Anything else is refused, so the
 * upstream never renders a size other than the one priced.
 */
export function isPriceableSize(size: unknown): boolean {
  if (size === undefined || size === null || size === "auto") return true;
  return parsedPixels(size) !== null;
}

function sizePixels(size: unknown): number {
  return parsedPixels(size) ?? BASE_PIXELS;
}

function parsedPixels(size: unknown): number | null {
  const match = typeof size === "string" ? SIZE_PATTERN.exec(size) : null;
  if (!match) return null;
  const pixels = Number(match[1]) * Number(match[2]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}

function quality(value: unknown): ImageQuality {
  if (value === "low" || value === "medium") return value;
  if (value === "standard") return "medium";
  return "high";
}
