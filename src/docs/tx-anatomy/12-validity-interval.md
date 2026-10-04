---
gist: validity interval in slots vs POSIX ms in scripts, timelock semantics, slot-to-time constants per network.
---
# Validity interval and slot/time conversion

Body uses slots, scripts POSIX ms. `TxInfo.validRange=[key 8,key 3)`; absent bounds infinite. `OutsideValidityIntervalUTxO`: slot < start or ≥ ttl. Native timelocks judge the interval, not the slot: `invalid_before s` iff key 8 ≥ s, `invalid_hereafter s` iff key 3 ≤ s; absent bound fails.

`posix_ms=zero_time+(slot-zero_slot)*1000` (1 s/slot since Shelley):

| Network | zero_slot | zero_time (ms) | UTC |
|---|---|---|---|
| mainnet | 4,492,800 | 1,596,059,091,000 | 2020-07-29 21:44:51 |
| preprod | 86,400 | 1,655,769,600,000 | 2022-06-21 00:00:00 |
| preview | 0 | 1,666,656,000,000 | 2022-10-25 00:00:00 |

Below `zero_slot`: `SlotTooFarInThePast`. Datum deadlines are POSIX ms; wrong network shifts bounds by years.
