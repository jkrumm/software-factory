import { KPI_CATALOG, type Kpi, type KpiKey } from '@software-factory/contract'

/** The fields of a KPI that are stated once, in the catalog (`packages/contract/src/kpi-catalog.ts`), not at each call. */
export type CatalogField = 'label' | 'target' | 'direction' | 'targetSource'

/** The catalog's label, target, direction and target source for one KPI: what the Console renders of it. */
export const catalogFields = (key: KpiKey): Pick<Kpi, CatalogField> => {
  const spec = KPI_CATALOG[key]
  return { label: spec.label, target: spec.target, direction: spec.direction, targetSource: spec.targetSource }
}
