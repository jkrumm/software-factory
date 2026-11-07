/**
 * An applied event of an Issue as this domain reads it: the work domain's record, seen through the few fields a lead
 * cares about. `app/` hands the work domain's records over; a record is structurally one of these.
 */
export interface HistoryRecord {
  kind: string
  payload: unknown
  at: Date
  /** the Issue version this event produced */
  version: number
}

export const field = (record: HistoryRecord, name: string): unknown =>
  (record.payload as Record<string, unknown> | null)?.[name]
