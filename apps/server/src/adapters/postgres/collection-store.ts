import type { CollectionStore } from '../../domains/checkpoints/ports.ts'
import type { SQL } from 'bun'
import * as z from 'zod'
import type { Key } from '../../kernel/keys.ts'
import type { ArtifactId, CollectionId } from '../../domains/checkpoints/artifact.ts'
import type { CollectionRecord, CollectionStats } from '../../domains/checkpoints/ports.ts'

const CollectionRow = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  repo: z.string(),
  lead_artifact_id: z.string().nullable(),
  pinned_at: z.date().nullable(),
  created_at: z.date(),
})

const collectionOf = (raw: unknown): CollectionRecord => {
  const row = CollectionRow.parse(raw)
  return {
    id: row.id as CollectionId,
    key: row.key as Key,
    title: row.title,
    repo: row.repo,
    leadArtifactId: row.lead_artifact_id as ArtifactId | null,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
  }
}

export function postgresCollectionStore(tx: SQL): CollectionStore {
  return {
    async insertCollection(c) {
      const rows: unknown[] = await tx`
        INSERT INTO factory.artifact_collections (id, key, title, repo, lead_artifact_id, pinned_at, created_at)
        VALUES (${c.id}, ${c.key}, ${c.title}, ${c.repo}, ${c.leadArtifactId}, ${c.pinnedAt}, ${c.createdAt})
        ON CONFLICT DO NOTHING
        RETURNING id`
      return rows.length === 1
    },

    async collection(id) {
      const [row] = await tx`SELECT * FROM factory.artifact_collections WHERE id = ${id}`
      return row ? collectionOf(row) : null
    },

    async collectionByKey(key) {
      const [row] = await tx`SELECT * FROM factory.artifact_collections WHERE key = ${key}`
      return row ? collectionOf(row) : null
    },

    async collections() {
      const rows: unknown[] = await tx`
        SELECT * FROM factory.artifact_collections ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC`
      return rows.map(collectionOf)
    },

    async updateCollection(id, change) {
      await tx`
        UPDATE factory.artifact_collections SET
          title = COALESCE(${change.title ?? null}, title),
          lead_artifact_id = CASE WHEN ${change.leadArtifactId !== undefined} THEN ${change.leadArtifactId ?? null} ELSE lead_artifact_id END
        WHERE id = ${id}`
    },

    async setCollectionPin(id, at) {
      const rows: unknown[] = await tx`
        UPDATE factory.artifact_collections SET pinned_at = ${at}
        WHERE id = ${id} AND (pinned_at IS NULL) <> (${at}::timestamptz IS NULL)
        RETURNING id`
      return rows.length === 1
    },

    async setArtifactCollection(artifact, collection, from) {
      const rows: unknown[] = await tx`
        UPDATE factory.artifacts SET collection_id = ${collection}
        WHERE id = ${artifact} AND collection_id IS NOT DISTINCT FROM ${from}
        RETURNING id`
      return rows.length === 1
    },

    async collectionStats(ids) {
      const stats = new Map<CollectionId, CollectionStats>(
        ids.map((id) => [id, { members: [], lastChange: null, openComments: 0 }]),
      )
      if (ids.length === 0) return stats
      const rows: { collection_id: string; artifact_id: string; last_at: Date; open_comments: number }[] = await tx`
        SELECT a.collection_id, a.id AS artifact_id,
          GREATEST(a.created_at,
            COALESCE((SELECT max(r.created_at) FROM factory.artifact_revisions r WHERE r.artifact_id = a.id), a.created_at),
            COALESCE((SELECT max(n.at) FROM factory.annotations n WHERE n.artifact_id = a.id), a.created_at),
            COALESCE((SELECT max(v.at) FROM factory.verdicts v WHERE v.artifact_id = a.id), a.created_at)) AS last_at,
          (SELECT count(*)::int FROM factory.annotations n
            WHERE n.artifact_id = a.id AND n.author = 'owner' AND n.disposition IS NULL) AS open_comments
        FROM factory.artifacts a
        WHERE a.collection_id IN ${tx([...ids] as string[])} AND a.retired_at IS NULL
        ORDER BY a.created_at, a.id`
      for (const row of rows) {
        const entry = stats.get(row.collection_id as CollectionId)
        if (!entry) continue
        entry.members.push(row.artifact_id as ArtifactId)
        entry.openComments += row.open_comments
        if (!entry.lastChange || row.last_at > entry.lastChange) entry.lastChange = row.last_at
      }
      return stats
    },
  }
}
