// [fork] W16: pick the providers an API key may use, and the default for bare
// model ids when there are several.
import type { ProviderSelection } from "../lib/keyProviders";
import { Label, Select, type SelectOption } from "./ui";

export function ProviderScopeField({
  options,
  value,
  onChange,
}: {
  options: SelectOption[];
  value: ProviderSelection;
  onChange: (value: ProviderSelection) => void;
}) {
  const { selected, defaultProvider } = value;
  const defaultOptions = options.filter((o) => selected.includes(o.value));
  return (
    <div className="space-y-3">
      <div>
        <Label>Providers (optional)</Label>
        <Select
          className="w-full"
          multiple
          value={selected}
          onChange={(v) => {
            const next = v as string[];
            onChange({
              selected: next,
              defaultProvider: next.includes(defaultProvider)
                ? defaultProvider
                : (next[0] ?? ""),
            });
          }}
          options={options}
          placeholder="Any provider — requires provider/model"
        />
        <p className="mt-1 text-[11px] text-gray-400">
          The key can only use the providers picked here. With one, model ids
          without a provider prefix go to it.
        </p>
      </div>
      {selected.length > 1 && (
        <div>
          <Label>Default for model ids without a provider</Label>
          <Select
            className="w-full"
            value={defaultProvider}
            onChange={(v) =>
              onChange({ selected, defaultProvider: v as string })
            }
            options={defaultOptions}
          />
        </div>
      )}
    </div>
  );
}
