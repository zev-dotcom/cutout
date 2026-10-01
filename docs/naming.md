# Naming: Smith, formerly Cutout

The project is called **Smith**. It was previously called Project Cutout.

The code has not been renamed yet. These identifiers intentionally keep the
old name so that existing setups, clients and scripts keep working:

| Identifier | Where |
|---|---|
| `CUTOUT_TOKEN`, `CUTOUT_URL`, `CUTOUT_AGENT_ID`, `CUTOUT_HOST`, `CUTOUT_PORT`, `CUTOUT_DB`, `CUTOUT_RETENTION_DAYS`, `CUTOUT_RATE_LIMIT` | environment variables read by the server, clients and edge function |
| `server/cutout_server.py` | reference server module and file name |
| `clients/python/cutout.py`, `CutoutError` | Python client module and exception |
| `clients/node/cutout.js`, `CutoutClient`, `CutoutError`, package `cutout-client` | Node client |
| `cutout.db` | default SQLite file name |
| `cutout` schema, tables and `cutout.purge()` | Supabase SQL (`supabase/schema*.sql`) |
| `cutout` function slug | Supabase edge function path (`/functions/v1/cutout/...`) |
| "the Cutout contributors" | `LICENSE` copyright line |

Renaming these would break anyone who already sets the old environment
variables, imports the old module names, or points at an existing database or
function path. A rename is planned for later. When it happens, the plan is to
accept both the old and new names for a transition period rather than switch
over at once.

Documentation and the repository name use Smith. The repository was renamed
from `zev-dotcom/cutout` to `zev-dotcom/smith`; GitHub redirects the old URL.
