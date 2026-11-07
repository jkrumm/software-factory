# Resolved at start by scripts/launch.sh through secrets-run, never through op. One whole-value ref per line.
# secrets-run resolves whole values only, so launch.sh builds DATABASE_URL from the password: the `factory` role owns
# the schema `factory` in the shared database (vps: make db-shared).
FACTORY_DB_PASSWORD=op://mini/vps-dev/SHARED_FACTORY_DB_PASSWORD
FACTORY_TOKEN=op://mini/software-factory/FACTORY_TOKEN
# The surfaces' bearer (the Hermes agent): GET /v1/* only, IuRoot's text left out. Must differ from FACTORY_TOKEN.
FACTORY_READ_TOKEN=op://mini/software-factory/FACTORY_READ_TOKEN
FACTORY_GITHUB_TOKEN=op://mini/github/token
NTFY_TOKEN=op://common/ntfy/TOKEN
