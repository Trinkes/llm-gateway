// [fork] W22: the Live page's "Models" card (live mode and stored ranges).
import type { ModelActivity } from "../lib/api";
import { LiveModelsChart } from "./LiveModelsChart";
import { LiveModelsTable } from "./LiveModelsTable";
import { Card, EmptyState } from "./ui";

export function LiveModelsCard({
  models,
  domain,
}: {
  models: ModelActivity[];
  /** [from, to] in ms; also the window the table's stats cover. */
  domain: [number, number];
}) {
  return (
    <Card
      title="Models"
      subtitle="Busy = requests running at once · from finished requests"
    >
      {models.length === 0 ? (
        <EmptyState title="No local providers" />
      ) : (
        <>
          <LiveModelsChart models={models} domain={domain} />
          <LiveModelsTable
            models={models}
            windowS={(domain[1] - domain[0]) / 1000}
          />
        </>
      )}
    </Card>
  );
}
