// [fork] W22: the Live page's "Models" card (live mode and stored ranges).
import type { ModelActivity } from "../lib/api";
import { modelsWindowS } from "../lib/liveModels";
import { LiveModelsChart } from "./LiveModelsChart";
import { LiveModelsTable } from "./LiveModelsTable";
import { Card, EmptyState } from "./ui";

export function LiveModelsCard({
  models,
  domain,
  bucketS,
}: {
  models: ModelActivity[];
  /** [from, to] in ms. */
  domain: [number, number];
  /** Width of one busy point; the table's rates cover the points shown. */
  bucketS: number;
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
            windowS={modelsWindowS(models, bucketS)}
          />
        </>
      )}
    </Card>
  );
}
