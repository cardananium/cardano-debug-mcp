---
gist: tx_load handles (tx_id lifetime, restart), on-chain replay of a tx_hash load, decode_failed and nesting refusals.
---
# tx_load

- `tx_id` = `tx_<network>_<12 hex>`; rebuilt from the disk cache after a restart; on `expired_handle` call tx_load again.
- A tx fetched by `tx_hash` is on chain: its context is rebuilt at inclusion (slot, epoch parameters, own inputs unspent); `on_chain` says where, `defaults_applied` what stays current (validation-errors/defaults-applied).
- `bundle` also takes a cquisitor share link (`#transaction-validator?…`). A share link with context keeps it as the fetched context; a bundle or DebuggerContext keeps its own. ui_link embeds either in its link (a bundle's marked "assembled, not fetched"), so the app judges the state validated here. A context assembled by hand (chained or made-up transactions): debug-playbook/assemble-a-chain-context.
- A load by hash needs a provider. The public Koios API is rate limited: `rate_limited` (and `provider_error` on a busy Koios) come with `next`; the fix is an API key for Koios (`KOIOS_API_KEY`) or a Blockfrost project id (`BLOCKFROST_PROJECT_ID_<NETWORK>`, then `provider=blockfrost`), set in the server's environment (restart the server), or a bundle, which needs no provider.
- Bytes that are not one well-formed CBOR transaction answer `decode_failed` with the library's reason and `next` (`cbor_validate(hex, rule='transaction')` shows where they diverge); nesting past 64 levels (native scripts exempt) answers `unexamined`.
