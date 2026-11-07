# The alert door's one secret, resolved at start by scripts/launch-door.sh through secrets-run, never through op. The door
# holds no database credential and none of the other tokens: this file is why it has its own template (.env.tpl is the server's).
# The server accepts this token on exactly POST /signals/alerts and POST /door/reports.
FACTORY_DOOR_TOKEN=op://mini/software-factory/FACTORY_DOOR_TOKEN
