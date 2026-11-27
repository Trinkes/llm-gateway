// [fork] W16: which providers an API key may use, as edited in the key forms.
// One provider is stored as `defaultProvider` alone (the binding older keys
// already have); several are stored as `providers` plus the `defaultProvider`
// that resolves bare model ids. None means any provider.

export interface ProviderScopes {
  providers?: string[];
  defaultProvider?: string;
  [key: string]: unknown;
}

export interface ProviderSelection {
  selected: string[];
  defaultProvider: string;
}

/** Providers a key may use; empty means any. */
export function keyProviderIds(scopes: ProviderScopes): string[] {
  if (scopes.providers && scopes.providers.length > 0) return scopes.providers;
  return scopes.defaultProvider ? [scopes.defaultProvider] : [];
}

export function initialProviderSelection(
  scopes: ProviderScopes,
): ProviderSelection {
  const selected = keyProviderIds(scopes);
  return {
    selected,
    defaultProvider: scopes.defaultProvider ?? selected[0] ?? "",
  };
}

export function toggleProvider(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((p) => p !== id)
    : [...selected, id];
}

/** Scopes with the provider fields replaced by `selected` / `defaultProvider`. */
export function applyProviderSelection(
  scopes: ProviderScopes,
  selected: string[],
  defaultProvider: string,
): ProviderScopes {
  const rest = { ...scopes };
  delete rest.providers;
  delete rest.defaultProvider;
  if (selected.length === 0) return rest;
  if (selected.length === 1) return { ...rest, defaultProvider: selected[0] };
  return {
    ...rest,
    providers: selected,
    defaultProvider: selected.includes(defaultProvider)
      ? defaultProvider
      : selected[0],
  };
}
