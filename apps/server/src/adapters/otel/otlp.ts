/** One data point of a gauge: a value and the attributes that tell its series apart. */
export interface GaugePoint {
  value: number
  attributes?: Record<string, string>
}

export interface Gauge {
  name: string
  unit: string
  points: GaugePoint[]
}

const attrs = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value: { stringValue: value } }))

/**
 * An OTLP/HTTP JSON `ExportMetricsServiceRequest` of gauges (`POST /v1/metrics`, `Content-Type: application/json`). Field names
 * are lowerCamelCase, a timestamp is a decimal string of nanoseconds (built with a BigInt: it passes 2^53). A gauge has no
 * temporality, so a push that is lost or repeated changes nothing. A gauge with no point is left out.
 */
export function encodeGauges(input: { resource: Record<string, string>; scope: string; at: Date; gauges: Gauge[] }) {
  const timeUnixNano = (BigInt(input.at.getTime()) * 1_000_000n).toString()
  return {
    resourceMetrics: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeMetrics: [
          {
            scope: { name: input.scope },
            metrics: input.gauges
              .filter((gauge) => gauge.points.length > 0)
              .map((gauge) => ({
                name: gauge.name,
                unit: gauge.unit,
                gauge: {
                  dataPoints: gauge.points.map((point) => ({
                    timeUnixNano,
                    asDouble: point.value,
                    attributes: attrs(point.attributes ?? {}),
                  })),
                },
              })),
          },
        ],
      },
    ],
  }
}
