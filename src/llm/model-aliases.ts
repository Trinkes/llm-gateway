// [fork] W18: provider-level model aliases. `settings.modelAliases` maps the
// model id clients see and send (the alias) to the id the upstream knows, for
// upstreams whose own ids are unhelpful. `/v1/models` lists the alias instead
// of the upstream id, and requests naming the alias reach the upstream id.

const MAX_ALIASES = 50;

function aliasesOf(
  settings: Record<string, unknown> | undefined,
): Record<string, string> {
  const raw = settings?.modelAliases;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, string>;
}

/** The id to send upstream for `model`. */
export function upstreamModelId(
  settings: Record<string, unknown> | undefined,
  model: string,
): string {
  const target = aliasesOf(settings)[model];
  return typeof target === "string" ? target : model;
}

/** `models` with each aliased upstream id replaced by its alias(es). */
export function aliasModelList<T extends { id: string }>(
  settings: Record<string, unknown> | undefined,
  models: T[],
): T[] {
  const entries = Object.entries(aliasesOf(settings));
  if (entries.length === 0) return models;
  return models.flatMap((m) => {
    const aliases = entries.filter(([, up]) => up === m.id).map(([a]) => a);
    return aliases.length === 0 ? [m] : aliases.map((id) => ({ ...m, id }));
  });
}

/** Validate and trim a `settings.modelAliases` value for saving. */
export function validateModelAliases(value: unknown): Record<string, string> {
  const fail = (why: string): never => {
    throw new Error(`settings.modelAliases ${why}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("must be an object of alias → upstream model id");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ALIASES)
    fail(`allows at most ${MAX_ALIASES} entries`);
  const out: Record<string, string> = {};
  for (const [rawAlias, rawTarget] of entries) {
    const alias = rawAlias.trim();
    if (typeof rawTarget !== "string" || !rawTarget.trim()) {
      fail(`entry '${alias}' must map to a non-empty model id`);
    }
    if (!alias || alias.includes("/")) {
      fail("aliases must be non-empty and contain no '/'");
    }
    out[alias] = (rawTarget as string).trim();
  }
  return out;
}
