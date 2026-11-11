import {
  ArrowsClockwiseIcon,
  FilesIcon,
  FolderIcon,
  HashIcon,
  type Icon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
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
import { type ArtifactEntry, type CommandEntry, type IssueEntry, type ProjectEntry, searchPalette } from '@/lib/palette'
import { useFlow, useIssueCards, usePaletteArtifacts } from '@/lib/queries'
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
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{kind}</span>
    </CommandItem>
  )
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
  const flow = useFlow().data

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
      commands,
    }),
    [cards.data, flow, artifacts.data, commands],
  )
  const result = useMemo(() => searchPalette(query, source), [query, source])
  const actions = new Map(commands.map((command) => [command.id, command]))

  const first =
    (result.issues[0] && `issue-${result.issues[0].number}`) ||
    (result.projects[0] && `project-${result.projects[0].name}`) ||
    (result.artifacts[0] && `artifact-${result.artifacts[0].id}`) ||
    (result.commands[0] && `command-${result.commands[0].id}`) ||
    ''
  // The best match is always the one Enter takes: the selection follows the results, not cmdk's own order.
  useEffect(() => setSelected(first), [first, query])

  const go = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  const reset = (next: boolean) => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={reset}
      title="Command palette"
      description="Find an Issue, a project, an artifact or a command"
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} value={selected} onValueChange={setSelected} loop>
        <CommandInput
          placeholder="Search Issues, projects, artifacts and commands"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-96 min-h-52">
          <CommandEmpty>Nothing matches.</CommandEmpty>
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
                  onSelect={go(() => void navigate({ to: '/issues/$id', params: { id: String(issue.number) } }))}
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
                  onSelect={go(() => void navigate({ to: '/flow', search: { project: project.name } }))}
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
                  onSelect={go(() => void navigate({ to: '/artifacts/$id', params: { id: artifact.id } }))}
                />
              ))}
            </CommandGroup>
          ) : null}
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
