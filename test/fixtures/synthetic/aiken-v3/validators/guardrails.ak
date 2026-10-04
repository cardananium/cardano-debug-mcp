//// guardrails: an ARTIFICIAL constitution-guardrails script (Plutus V3, Aiken v1.1.x). No parameters.
//// All limits below are invented for these fixtures; they say nothing about any real constitution.
////
//// One validator, three handlers (a multi-handler V3 validator is ONE script: one hash for all of them):
////
//// propose(redeemer, proposal, tx)
////   redeemer: a Plutus Data map, normally the empty one (`Map []`); anything that is not a map fails with a
////             MachineError.
////   ParameterChange: passes when every CHANGED parameter is inside its bound (an unchanged parameter is not
////             looked at, an empty change passes). Bounds by protocol-parameter index (inclusive):
////               0 min fee coefficient 30..100          1 min fee constant 100000..1000000
////               2 max block body size 24576..122880    3 max tx size 12288..32768
////               4 max block header size 1100..5000     5 stake credential deposit 1000000..5000000
////               6 pool deposit 100000000..1000000000   7 pool retirement horizon 1..100
////               8 desired pools 100..2000              16 min pool cost 0..500000000
////               17 coins per utxo byte 3000..6500      19 prices: memory <= 1/10, cpu <= 1/10000
////               20 max tx ex units: memory <= 40000000, cpu <= 30000000000
////               21 max block ex units: memory <= 120000000, cpu <= 100000000000
////               22 max value size 4000..12288          23 collateral percentage 100..200
////               24 max collateral inputs 1..10         27 min committee size 0..15
////               28 max committee mandate 1..150        29 proposal lifetime 1..15
////               30 gov action deposit 1000000000..1000000000000
////               31 drep deposit 100000000..2000000000  32 drep max idle epochs 1..100
////             Not checked: 9 10 11 (rationals), 18 (cost models), 25 26 (voting thresholds), 33.
////   TreasuryWithdrawal: passes when every amount is positive and the total is at most 10,000,000 ada.
////   Any other action: fails.
//// vote(redeemer, voter, tx)
////   redeemer: Allow = Constr 0 [], Deny = Constr 1 [].
////   passes when the transaction names at least one required signer and: a stake pool voter is itself a
////   required signer; any other voter needs the redeemer Allow.
//// publish(redeemer, certificate, tx)
////   passes for the registration (deposit >= 100 ada) or the update of a DRep; fails for every other certificate.

use aiken/collection/list
use aiken/math/rational.{Rational}
use cardano/address.{Credential, Script, VerificationKey}
use cardano/certificate.{
  Certificate, RegisterDelegateRepresentative, UpdateDelegateRepresentative,
}
use cardano/governance.{
  ProposalProcedure, ProtocolParameters, StakePool, TreasuryWithdrawal, Voter,
}
use cardano/governance/protocol_parameters as pp
use cardano/transaction.{Transaction}

const max_treasury_withdrawal = 10_000_000_000_000

const min_drep_deposit = 100_000_000

pub type VoteAction {
  Allow
  Deny
}

/// An unset parameter always passes; a set one must lie in [low, high].
fn bounded(candidate: Option<Int>, low: Int, high: Int) -> Bool {
  when candidate is {
    None -> True
    Some(value) -> value >= low && value <= high
  }
}

fn price_at_most(
  candidate: Option<Rational>,
  numerator: Int,
  denominator: Int,
) -> Bool {
  when candidate is {
    None -> True
    Some(price) ->
      when rational.new(numerator, denominator) is {
        Some(limit) -> rational.compare_with(price, <=, limit)
        None -> False
      }
  }
}

fn units_at_most(
  candidate: Option<pp.ExecutionUnits>,
  max_memory: Int,
  max_cpu: Int,
) -> Bool {
  when candidate is {
    None -> True
    Some(units) -> units.memory <= max_memory && units.cpu <= max_cpu
  }
}

fn prices_ok(candidate: Option<pp.ScriptExecutionPrices>) -> Bool {
  when candidate is {
    None -> True
    Some(prices) -> and {
        price_at_most(Some(prices.memory), 1, 10),
        price_at_most(Some(prices.cpu), 1, 10_000),
      }
  }
}

fn parameters_ok(new_parameters: pp.ProtocolParametersUpdate) -> Bool {
  and {
    bounded(pp.min_fee_coefficient(new_parameters), 30, 100),
    bounded(pp.min_fee_constant(new_parameters), 100_000, 1_000_000),
    bounded(pp.max_block_body_size(new_parameters), 24_576, 122_880),
    bounded(pp.max_transaction_size(new_parameters), 12_288, 32_768),
    bounded(pp.max_block_header_size(new_parameters), 1_100, 5_000),
    bounded(pp.stake_credential_deposit(new_parameters), 1_000_000, 5_000_000),
    bounded(pp.stake_pool_deposit(new_parameters), 100_000_000, 1_000_000_000),
    bounded(pp.stake_pool_retirement_horizon(new_parameters), 1, 100),
    bounded(pp.desired_number_of_stake_pools(new_parameters), 100, 2_000),
    bounded(pp.min_stake_pool_cost(new_parameters), 0, 500_000_000),
    bounded(pp.min_utxo_deposit_coefficient(new_parameters), 3_000, 6_500),
    prices_ok(pp.script_execution_prices(new_parameters)),
    units_at_most(
      pp.max_transaction_execution_units(new_parameters),
      40_000_000,
      30_000_000_000,
    ),
    units_at_most(
      pp.max_block_execution_units(new_parameters),
      120_000_000,
      100_000_000_000,
    ),
    bounded(pp.max_value_size(new_parameters), 4_000, 12_288),
    bounded(pp.collateral_percentage(new_parameters), 100, 200),
    bounded(pp.max_collateral_inputs(new_parameters), 1, 10),
    bounded(pp.min_constitutional_committee_size(new_parameters), 0, 15),
    bounded(pp.max_constitutional_committee_mandate(new_parameters), 1, 150),
    bounded(pp.governance_proposal_lifetime(new_parameters), 1, 15),
    bounded(
      pp.governance_proposal_deposit(new_parameters),
      1_000_000_000,
      1_000_000_000_000,
    ),
    bounded(
      pp.delegate_representative_deposit(new_parameters),
      100_000_000,
      2_000_000_000,
    ),
    bounded(pp.delegate_representative_max_idle_time(new_parameters), 1, 100),
  }
}

fn withdrawals_ok(beneficiaries: Pairs<a, Int>) -> Bool {
  let amounts = list.map(beneficiaries, fn(Pair(_, amount)) { amount })
  and {
    list.all(amounts, fn(amount) { amount > 0 }),
    list.foldl(amounts, 0, fn(amount, total) { amount + total }) <= max_treasury_withdrawal,
  }
}

validator guardrails {
  propose(
    _redeemer: Pairs<Data, Data>,
    proposal: ProposalProcedure,
    _self: Transaction,
  ) {
    when proposal.governance_action is {
      ProtocolParameters { new_parameters, .. } -> parameters_ok(new_parameters)
      TreasuryWithdrawal { beneficiaries, .. } -> withdrawals_ok(beneficiaries)
      _ -> False
    }
  }

  vote(redeemer: VoteAction, voter: Voter, self: Transaction) {
    and {
      !list.is_empty(self.extra_signatories),
      when voter is {
        StakePool(pool) -> list.has(self.extra_signatories, pool)
        _ -> redeemer == Allow
      },
    }
  }

  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterDelegateRepresentative { deposit, .. } ->
        deposit >= min_drep_deposit
      UpdateDelegateRepresentative { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`). The protocol-parameter update is an opaque stdlib type: tests build its Plutus Data
// (a map from the parameter index to the new value) and cast it.

const no_redeemer: Pairs<Data, Data> = []

const test_return =
  VerificationKey(#"11111111111111111111111111111111111111111111111111111111")

// Same Plutus Data shape as the stdlib's ProposalProcedure / ProtocolParameters, with the opaque
// parameter update spelled out as the map it is on chain.
type ChangeShape {
  ancestor: Option<Data>,
  new_parameters: Pairs<Int, Data>,
  guardrails: Option<ByteArray>,
}

type ProposalShape {
  deposit: Int,
  return_address: Credential,
  action: ChangeShape,
}

fn parameter_change(changes: Pairs<Int, Data>) -> ProposalProcedure {
  let raw: Data =
    ProposalShape {
      deposit: 100_000_000_000,
      return_address: test_return,
      action: ChangeShape {
        ancestor: None,
        new_parameters: changes,
        guardrails: Some(
          #"22222222222222222222222222222222222222222222222222222222",
        ),
      },
    }
  expect proposal: ProposalProcedure = raw
  proposal
}

fn int_param(value: Int) -> Data {
  let data: Data = value
  data
}

fn units_param(memory: Int, cpu: Int) -> Data {
  let units: List<Int> = [memory, cpu]
  let data: Data = units
  data
}

fn price_param(numerator: Int, denominator: Int) -> Data {
  let price: List<Int> = [numerator, denominator]
  let data: Data = price
  data
}

fn prices(memory: Data, cpu: Data) -> Data {
  let both: List<Data> = [memory, cpu]
  let data: Data = both
  data
}

fn accepts(changes: Pairs<Int, Data>) -> Bool {
  guardrails.propose(
    no_redeemer,
    parameter_change(changes),
    transaction.placeholder,
  )
}

test an_empty_change_passes() {
  accepts([])
}

test fee_and_size_changes_inside_the_bounds_pass() {
  accepts(
    [
      Pair(0, int_param(44)),
      Pair(1, int_param(155_381)),
      Pair(3, int_param(16_384)),
      Pair(17, int_param(4_310)),
      Pair(22, int_param(5_000)),
      Pair(23, int_param(150)),
    ],
  )
}

test execution_units_and_prices_inside_the_bounds_pass() {
  accepts(
    [
      Pair(19, prices(price_param(577, 10_000), price_param(721, 10_000_000))),
      Pair(20, units_param(14_000_000, 10_000_000_000)),
      Pair(21, units_param(62_000_000, 20_000_000_000)),
    ],
  )
}

test a_fee_coefficient_above_the_bound_fails() {
  !accepts([Pair(0, int_param(101))])
}

test a_collateral_percentage_below_the_bound_fails() {
  !accepts([Pair(23, int_param(50))])
}

test a_transaction_size_above_the_bound_fails() {
  !accepts([Pair(3, int_param(100_000))])
}

test a_transaction_memory_limit_above_the_bound_fails() {
  !accepts([Pair(20, units_param(41_000_000, 10_000_000_000))])
}

test a_memory_price_above_the_bound_fails() {
  !accepts([Pair(19, prices(price_param(1, 2), price_param(721, 10_000_000)))])
}

test one_bad_parameter_among_good_ones_fails() {
  !accepts([Pair(0, int_param(44)), Pair(23, int_param(500))])
}

fn withdrawal(amounts: List<Int>) -> ProposalProcedure {
  ProposalProcedure {
    deposit: 100_000_000_000,
    return_address: test_return,
    governance_action: TreasuryWithdrawal {
      beneficiaries: list.map(amounts, fn(amount) { Pair(test_return, amount) }),
      guardrails: None,
    },
  }
}

test a_small_treasury_withdrawal_passes() {
  guardrails.propose(
    no_redeemer,
    withdrawal([5_000_000_000, 1_000_000]),
    transaction.placeholder,
  )
}

test a_huge_treasury_withdrawal_fails() {
  !guardrails.propose(
    no_redeemer,
    withdrawal([10_000_000_000_001]),
    transaction.placeholder,
  )
}

test a_non_positive_treasury_amount_fails() {
  !guardrails.propose(
    no_redeemer,
    withdrawal([5_000_000_000, 0]),
    transaction.placeholder,
  )
}

test other_actions_fail() {
  let poll =
    ProposalProcedure {
      deposit: 100_000_000_000,
      return_address: test_return,
      governance_action: governance.NicePoll,
    }
  !guardrails.propose(no_redeemer, poll, transaction.placeholder)
}

fn signed(keys: List<ByteArray>) -> Transaction {
  Transaction { ..transaction.placeholder, extra_signatories: keys }
}

test a_drep_script_votes_with_allow() {
  guardrails.vote(
    Allow,
    governance.DelegateRepresentative(
      Script(#"33333333333333333333333333333333333333333333333333333333"),
    ),
    signed([#"44444444444444444444444444444444444444444444444444444444"]),
  )
}

test a_vote_with_deny_fails() {
  !guardrails.vote(
    Deny,
    governance.DelegateRepresentative(
      Script(#"33333333333333333333333333333333333333333333333333333333"),
    ),
    signed([#"44444444444444444444444444444444444444444444444444444444"]),
  )
}

test a_vote_without_any_signer_fails() {
  !guardrails.vote(
    Allow,
    governance.DelegateRepresentative(
      Script(#"33333333333333333333333333333333333333333333333333333333"),
    ),
    signed([]),
  )
}

test a_pool_votes_when_it_signs() {
  let pool = #"55555555555555555555555555555555555555555555555555555555"
  and {
    guardrails.vote(Deny, StakePool(pool), signed([pool])),
    !guardrails.vote(
      Allow,
      StakePool(pool),
      signed([#"44444444444444444444444444444444444444444444444444444444"]),
    ),
  }
}

test a_drep_registration_needs_the_deposit() {
  let drep = Script(#"66666666666666666666666666666666666666666666666666666666")
  and {
    guardrails.publish(
      0,
      RegisterDelegateRepresentative {
        delegate_representative: drep,
        deposit: 500_000_000,
      },
      transaction.placeholder,
    ),
    !guardrails.publish(
      0,
      RegisterDelegateRepresentative {
        delegate_representative: drep,
        deposit: 1_000_000,
      },
      transaction.placeholder,
    ),
    guardrails.publish(
      0,
      UpdateDelegateRepresentative { delegate_representative: drep },
      transaction.placeholder,
    ),
    !guardrails.publish(
      0,
      certificate.RetireStakePool {
        stake_pool: #"77777777777777777777777777777777777777777777777777777777",
        at_epoch: 5,
      },
      transaction.placeholder,
    ),
  }
}
