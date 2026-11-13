# Read only by scripts/launch.sh and deploy.sh's check_refs; clients (the CLI, verify, import, the gameday drill) never read it.
# Refs only the server needs. Every ref here is optional: one that does not resolve is said once and the server starts without it.
# Hermes' filing bearer: POST /signals only, as owner:hermes. Must differ from every other token.
FACTORY_SIGNAL_TOKEN=op://mini/software-factory/FACTORY_SIGNAL_TOKEN
# The owner's delegate agent (the orchestrator): the owner's rights bar four judgment routes, its own actor in the log. Must differ from every other token.
FACTORY_ORCHESTRATOR_TOKEN=op://mini/software-factory/FACTORY_ORCHESTRATOR_TOKEN
# The uptime count in the overview (Argo's Kuma snapshot), off without FACTORY_UPTIME_URL; FACTORY_UPTIME_URL is a non-secret setting in ~/.config/factory/env.
FACTORY_UPTIME_TOKEN=op://common/api/SECRET
