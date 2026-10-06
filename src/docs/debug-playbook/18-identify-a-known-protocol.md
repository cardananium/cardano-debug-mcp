---
gist: a script or datum that is not the user's own (a DEX order, a pool, a loan, an oracle): what is still done here, and where cquisitor's protocol decoders may help.
---
# A script that belongs to a known protocol

When the user wants to understand a script or a transaction that is not theirs (a swap order, a pool, a lending position, an oracle feed, a marketplace listing) the work here does not change: `script_decompile` first (pseudocode is the primary source), then tx_inspect / tx_redeemer for datums and redeemers, `debug_run` for a value. Only when that leaves the question "which protocol is this and what does this datum field mean?" open, look at cquisitor's decoders.

Signs of a known dApp:
- spend redeemers that are dummies while a Reward (withdraw-zero) redeemer carries the real action: the logic sits in a staking validator;
- datums shaped like an order (canceller, refund / success receiver, minimum receive, batcher fee) or a pool (two assets, a validity NFT);
- an input that holds one NFT of a fixed policy next to the datum.

Where: https://github.com/cardananium/cquisitor, folder `utils/protocols/<protocol>/` under its `src`:
- `constants.ts`: the known script hashes and NFT policies. Search the hash from `script_hash` / `script_locate` in it;
- `index.ts`: the adapter: which hash is an order, a pool or a batcher, what each row of the datum means, how the redeemer is classified (Apply, Cancel) and where the action lives (spend or withdraw-zero);
- the datum parsers (`v2.ts`, `datums.ts`, ...): field-by-field constructor layouts with names.

Covered: DEXes (Minswap, WingRiders, Splash, MuesliSwap, Genius Yield, Danogo, VyFinance, SaturnSwap, CSwap, Chakra, ChadSwap, SnekFun, SundaeSwap), lending (Liqwid, Lenfi, FluidTokens, Levvy), CDP and synthetics (Indigo, Butane, Djed), Optim, Strike, oracles (Charli3, Orcfax), JPG Store, Midnight.

Use it as a hint, not as a verdict:
- the registry is mostly mainnet and not exhaustive: no match proves nothing; a match names a protocol and version, but the decompiled script is what the chain runs;
- name the file you relied on; without web access say the identification is unverified;
- the cquisitor transaction view (`ui_link`, app='cquisitor', tx_id) already labels such inputs and outputs and shows their decoded datums: offer it to a user who wants to see the order (section='show-it-in-a-ui').

Data a CIP defines (token datums, metadata labels, ids, anchors) is in docs(topic='cips').
