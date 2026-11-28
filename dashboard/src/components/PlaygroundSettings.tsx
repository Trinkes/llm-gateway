// [fork] W23: the side card that holds a playground mode's parameters.
import type { ReactNode } from "react";

export function PlaygroundSettings({ children }: { children: ReactNode }) {
  return (
    <aside className="h-fit space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Parameters
      </h3>
      {children}
    </aside>
  );
}
