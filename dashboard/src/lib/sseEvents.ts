// [fork] W23: split a Server-Sent Events byte stream into `data:` payloads.

/** Split complete events off `buffer`; the rest waits for more bytes. */
export function takeSseData(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const events = normalized.split("\n\n");
  const rest = events.pop() ?? "";
  const data: string[] = [];
  for (const event of events) {
    const lines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (lines.length) data.push(lines.join("\n"));
  }
  return { data, rest };
}

/** Call `onData` for every `data:` payload of a streamed response body. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { data, rest } = takeSseData(done ? `${buffer}\n\n` : buffer);
    data.forEach(onData);
    buffer = rest;
    if (done) return;
  }
}
