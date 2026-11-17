import { Popover } from '@base-ui/react/popover'
import { CaretDownIcon, CaretUpIcon, ColumnsIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { ProjectIndexModel, ProjectIndexRow } from '@software-factory/contract'
import {
  type ColumnVisibilityState,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  tableFeatures,
  type Updater,
  useTable,
} from '@tanstack/react-table'
import { Link, useNavigate } from '@tanstack/react-router'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { InfoHint, type InfoWord } from '@/components/kit/info-hint'
import { Segments } from '@/components/kit/segments'
import { Input } from '@/components/ui/input'
import { ageWords } from '@/lib/age'
import {
  busiest,
  COLUMN_IDS,
  type ColumnId,
  type Density,
  groupRows,
  hygieneShare,
  loadPrefs,
  matchesQuick,
  openOf,
  planShare,
  productionRank,
  QUICK_FILTERS,
  QUICK_HINTS,
  QUICK_WORDS,
  type QuickFilter,
  savePrefs,
  shippedOf,
  type TablePrefs,
} from '@/lib/project-table'
import { useMediaQuery } from '@/lib/media'
import { prefetchProject } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { ProjectCard } from './card'
import {
  HygieneCell,
  hourLabels,
  LastShipCell,
  LeadsCell,
  MedianCell,
  NowCell,
  PlanCell,
  ProductionCell,
  ShippedCell,
} from './cells'

/**
 * The Projects table on TanStack Table: one row per project in the owner's Herdr groups, an in-cell visual per column,
 * sorting on every column, a search and quick filters, columns to show and hide, all remembered per browser
 * (`lib/project-table.ts`). A row opens its project; hovering or focusing it previews the project's digest.
 */

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  columnVisibilityFeature,
})

const helper = createColumnHelper<typeof features, ProjectIndexRow>()
const orUndefined = (value: number | null): number | undefined => (value === null ? undefined : value)

/** Every column sorts by the figure its cell shows; a missing figure sorts last both ways. */
const columns = helper.columns([
  helper.accessor('name', { id: 'name', header: 'Project', sortFn: 'alphanumeric', enableHiding: false }),
  helper.accessor(openOf, { id: 'now', header: 'Now', sortDescFirst: true }),
  helper.accessor(shippedOf, { id: 'shipped', header: 'Shipped 7 d', sortDescFirst: true }),
  helper.accessor((row) => orUndefined(row.shipped.lastAt ? Date.parse(row.shipped.lastAt) : null), {
    id: 'last',
    header: 'Last ship',
    sortDescFirst: true,
    sortUndefined: 'last',
  }),
  helper.accessor((row) => orUndefined(row.cycle.ms), {
    id: 'cycle',
    header: 'Cycle',
    sortDescFirst: true,
    sortUndefined: 'last',
  }),
  helper.accessor((row) => orUndefined(row.queueWait.ms), {
    id: 'wait',
    header: 'Queue wait',
    sortDescFirst: true,
    sortUndefined: 'last',
  }),
  helper.accessor(productionRank, { id: 'production', header: 'Production', sortDescFirst: true }),
  helper.accessor((row) => orUndefined(hygieneShare(row)), {
    id: 'hygiene',
    header: 'Hygiene',
    sortUndefined: 'last',
  }),
  helper.accessor((row) => orUndefined(planShare(row)), {
    id: 'plan',
    header: 'Plan',
    sortDescFirst: true,
    sortUndefined: 'last',
  }),
  helper.accessor((row) => row.leads.running, { id: 'leads', header: 'Leads', sortDescFirst: true }),
])

/** What each column answers, on hover of its header; the domain words carry their InfoHint. */
const HEADS: Record<ColumnId, { title: string; hint?: InfoWord; width: string; align: 'left' | 'right' }> = {
  name: { title: 'The project; a click opens its page', width: '13rem', align: 'left' },
  now: {
    title: 'Open Issues now: running, paused, ready, held, checking (Flow’s words)',
    hint: 'running',
    width: '12rem',
    align: 'left',
  },
  shipped: {
    title: 'Issues closed done or healed, per hour over 7 days, and their count',
    width: '13rem',
    align: 'left',
  },
  last: { title: 'The newest ship', width: '6rem', align: 'right' },
  cycle: {
    title: 'Median filed to closed, 7 days, against the 7 before',
    hint: 'cycle',
    width: '7rem',
    align: 'right',
  },
  wait: {
    title: 'Median filed to a lead started, 7 days, against the 7 before',
    hint: 'queue wait',
    width: '7.5rem',
    align: 'right',
  },
  production: {
    title: 'Red: an incident open; warn: a regression in 7 days; lit: in Watch',
    hint: 'incident',
    width: '7.5rem',
    align: 'right',
  },
  hygiene: {
    title: 'Probes clean of run in the newest pass, and the oldest finding still raised',
    hint: 'probe',
    width: '7rem',
    align: 'right',
  },
  plan: { title: 'Plan rows done of all', hint: 'plan', width: '9rem', align: 'left' },
  leads: {
    title: 'Leads running in the project, of the seats the host admits now',
    hint: 'seat',
    width: '8rem',
    align: 'left',
  },
}

const ROW_HEIGHT: Record<Density, string> = { compact: 'h-[26px]', comfortable: 'h-10' }
const PREVIEW_DELAY_MS = 350

const toColumnIds = (sorting: SortingState): TablePrefs['sort'] =>
  sorting.flatMap((s) =>
    (COLUMN_IDS as readonly string[]).includes(s.id) ? [{ id: s.id as ColumnId, desc: s.desc }] : [],
  )

const apply = <T,>(updater: Updater<T>, current: T): T =>
  typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater

export function ProjectTable({ model, now }: { model: ProjectIndexModel; now: number }) {
  const [prefs, setPrefsState] = useState<TablePrefs>(loadPrefs)
  const [quick, setQuick] = useState<QuickFilter>('all')
  const [search, setSearch] = useState('')
  const setPrefs = (next: (current: TablePrefs) => TablePrefs) =>
    setPrefsState((current) => {
      const value = next(current)
      savePrefs(value)
      return value
    })

  const data = useMemo(
    () => model.projects.filter((row) => matchesQuick(row, quick, now)).sort(busiest),
    [model.projects, quick, now],
  )
  const sorting: SortingState = prefs.sort
  const columnVisibility: ColumnVisibilityState = Object.fromEntries(prefs.hidden.map((id) => [id, false]))
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.name,
    state: { sorting, columnVisibility, globalFilter: search },
    onSortingChange: (updater) => setPrefs((p) => ({ ...p, sort: toColumnIds(apply(updater, sorting)) })),
    onColumnVisibilityChange: (updater) =>
      setPrefs((p) => {
        const next = apply(updater, columnVisibility)
        return { ...p, hidden: COLUMN_IDS.filter((id) => id !== 'name' && next[id] === false) }
      }),
    onGlobalFilterChange: (updater) => setSearch((current) => String(apply(updater, current) ?? '')),
    globalFilterFn: 'includesString',
    getColumnCanGlobalFilter: (column) => column.id === 'name',
  })

  const rows = table.getRowModel().rows
  const visible = table.getVisibleLeafColumns()
  const groups = prefs.grouped
    ? groupRows(
        rows.map((row) => ({ group: row.original.group, row })),
        model.groups,
      )
    : [{ group: '', rows: rows.map((row) => ({ group: '', row })) }]
  const ordered = groups.flatMap((g) => g.rows.map((r) => r.row))
  const scale = Math.max(1, ...model.projects.map(openOf))
  const labels = useMemo(() => hourLabels(Date.parse(model.at)), [model.at])

  const wide = useMediaQuery('(min-width: 40rem)')
  const navigate = useNavigate()
  const open = (name: string) => void navigate({ to: '/projects/$name', params: { name } })

  // the roving focus: one row is the table's Tab stop, the arrows move it
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const [focused, setFocused] = useState<string | null>(null)
  const current = focused !== null && ordered.some((r) => r.id === focused) ? focused : (ordered[0]?.id ?? null)
  const focusRow = (id: string | undefined) => {
    if (!id) return
    setFocused(id)
    rowRefs.current.get(id)?.focus()
  }

  // the digest preview: one popover for the table, anchored to the row under the pointer or the focus
  const [preview, setPreview] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])
  const previewLater = (id: string) => {
    clearTimer()
    timer.current = setTimeout(() => setPreview(id), PREVIEW_DELAY_MS)
  }
  const previewed = preview === null ? undefined : model.projects.find((p) => p.name === preview)

  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    const index = ordered.findIndex((r) => r.id === id)
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step !== undefined) focusRow(ordered[Math.max(0, Math.min(ordered.length - 1, index + step))]?.id)
    else if (event.key === 'Home') focusRow(ordered[0]?.id)
    else if (event.key === 'End') focusRow(ordered[ordered.length - 1]?.id)
    else if (event.key === 'Enter') open(id)
    else if (event.key === 'Escape' && preview !== null) setPreview(null)
    else return
    event.preventDefault()
  }

  const cell = (id: ColumnId, row: ProjectIndexRow): ReactNode => {
    switch (id) {
      case 'name':
        return <NameCell row={row} />
      case 'now':
        return <NowCell row={row} scale={scale} />
      case 'shipped':
        return <ShippedCell row={row} labels={labels} />
      case 'last':
        return <LastShipCell row={row} now={now} />
      case 'cycle':
        return <MedianCell median={row.cycle} what="Cycle" />
      case 'wait':
        return <MedianCell median={row.queueWait} what="Queue wait" />
      case 'production':
        return <ProductionCell row={row} now={now} />
      case 'hygiene':
        return <HygieneCell row={row} now={now} />
      case 'plan':
        return <PlanCell row={row} />
      case 'leads':
        return <LeadsCell row={row} seats={model.seats} />
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Projects table">
        <label className="relative w-56 max-w-full">
          <span className="sr-only">Search projects</span>
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            name="project-search"
            autoComplete="off"
            placeholder="Search projects"
            value={search}
            onChange={(event) => table.setGlobalFilter(event.target.value)}
            className="h-8 pl-8"
          />
        </label>
        <Segments
          label="Show"
          value={quick}
          onChange={setQuick}
          choices={QUICK_FILTERS.map((key) => ({ key, label: QUICK_WORDS[key], hint: QUICK_HINTS[key] }))}
        />
        <span className="ml-auto" />
        <Segments
          className="hidden sm:flex"
          label="Group"
          value={prefs.grouped ? 'groups' : 'flat'}
          onChange={(key) => setPrefs((p) => ({ ...p, grouped: key === 'groups' }))}
          choices={[
            { key: 'groups', label: 'Groups', hint: 'Grouped as the Herdr spaces' },
            { key: 'flat', label: 'Flat', hint: 'One list' },
          ]}
        />
        <Segments
          className="hidden sm:flex"
          label="Density"
          value={prefs.density}
          onChange={(density) => setPrefs((p) => ({ ...p, density }))}
          choices={[
            { key: 'compact', label: 'Compact' },
            { key: 'comfortable', label: 'Comfortable' },
          ]}
        />
        <ColumnsMenu
          columns={table
            .getAllLeafColumns()
            .filter((column) => column.getCanHide())
            .map((column) => ({
              id: column.id as ColumnId,
              label: String(column.columnDef.header),
              shown: column.getIsVisible(),
              toggle: () => column.toggleVisibility(),
            }))}
        />
      </div>

      {wide ? null : (
        <div className="grid gap-4">
          {groups.map((group) => (
            <section key={group.group || 'all'} aria-label={group.group || 'Projects'} className="grid gap-2">
              {prefs.grouped ? (
                <h2 className="px-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {group.group} <span className="font-normal tabular-nums">{group.rows.length}</span>
                </h2>
              ) : null}
              {group.rows.map(({ row }) => (
                <ProjectCard
                  key={row.id}
                  project={row.original}
                  scale={scale}
                  labels={labels}
                  now={now}
                  showGroup={!prefs.grouped}
                />
              ))}
            </section>
          ))}
          {ordered.length === 0 ? <p className="text-sm text-muted-foreground">No project matches.</p> : null}
        </div>
      )}

      <div
        hidden={!wide}
        className="max-h-[calc(100dvh-12.5rem)] overflow-auto rounded-xl bg-card"
        style={{ boxShadow: 'var(--vx-shadow-card)' }}
        onPointerLeave={() => {
          clearTimer()
          setPreview(null)
        }}
      >
        <table aria-label="Projects" className="w-full min-w-[86rem] table-fixed border-separate border-spacing-0">
          <colgroup>
            {visible.map((column) => (
              <col key={column.id} style={{ width: HEADS[column.id as ColumnId].width }} />
            ))}
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const id = header.column.id as ColumnId
                  const head = HEADS[id]
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      className={cn(
                        'sticky top-0 z-10 h-8 bg-card px-2 text-xs last:pr-4 font-medium whitespace-nowrap text-muted-foreground',
                        'shadow-[inset_0_-1px_0_var(--vx-grid)]',
                        id === 'name' && 'left-0 z-20 pl-4',
                        head.align === 'right' ? 'text-right' : 'text-left',
                      )}
                    >
                      <span
                        className={cn('inline-flex items-center gap-0.5', head.align === 'right' && 'flex-row-reverse')}
                      >
                        <button
                          type="button"
                          title={head.title}
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            'inline-flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
                            sorted && 'text-foreground',
                          )}
                        >
                          {String(header.column.columnDef.header)}
                          {sorted === 'asc' ? (
                            <CaretUpIcon weight="bold" aria-hidden="true" className="size-3" />
                          ) : sorted === 'desc' ? (
                            <CaretDownIcon weight="bold" aria-hidden="true" className="size-3" />
                          ) : null}
                        </button>
                        {head.hint ? <InfoHint word={head.hint} className="size-5" /> : null}
                      </span>
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          {groups.map((group) => (
            <tbody key={group.group || 'all'} aria-label={group.group || undefined}>
              {prefs.grouped ? (
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={visible.length}
                    className="sticky left-0 h-[22px] bg-card px-4 pt-1 text-left align-bottom text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {group.group}
                    <span className="ml-2 font-normal tabular-nums">{group.rows.length}</span>
                  </th>
                </tr>
              ) : null}
              {group.rows.map(({ row }) => {
                const project = row.original
                return (
                  <tr
                    key={row.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(row.id, el)
                      else rowRefs.current.delete(row.id)
                    }}
                    tabIndex={row.id === current ? 0 : -1}
                    data-project={row.id}
                    aria-label={project.name}
                    className={cn(
                      'group/row cursor-pointer text-[length:var(--vx-text-sm)] outline-none',
                      ROW_HEIGHT[prefs.density],
                      'hover:bg-accent focus-visible:bg-accent data-[preview=true]:bg-accent',
                    )}
                    data-preview={preview === row.id}
                    onPointerEnter={() => {
                      prefetchProject(project.name)
                      previewLater(row.id)
                    }}
                    onFocus={() => {
                      setFocused(row.id)
                      clearTimer()
                      setPreview(row.id)
                    }}
                    onBlur={() => setPreview((p) => (p === row.id ? null : p))}
                    onKeyDown={(event) => onKeyDown(event, row.id)}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a, button')) return
                      open(project.name)
                    }}
                  >
                    {row.getVisibleCells().map((c) => {
                      const id = c.column.id as ColumnId
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            'px-2 shadow-[inset_0_-1px_0_var(--vx-grid)] last:pr-4',
                            id === 'name' &&
                              'sticky left-0 z-[1] bg-card pl-4 group-hover/row:bg-accent group-focus-visible/row:bg-accent group-data-[preview=true]/row:bg-accent',
                            HEADS[id].align === 'right' && 'text-right',
                          )}
                        >
                          {cell(id, project)}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
        {ordered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No project matches{search ? ` “${search}”` : ''}
            {quick === 'all' ? '' : ` in ${QUICK_WORDS[quick]}`}.
          </p>
        ) : null}
      </div>

      <DigestPreview
        project={previewed}
        anchor={preview ? (rowRefs.current.get(preview)?.firstElementChild ?? null) : null}
        now={now}
      />
    </div>
  )
}

function NameCell({ row }: { row: ProjectIndexRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Link
        to="/projects/$name"
        params={{ name: row.name }}
        tabIndex={-1}
        className="min-w-0 truncate font-medium outline-none hover:underline"
      >
        {row.name}
      </Link>
      {row.work ? (
        <span className="shrink-0 rounded-sm bg-muted px-1 text-[11px] text-muted-foreground">Work</span>
      ) : null}
    </span>
  )
}

function ColumnsMenu({ columns }: { columns: { id: ColumnId; label: string; shown: boolean; toggle: () => void }[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger className="hidden h-8 cursor-pointer sm:inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:text-foreground">
        <ColumnsIcon aria-hidden="true" className="size-3.5" />
        Columns
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="isolate z-50">
          <Popover.Popup
            className="w-52 rounded-lg bg-popover p-1.5 text-popover-foreground outline-none"
            style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          >
            <Popover.Title className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
              Show columns
            </Popover.Title>
            <ul className="grid">
              {columns.map((column) => (
                <li key={column.id}>
                  <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[length:var(--vx-text-sm)] hover:bg-accent">
                    <input
                      type="checkbox"
                      name={`column-${column.id}`}
                      checked={column.shown}
                      onChange={column.toggle}
                      className="size-3.5 accent-[var(--vx-accent)]"
                    />
                    {column.label}
                  </label>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      <ul className="mt-0.5 grid gap-0.5">
        {items.slice(0, 3).map((item) => (
          <li key={item} className="line-clamp-2">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The digest of the row under the pointer or the focus, beside its name: informational, it never takes the pointer. */
function DigestPreview({
  project,
  anchor,
  now,
}: {
  project: ProjectIndexRow | undefined
  anchor: Element | null
  now: number
}) {
  const digest = project?.digest ?? null
  return (
    <Popover.Root open={project !== undefined && anchor !== null}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={8}
          className="pointer-events-none isolate z-40"
        >
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            className="w-96 max-w-[calc(100vw-1rem)] rounded-lg bg-popover p-3 text-[length:var(--vx-text-sm)] text-popover-foreground outline-none"
            style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          >
            {project ? (
              <>
                <Popover.Title className="flex items-baseline gap-2 font-semibold tracking-tight">
                  {project.name}
                  <span className="text-xs font-normal text-muted-foreground">{project.group}</span>
                </Popover.Title>
                {digest ? (
                  <div className="mt-2 grid gap-2.5">
                    <p className="font-medium">{digest.headline}</p>
                    <Bullets title="Shipped" items={digest.shipped} />
                    <Bullets title="Next" items={digest.next} />
                    <Bullets title="Risks" items={digest.risks} />
                    <p className="text-xs text-muted-foreground">
                      Digest {ageWords(now - Date.parse(digest.at))}; Enter or a click opens the project
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    No digest yet: one is made every few hours for a project with Issues in the last 7 days.
                  </p>
                )}
              </>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
