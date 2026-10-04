---
gist: Conway certificates, voting procedures, proposals, DRep delegation: kinds, deposits, voter-action rules.
---
# Governance in Conway

| Field | Variants / rules |
|---|---|
| Certificates (4) | 0 stake reg, 1 unreg, 2 pool deleg; 3 `pool_registration`, 4 `pool_retirement`; 7/8 reg/unreg with deposit; 9 `vote_deleg`, 10 `stake_vote_deleg`, 11..13 reg+deleg; 14 `auth_committee_hot`, 15 `resign_committee_cold`; 16/17/18 `reg_drep`/`unreg_drep`/`update_drep`. Key cred → signature; script → script + `publish`. Exact deposits: stake pp 5, pool pp 6, DRep pp 31, gov action pp 30; refunds = originally paid deposit |
| Voting (19) | voter `[0 CC hot key\|1 CC hot script\|2 DRep key\|3 DRep script\|4 SPO key,hash]`; vote 0 no / 1 yes / 2 abstain. Voter exists, action live, kind allowed (`DisallowedVoters`): SPOs never on constitution/treasury withdrawals, on parameter change only if touching the security group (pp 0-4,17,21,22,30,33; context `govActionContexts[].changedParameters`); CC never on no-confidence/committee-update |
| Proposals (20) | `[deposit,reward_account,gov_action,anchor]`; action 0 `parameter_change`, 1 `hard_fork`, 2 `treasury_withdrawals`, 3 `no_confidence`, 4 `update_committee`, 5 `new_constitution`, 6 `info` |
| Delegation | `drep=[0 key\|1 script\|2 abstain\|3 no_confidence]`; rewards require DRep delegation (`WithdrawalNotAllowedBecauseNotDelegatedToDRep`) |
