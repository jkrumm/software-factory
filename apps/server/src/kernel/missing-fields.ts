/** A form that is not complete: the fields that are missing or wrong, each named as the lead wrote it. */
export interface MissingFields {
  kind: 'missing_field'
  fields: string[]
  detail: string
}
