import { projectJsonSchema } from '@software-factory/contract/project'

/**
 * The `project.yaml` schema as JSON Schema, every key with its description (`packages/contract/src/project-file.ts`, the
 * same document as `schema/project.schema.json`): what the setup read (`read/project-setup.ts`) and the Console's Setup tab
 * show as each key's meaning. `read/` takes it as data, as it may import no domain code. Made once.
 */
export const PROJECT_SCHEMA: unknown = projectJsonSchema()
