// [fork] W23: the playground's last request as a copyable curl command.

export type CurlBody =
  | { kind: "json"; value: unknown }
  | { kind: "form"; fields: [string, string | { fileName: string }][] };

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Truncate long strings (data URLs, base64) so the command stays readable. */
function shorten(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 200
      ? `${value.slice(0, 64)}…(${value.length} chars)`
      : value;
  }
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shorten(v)]),
    );
  }
  return value;
}

export function buildCurl(url: string, body: CurlBody): string {
  const lines = [`curl ${quote(url)}`, `  -H "Authorization: Bearer $API_KEY"`];
  if (body.kind === "json") {
    lines.push(`  -H 'Content-Type: application/json'`);
    lines.push(`  -d ${quote(JSON.stringify(shorten(body.value), null, 2))}`);
  } else {
    for (const [name, value] of body.fields) {
      lines.push(
        typeof value === "string"
          ? `  -F ${quote(`${name}=${value}`)}`
          : `  -F ${quote(`${name}=@${value.fileName}`)}`,
      );
    }
  }
  return lines.join(" \\\n");
}
