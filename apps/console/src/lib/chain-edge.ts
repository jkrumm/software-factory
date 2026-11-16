import { getSmoothStepPath, Position } from '@xyflow/react'

/** Where an edge turns, as a share of the gap between the two nodes: the long straight run after it is where the label sits. */
export const TURN = { blocked: 0.3, done: 0.18 }

/** Under this (px) the two ends are level: handle positions are measured, so a level pair can differ by a rounding. */
const LEVEL = 0.5

/**
 * The line of an edge that runs left to right: one horizontal segment when both ends are level, else a smooth step that turns
 * early (`TURN`) so the long run after the turn carries the label.
 */
export function edgePath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  blocked,
}: {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  blocked: boolean
}): string {
  if (Math.abs(sourceY - targetY) < LEVEL) return `M ${sourceX},${targetY} L ${targetX},${targetY}`
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    stepPosition: blocked ? TURN.blocked : TURN.done,
  })
  return path
}
