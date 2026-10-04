---
gist: constructor indices of DCert (V1/V2), TxCert (V3), delegatees, DReps, voters, votes, proposals; the V3 deposit Nothing quirk.
---
# PlutusData encoding of certificates and governance

Constructor indices in `Constr i [...]` (encoding rules: plutusdata-core-types).

| Type | Encoding |
|---|---|
| DCert (V1/V2) | 0 `DelegRegKey [SC]`, 1 `DelegDeRegKey [SC]`, 2 `DelegDelegate [SC, B pool]`, 3 `PoolRegister [B pool, B vrf]`, 4 `PoolRetire [B pool, I epoch]` (SC = StakingCredential) |
| TxCert (V3) | 0 `RegStaking [Cred, Maybe I]`, 1 `UnRegStaking [Cred, Maybe I]`, 2 `DelegStaking [Cred, Delegatee]`, 3 `RegDeleg [Cred, Delegatee, I deposit]`, 4 `RegDRep [Cred, I]`, 5 `UpdateDRep [Cred]`, 6 `UnRegDRep [Cred, I]`, 7 `PoolRegister [B, B vrf]`, 8 `PoolRetire [B, I epoch]`, 9 `AuthHotCommittee [Cred, Cred]`, 10 `ResignColdCommittee [Cred]` |
| Governance (V3) | Delegatee: `DelegStake [B pool]` 0, `DelegVote [DRep]` 1, `DelegStakeVote [B, DRep]` 2; DRep: `[Cred]` 0, `AlwaysAbstain` 1, `AlwaysNoConfidence` 2. Voter: `Committee [Cred]` 0, `DRep [Cred]` 1, `StakePool [B]` 2; Vote: `No` 0, `Yes` 1, `Abstain` 2. GovActionId `Constr 0 [B tx_id, I index]`; ProposalProcedure `Constr 0 [I deposit, Credential return_addr, GovAction]` (GovAction 0..6: ParameterChange, HardForkInitiation, TreasuryWithdrawals, NoConfidence, UpdateCommittee, NewConstitution, InfoAction) |

Surprise: V3 `RegStaking` / `UnRegStaking` deposit is always `Nothing` in this server's context builder; the ledger does so only at protocol 9, from 10 it puts `Just deposit` for deposit-carrying certificates.
