---
gist: CIP-1694 bodies, action kinds, who ratifies each, anchor metadata (CIP-0100, 0108, 0119, 0136, 0120, 0149).
---
# Governance CIPs and anchors

Three bodies. CC: members with terms, one vote each, judge constitutionality; under `committeeMinSize` non-expired members it cannot ratify. DReps: weight = delegated stake; inactive after `dRepActivity` epochs without a vote; presets Abstain (not counted) and No Confidence (Yes on no-confidence, No elsewhere). Wire layouts: tx-anatomy/governance.

| Action | CC | DReps | SPOs |
|---|---|---|---|
| No-confidence, update committee | - | yes | yes |
| New constitution / guardrails script, treasury withdrawal | yes | yes | - |
| Hard fork | yes | yes | yes |
| Parameter change | yes | yes | security params only |
| Info | yes | yes | yes (100%: never ratified) |

Votes: Yes/No/Abstain; Abstain leaves the denominator, a registered non-voter counts as No; revoting overrides until ratified. Ratified at an epoch boundary, enacted at the next; expires after `govActionLifetime` epochs; `govActionDeposit` refunded either way. Non-treasury, non-info actions carry the last enacted id of their kind. Bootstrap (Chang #1 to Plomin): CC alone changes parameters, CC + SPOs a hard fork.

Anchors:
- CIP-0100: JSON-LD `@context`, `hashAlgorithm` (blake2b-256), `authors` [`witness` {`witnessAlgorithm` ed25519, `publicKey`, `signature`}], `body` {`references` [`@type` GovernanceMetadata or Other, `label`, `uri`], `comment`, `externalUpdates` [`title`, `uri`]}. Anchor hash = blake2b-256 of the raw fetched bytes, not parsed JSON; a signature covers only the RDF-canonical `body`.
- CIP-0108 (Proposed): `body` adds required `title`, `abstract`, `motivation`, `rationale`; witness may be `CIP-0008`.
- CIP-0119 (Proposed) DRep: required `givenName`; optional `paymentAddress`, `image`, `objectives`, `motivations`, `qualifications`, `doNotList`; `authors` ignored.
- CIP-0136 (Proposed) CC vote: required `summary`, `rationaleStatement`; optional `internalVote` and discussion fields.
- CIP-0120 (Proposed): constitution = UTF-8 text, lines up to 80 chars, hash = blake2b-256 of raw text.
- CIP-0149 (Proposed): label 3692 `donationBasisPoints`; CIP text: 1 = 0.1%.
- CIP-0129 (Proposed): ids: cips/addresses-and-identifiers.
