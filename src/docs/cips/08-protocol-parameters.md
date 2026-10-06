---
gist: Protocol parameter names, era and meaning from CIP-0009 (Shelley), CIP-0028 (Alonzo), CIP-0055 (Babbage), plus legacy names.
---
# Protocol parameters by era

Genesis-file names; CIP-0028 warns `cardano-cli query protocol-parameters` shows some differently. Values are initial, not current. Limits and ids: tx-anatomy/limits, tx-anatomy/fees-min-utxo.

| Name | Era | Meaning |
|---|---|---|
| `minFeeA`, `minFeeB` | Shelley | lovelace per tx byte, base fee (44, 155381) |
| `maxTxSize` | Shelley | max tx size (16384); below block body size |
| `keyDeposit`, `poolDeposit` | Shelley | lovelace (2000000, 500000000) |
| `minUTxOValue` | Shelley | min lovelace per UTxO (1000000); LEGACY |
| `decentralisationParam` (`d`), `extraEntropy` | Shelley | TPraos only (d=1 all federated); REMOVED in Babbage |
| `maxBlockBodySize`, `maxBlockHeaderSize` | Shelley | max sizes: 65536 body, 1100 header |
| `nOpt`, `a0`, `minPoolCost`, `eMax`, `tau`, `rho` | Shelley | target pools (k), pledge influence, min pool cost per epoch, retirement horizon in epochs, treasury rate, expansion per epoch |
| `protocolVersion` | Shelley | `{major,minor}`; major 2 Shelley, 3 Allegra, 4 Mary; a major change is a hard fork |
| `lovelacePerUTxOWord` | Alonzo | 34482 per 8-byte word; replaced `minUTxOValue` |
| `executionPrices` | Alonzo | `prSteps` 721/10000000, `prMem` 577/10000: lovelace per step, per memory unit |
| `maxTxExUnits`, `maxBlockExUnits` | Alonzo | `exUnitsMem`, `exUnitsSteps`: 10M/10G per tx, 50M/40G per block |
| `maxValueSize` | Alonzo | 5000; serialized Value per output |
| `collateralPercentage`, `maxCollateralInputs` | Alonzo | 150 (percent of fee), 3 |
| `costModels` | Alonzo | `{PlutusV1:{builtin cost: n}}`, per language; changed with new versions |
| `coinsPerUTxOByte` | Babbage | renamed from `coinsPerUTxOWord` (genesis `lovelacePerUTxOWord`); start value floor(old/8); min = (160 + serialized output bytes) * it |

- Allegra and Mary added or removed none. Updatable parameters change without a hard fork (not `protocolVersion`).
- Non-updatable (Shelley): `activeSlotsCoeff` 0.05, `epochLength` 432000, `slotLength` 1 s, `securityParam` 2160, `slotsPerKESPeriod` 129600, `maxKESEvolutions` 62, `maxLovelaceSupply` 45e15, `updateQuorum` 5.
