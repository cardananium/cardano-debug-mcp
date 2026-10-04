# Bundled era CDDL schemas

The `.cddl` files in this directory are verbatim copies (generated-file headers
included, so a diff against upstream stays meaningful) of the ledger's era
schemas from IntersectMBO/cardano-ledger:

| File | Upstream path |
|---|---|
| `shelley.cddl`  | `eras/shelley/impl/cddl/data/shelley.cddl` |
| `allegra.cddl`  | `eras/allegra/impl/cddl/data/allegra.cddl` |
| `mary.cddl`     | `eras/mary/impl/cddl/data/mary.cddl` |
| `alonzo.cddl`   | `eras/alonzo/impl/cddl/data/alonzo.cddl` |
| `babbage.cddl`  | `eras/babbage/impl/cddl/data/babbage.cddl` |
| `conway.cddl`   | `eras/conway/impl/cddl/data/conway.cddl` |
| `dijkstra.cddl` | `eras/dijkstra/impl/cddl/data/dijkstra.cddl` |

Ledger revision: commit `fb4164955c9dd1c4af03611af2cc73de92e2f00d` (2026-04-18).

Copyright 2018-2023 Input Output Global Inc (IOG). Licensed under the Apache
License, Version 2.0 <http://www.apache.org/licenses/LICENSE-2.0>.

Every file parses and resolves with cquisitor-lib's `validate_cddl` at the
library version this package was built against (the e2e tests re-check that
through `cddl_check(cddl='<era>')`). Byron is not bundled: its schema is a
different format and none of the tools here target it.

The files are served as the `cardano-debug://cddl/{era}` resources and are the
`cddl` presets of `cbor_validate` and `cddl_check` (`conway` is the default).
