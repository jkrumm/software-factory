import * as z from 'zod'
import { ProjectFile } from '../domains/planning/project.ts'

/**
 * The `project.yaml` schema as JSON Schema, with every key's `.describe()`: what the setup read (`read/project-setup.ts`)
 * and the Console's Setup tab show as each key's meaning. `read/` takes it as data, as it may import no domain code.
 * Made once.
 */
export const PROJECT_SCHEMA: unknown = z.toJSONSchema(ProjectFile, { io: 'input', unrepresentable: 'any' })
