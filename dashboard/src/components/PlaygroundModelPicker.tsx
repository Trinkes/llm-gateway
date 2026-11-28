// [fork] W23: model choice for the playground. Models that look right for the
// mode come first; any model, or a typed id, can still be used.
import { rankModels, type PlaygroundMode } from "../lib/playgroundModes";
import { Input } from "./ui";

const TYPE_OWN = "__type_own__";

export function PlaygroundModelPicker({
  mode,
  models,
  value,
  onChange,
  loading,
}: {
  mode: PlaygroundMode;
  models: string[] | null;
  value: string;
  onChange: (model: string) => void;
  loading: boolean;
}) {
  if (!models || models.length === 0) {
    return (
      <Input
        value={value}
        placeholder={loading ? "Loading models…" : "provider/model"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const { suggested, others } = rankModels(mode, models);
  const listed = models.includes(value);
  return (
    <div className="space-y-2">
      <select
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        value={listed ? value : TYPE_OWN}
        onChange={(e) =>
          onChange(e.target.value === TYPE_OWN ? "" : e.target.value)
        }
      >
        {suggested.length > 0 && (
          <optgroup label="Suggested">
            {suggested.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={suggested.length ? "Other models" : "Models"}>
            {others.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </optgroup>
        )}
        <option value={TYPE_OWN}>Type a model id…</option>
      </select>
      {!listed && (
        <Input
          value={value}
          placeholder="provider/model"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
