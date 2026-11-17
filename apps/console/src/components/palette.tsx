import {
  ArrowsClockwiseIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  FilesIcon,
  FoldersIcon,
  FolderIcon,
  HashIcon,
  type Icon,
  MonitorIcon,
  MoonIcon,
  PushPinIcon,
  SunIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { KIND_ICON, type IssueKind } from '@/components/kit/kind-badge'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { projectsOf } from '@/lib/flow'
import { highlightRuns } from '@/lib/highlight'
import { NAV } from '@/lib/nav'
import { pinCollection } from '@/lib/api'
import {
  type ArtifactEntry,
  type CollectionEntry,
  type CommandEntry,
  contextActions,
  type IssueEntry,
  type ProjectEntry,
  searchPalette,
  type ViewFacts,
  viewOf,
} from '@/lib/palette'
import { collectionListQuery, useFlow, useIssueCards, useNeeds, usePaletteArtifacts } from '@/lib/queries'
import { readRecent, recordVisit, type RecentType } from '@/lib/recent'
import { setThemePreference, type ThemePreference } from '@/lib/theme'

const THEMES: ReadonlyArray<{ preference: ThemePreference; label: string; icon: Icon }> = [
  { preference: 'light', label: 'Switch theme: light', icon: SunIcon },
  { preference: 'dark', label: 'Switch theme: dark', icon: MoonIcon },
  { preference: 'system', label: 'Switch theme: system', icon: MonitorIcon },
]

interface CommandAction extends CommandEntry {
  icon: Icon
  /** the keys of a `g x` chord */
  chord?: [string, string]
  run: () => void
}

/** The title with the query's words marked. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightRuns(text, query).map((run, i) =>
        run.match ? (
          <mark
            key={i}
            className="rounded-xs bg-[color-mix(in_srgb,var(--vx-accent)_22%,transparent)] font-semibold text-inherit"
          >
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  )
}

function Row({
  value,
  icon: RowIcon,
  title,
  query,
  reference,
  kind,
  onSelect,
}: {
  value: string
  icon: Icon
  title: string
  query: string
  reference?: ReactNode
  kind: string
  onSelect: () => void
}) {
  return (
    <CommandItem value={value} onSelect={onSelect} className="gap-3">
      <RowIcon className="text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <Marked text={title} query={query} />
      </span>
      <span className="max-w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">{reference}</span>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{kind}</span>
    </CommandItem>
  )
}

const KIND_WORD: Record<RecentType, string> = {
  issue: 'Issue',
  artifact: 'Artifact',
  collection: 'Collection',
  project: 'Project',
}

const Chord = ({ keys }: { keys: [string, string] }) => (
  <span className="inline-flex gap-1">
    {keys.map((key) => (
      <kbd key={key} className="min-w-5 rounded-sm bg-muted px-1 text-center font-mono text-xs text-foreground">
        {key}
      </kbd>
    ))}
  </span>
)

const Hint = ({ keys, label }: { keys: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <kbd className="rounded-sm bg-muted px-1.5 font-mono text-foreground">{keys}</kbd>
    {label}
  </span>
)

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  // The lists are watched only while the palette is open: the page's idle prefetch (`prefetchPalette`) filled the cache, an
  // opening shows it at once and refreshes it, and the stream never refetches 550 KB behind a closed palette.
  const cards = useIssueCards(open)
  const artifacts = usePaletteArtifacts(open)
  const collections = useQuery({ ...collectionListQuery, enabled: open })
  const flow = useFlow().data
  const needs = useNeeds().data
  const location = useRouterState({ select: (s) => s.location })
  const [recent, setRecent] = useState(readRecent)
  // Read again at every opening: the visits since the last one are in storage.
  useEffect(() => {
    if (open) setRecent(readRecent())
  }, [open])

  const commands = useMemo<CommandAction[]>(
    () => [
      ...NAV.map(({ to, label, icon, key }) => ({
        id: `go-${to}`,
        title: `Go to ${label}`,
        keywords: '',
        icon,
        chord: ['G', key] as [string, string],
        run: () => void navigate({ to }),
      })),
      ...THEMES.map(({ preference, label, icon }) => ({
        id: `theme-${preference}`,
        title: label,
        keywords: 'appearance',
        icon,
        run: () => setThemePreference(preference),
      })),
      {
        id: 'reload',
        title: 'Reload data',
        keywords: 'refresh',
        icon: ArrowsClockwiseIcon,
        run: () => void queryClient.invalidateQueries(),
      },
    ],
    [navigate, queryClient],
  )

  const view = viewOf(location.pathname, location.search)
  const viewFacts = useMemo(() => {
    const facts = { origin: window.location.origin } as ViewFacts
    if (view?.type === 'issue') {
      facts.repo = cards.data?.issues.find((card) => String(card.id) === view.id)?.repoName ?? null
      facts.needItem = needs?.items.find((item) => item.issue === `issue_${view.id}`)?.id ?? null
    }
    if (view?.type === 'collection') {
      const found = collections.data?.collections.find((collection) => collection.id === view.id)
      facts.pinned = found ? found.pinnedAt !== null : null
    }
    return facts
  }, [view?.type, view?.type === 'project' ? view.name : view?.id, cards.data, needs, collections.data])
  const context = useMemo(
    () => contextActions(view, viewFacts),
    [view?.type, view?.type === 'project' ? view.name : view?.id, viewFacts],
  )

  const copy = (text: string) => () => {
    navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('Copy failed', error))
  }
  const contextRun = (id: string, entry: { copy?: string | undefined }): (() => void) => {
    if (entry.copy !== undefined) return copy(entry.copy)
    if (id === 'context-pin' && view?.type === 'collection') {
      const pinned = viewFacts.pinned === true
      return () =>
        void pinCollection(view.id, !pinned)
          .then(() => queryClient.invalidateQueries({ queryKey: ['artifact-collections'] }))
          .catch((error: unknown) => console.warn('Pin failed', error))
    }
    if (id === 'context-answer' && viewFacts.needItem) {
      const item = viewFacts.needItem
      return () => void navigate({ to: '/needs-you', search: { item } })
    }
    if (id === 'context-chain') {
      const project = view?.type === 'project' ? view.name : viewFacts.repo
      if (project) return () => void navigate({ to: '/chain', search: { project } })
    }
    if (id === 'context-overview' && view?.type === 'project') {
      const project = view.name
      return () => void navigate({ to: '/', search: { project } })
    }
    return () => undefined
  }

  const source = useMemo(
    () => ({
      issues: (cards.data?.issues ?? []).map((card): IssueEntry => ({
        number: card.id,
        title: card.title,
        repo: card.repoName,
        kind: card.kind,
        state: card.state,
        updatedAt: card.updatedAt,
      })),
      projects: (flow ? projectsOf(flow) : []).map((name): ProjectEntry => ({
        name,
        open: flow?.perProject.find((project) => project.repo === name)?.open ?? 0,
      })),
      artifacts: (artifacts.data?.artifacts ?? []).map((artifact): ArtifactEntry => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
      })),
      collections: (collections.data?.collections ?? []).map((collection): CollectionEntry => ({
        id: collection.id,
        title: collection.title,
        repo: collection.repo,
      })),
      commands,
      context,
    }),
    [cards.data, flow, artifacts.data, collections.data, commands, context],
  )
  const result = useMemo(() => searchPalette(query, source, recent), [query, source, recent])
  const actions = new Map(commands.map((command) => [command.id, command]))

  // On an empty query the actions on this page lead; on a typed one the things that match do, and the actions follow them
  const typed = query.trim() !== ''
  const first =
    (result.openNumber !== null && `open-${result.openNumber}`) ||
    (result.recent[0] && `recent-${result.recent[0].type}-${result.recent[0].id}`) ||
    (!typed && result.context[0] && `context-${result.context[0].id}`) ||
    (result.issues[0] && `issue-${result.issues[0].number}`) ||
    (result.projects[0] && `project-${result.projects[0].name}`) ||
    (result.artifacts[0] && `artifact-${result.artifacts[0].id}`) ||
    (result.collections[0] && `collection-${result.collections[0].id}`) ||
    (result.context[0] && `context-${result.context[0].id}`) ||
    (result.commands[0] && `command-${result.commands[0].id}`) ||
    ''
  // The best match is always the one Enter takes: the selection follows the results, not cmdk's own order.
  useEffect(() => setSelected(first), [first, query])

  const go = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  const visit = (type: RecentType, id: string, action: () => void) =>
    go(() => {
      recordVisit({ type, id, at: Date.now() })
      action()
    })
  const openThing = (type: RecentType, id: string) => {
    if (type === 'issue') return void navigate({ to: '/issues/$id', params: { id } })
    if (type === 'artifact') return void navigate({ to: '/artifacts/$id', params: { id } })
    if (type === 'collection') return void navigate({ to: '/artifacts/collections/$id', params: { id } })
    return void navigate({ to: '/projects/$name', params: { name: id } })
  }
  const reset = (next: boolean) => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  const thisPage =
    result.context.length > 0 ? (
      <CommandGroup heading="This page">
        {result.context.map((entry) => (
          <Row
            key={entry.id}
            value={`context-${entry.id}`}
            icon={entry.id === 'context-pin' ? PushPinIcon : CopyIcon}
            title={entry.title}
            query={query}
            kind="Action"
            onSelect={go(contextRun(entry.id, entry))}
          />
        ))}
      </CommandGroup>
    ) : null

  return (
    <CommandDialog
      open={open}
      onOpenChange={reset}
      title="Command palette"
      description="Find an Issue, a project, an artifact, a collection or a command"
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} value={selected} onValueChange={setSelected} loop>
        <CommandInput
          placeholder="Search Issues, projects, artifacts, collections and commands"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-96 min-h-52">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {result.openNumber !== null ? (
            <CommandGroup heading="Issue">
              <Row
                value={`open-${result.openNumber}`}
                icon={HashIcon}
                title={`Open Issue #${result.openNumber}`}
                query=""
                kind="Issue"
                onSelect={visit('issue', String(result.openNumber), () =>
                  openThing('issue', String(result.openNumber)),
                )}
              />
            </CommandGroup>
          ) : null}
          {result.recent.length > 0 ? (
            <CommandGroup heading="Recent">
              {result.recent.map((entry) => (
                <Row
                  key={`${entry.type}-${entry.id}`}
                  value={`recent-${entry.type}-${entry.id}`}
                  icon={ClockCounterClockwiseIcon}
                  title={entry.title}
                  query={query}
                  reference={entry.reference}
                  kind={KIND_WORD[entry.type]}
                  onSelect={visit(entry.type, entry.id, () => openThing(entry.type, entry.id))}
                />
              ))}
            </CommandGroup>
          ) : null}
          {typed ? null : thisPage}
          {result.issues.length > 0 ? (
            <CommandGroup heading={query.trim() === '' ? 'Recently active' : 'Issues'}>
              {result.issues.map((issue) => (
                <Row
                  key={issue.number}
                  value={`issue-${issue.number}`}
                  icon={KIND_ICON[issue.kind as IssueKind] ?? HashIcon}
                  title={issue.title}
                  query={query}
                  reference={<Marked text={`#${issue.number}`} query={query} />}
                  kind="Issue"
                  onSelect={visit('issue', String(issue.number), () => openThing('issue', String(issue.number)))}
                />
              ))}
              {result.moreIssues > 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {result.moreIssues} more {result.moreIssues === 1 ? 'Issue matches' : 'Issues match'}; type more to
                  narrow
                </p>
              ) : null}
            </CommandGroup>
          ) : null}
          {result.projects.length > 0 ? (
            <CommandGroup heading="Projects">
              {result.projects.map((project) => (
                <Row
                  key={project.name}
                  value={`project-${project.name}`}
                  icon={FolderIcon}
                  title={project.name}
                  query={query}
                  reference={`${project.open} open`}
                  kind="Project"
                  onSelect={visit('project', project.name, () => openThing('project', project.name))}
                />
              ))}
            </CommandGroup>
          ) : null}
          {result.artifacts.length > 0 ? (
            <CommandGroup heading="Artifacts">
              {result.artifacts.map((artifact) => (
                <Row
                  key={artifact.id}
                  value={`artifact-${artifact.id}`}
                  icon={FilesIcon}
                  title={artifact.title}
                  query={query}
                  reference={artifact.id}
                  kind="Artifact"
                  onSelect={visit('artifact', artifact.id, () => openThing('artifact', artifact.id))}
                />
              ))}
            </CommandGroup>
          ) : null}
          {result.collections.length > 0 ? (
            <CommandGroup heading="Collections">
              {result.collections.map((collection) => (
                <Row
                  key={collection.id}
                  value={`collection-${collection.id}`}
                  icon={FoldersIcon}
                  title={collection.title}
                  query={query}
                  reference={collection.repo}
                  kind="Collection"
                  onSelect={visit('collection', collection.id, () => openThing('collection', collection.id))}
                />
              ))}
            </CommandGroup>
          ) : null}
          {typed ? thisPage : null}
          {result.commands.length > 0 ? (
            <CommandGroup heading="Commands">
              {result.commands.map((entry) => {
                const action = actions.get(entry.id)
                if (!action) return null
                return (
                  <Row
                    key={entry.id}
                    value={`command-${entry.id}`}
                    icon={action.icon}
                    title={entry.title}
                    query={query}
                    reference={action.chord ? <Chord keys={action.chord} /> : undefined}
                    kind="Command"
                    onSelect={go(action.run)}
                  />
                )
              })}
            </CommandGroup>
          ) : null}
        </CommandList>
        <div className="hidden items-center gap-4 px-3 py-2 text-xs text-muted-foreground md:flex">
          <Hint keys="↑↓" label="move" />
          <Hint keys="↵" label="open" />
          <Hint keys="esc" label="close" />
        </div>
      </Command>
    </CommandDialog>
  )
}
