// This file runs with bun.

const METRIC_EVENT = "azookey_metrics";
const PIPELINE_METRIC_EVENT = "speech_pipeline_metrics";
const LATENCY_FIELDS = [
  "lexiconSyncMs",
  "dictionaryConvertMs",
  "latticeOpenMs",
  "latticeUniqueMs",
  "zenzHttpMs",
  "zenzPromptMs",
  "zenzPredictedMs",
  "zenzContainerHeadersMs",
  "zenzBodyTransferMs",
  "zenzRuntimeOverheadMs",
  "zenzOverheadMs",
  "latticeSearchMs",
  "orchestrationMs",
  "latticeCloseMs",
  "totalMs",
];
const PIPELINE_LATENCY_FIELDS = ["asrMs", "vibratoMs", "n5Ms", "azookeyMs", "totalMs"];

const inputPath = process.argv[2];
const input = inputPath
  ? await Bun.file(inputPath).text()
  : await new Response(Bun.stdin.stream()).text();
const events = input
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const records = events.filter((value) => value?.event === METRIC_EVENT);
const pipelineRecords = events.filter((value) => value?.event === PIPELINE_METRIC_EVENT);

if (records.length === 0 && pipelineRecords.length === 0) {
  throw new Error("No normalized AzooKey or speech pipeline metrics records found");
}

const percentile = (values, fraction) => {
  const sorted = values.toSorted((left, right) => left - right);
  const rank = (sorted.length - 1) * fraction;
  const lower = sorted[Math.floor(rank)] ?? 0;
  const upper = sorted[Math.ceil(rank)] ?? lower;
  return Math.round((lower + (upper - lower) * (rank - Math.floor(rank))) * 1_000) / 1_000;
};

const summarizeValues = (values) => ({
  average:
    Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1_000) / 1_000,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

const summarizeLatency = (values) =>
  Object.fromEntries(
    LATENCY_FIELDS.map((field) => [
      field,
      summarizeValues(values.map((record) => Number(record[field]) || 0)),
    ]),
  );
const latency = records.length === 0 ? undefined : summarizeLatency(records);
const pipelineLatency =
  pipelineRecords.length === 0
    ? undefined
    : Object.fromEntries(
        PIPELINE_LATENCY_FIELDS.map((field) => [
          field,
          summarizeValues(pipelineRecords.map((record) => Number(record[field]) || 0)),
        ]),
      );
const successfulGguf = records.filter(
  (record) => record.outcome === "gguf" && record.zenzHttpReason === "ok",
);
const successfulGgufLatency =
  successfulGguf.length === 0 ? undefined : summarizeLatency(successfulGguf);
const countBy = (field) =>
  Object.fromEntries(
    Object.entries(Object.groupBy(records, (record) => String(record[field] ?? "missing"))).map(
      ([key, values]) => [key, values.length],
    ),
  );
const averages = latency
  ? Object.fromEntries(
      LATENCY_FIELDS.map((field) => [field, latency[field].average]).sort(
        (left, right) => right[1] - left[1],
      ),
    )
  : {};

console.log(
  JSON.stringify(
    {
      samples: records.length,
      outcomes: countBy("outcome"),
      fallbackRate:
        records.length === 0
          ? 0
          : records.filter((record) => record.outcome === "fallback").length / records.length,
      models: countBy("requestedModel"),
      zenzReasons: countBy("zenzHttpReason"),
      averageBottlenecksMs: averages,
      latencyMs: latency,
      pipeline:
        pipelineLatency === undefined
          ? { samples: 0 }
          : {
              samples: pipelineRecords.length,
              profiles: Object.fromEntries(
                Object.entries(
                  Object.groupBy(
                    pipelineRecords,
                    (record) =>
                      `${record.profile?.computeTier ?? "missing"}:${record.profile?.modelSize ?? "missing"}:${record.profile?.n5Mode ?? "missing"}`,
                  ),
                ).map(([key, values]) => [key, values.length]),
              ),
              latencyMs: pipelineLatency,
            },
      successfulGguf:
        successfulGgufLatency === undefined
          ? { samples: 0 }
          : { samples: successfulGguf.length, latencyMs: successfulGgufLatency },
      tokenAverages:
        records.length === 0
          ? { prompt: 0, predicted: 0, cached: 0 }
          : {
              prompt: summarizeValues(records.map((record) => Number(record.zenzPromptTokens) || 0))
                .average,
              predicted: summarizeValues(
                records.map((record) => Number(record.zenzPredictedTokens) || 0),
              ).average,
              cached: summarizeValues(records.map((record) => Number(record.zenzCachedTokens) || 0))
                .average,
            },
    },
    null,
    2,
  ),
);
