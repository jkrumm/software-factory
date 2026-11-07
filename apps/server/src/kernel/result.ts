/** Why a port could not do its work. Every port answers with this; only a programming error throws. */
export interface PortError {
  kind: 'timeout' | 'gone' | 'refused' | 'unreadable'
  detail: string
}

export type Result<T, E = PortError> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const portError = (kind: PortError['kind'], detail: string): PortError => ({ kind, detail })
