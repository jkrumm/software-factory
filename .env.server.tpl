# Read only by scripts/launch.sh and deploy.sh's check_refs; clients (the CLI, verify, import, the gameday drill) never read it.
# Refs only the server needs. Every ref here is optional: one that does not resolve is said once and the server starts without it.
# Hermes' filing bearer: POST /signals only, as owner:hermes. Must differ from every other token.
FACTORY_SIGNAL_TOKEN=op://mini/software-factory/FACTORY_SIGNAL_TOKEN
