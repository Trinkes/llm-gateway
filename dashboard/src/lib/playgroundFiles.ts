// [fork] W23: file helpers for the playground's uploads and results.

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** `src` for one image of an images API reply (`b64_json` or `url`). */
export function imageSrc(
  item: { b64_json?: string; url?: string },
  outputFormat?: string,
): string | null {
  if (item.b64_json) {
    const mime =
      IMAGE_MIME[(outputFormat ?? "png").toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${item.b64_json}`;
  }
  return safeHttpUrl(item.url);
}

/** `url` when it is http(s); anything else (`javascript:`, `data:`…) is dropped. */
function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** File extension for a speech `response_format`. */
export function audioExtension(format: string): string {
  return format === "opus" ? "ogg" : format;
}
