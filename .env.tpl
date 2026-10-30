# Resolved at start by scripts/launch.sh through secrets-run, never through op. One whole-value ref per line.
# secrets-run resolves whole values only, so launch.sh builds DATABASE_URL from the password: the `factory` role owns
# the schema `factory` in the shared database (vps: make db-shared).
FACTORY_DB_PASSWORD=op://mini/vps-dev/SHARED_FACTORY_DB_PASSWORD
FACTORY_TOKEN=op://mini/software-factory/FACTORY_TOKEN
