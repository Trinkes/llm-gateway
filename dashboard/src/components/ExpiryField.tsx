import {
  EXPIRY_PRESETS,
  presetInputValue,
  toLocalInputValue,
} from "../lib/keyExpiry";
import { Button, Input, Label } from "./ui";

/**
 * Expiry picker for API keys. `value` is a `datetime-local` string in the
 * browser's local time; "" means the key never expires.
 */
export function ExpiryField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div>
      <Label>Expires (optional)</Label>
      <Input
        type="datetime-local"
        min={toLocalInputValue(nowSeconds())}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {EXPIRY_PRESETS.map((p) => (
          <Button
            key={p.days}
            size="sm"
            variant="outline"
            onClick={() => onChange(presetInputValue(p.days, nowSeconds()))}
          >
            {p.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onChange("")}>
          Never
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-gray-400">
        {value === ""
          ? "Never expires."
          : `Your local time (${timeZone}). Requests with this key are refused after it.`}
      </p>
    </div>
  );
}
