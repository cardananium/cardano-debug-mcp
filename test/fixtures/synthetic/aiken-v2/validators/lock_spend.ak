//// lock_spend: a small ARTIFICIAL spend validator (Plutus V2, old Aiken compiler), friendly to
//// reference-script use. No parameters.
////
//// Redeemers (Plutus Data constructors):
////   Refund                  = Constr 0 []     fails with the trace message "lock_spend: refund is disabled"
////   Unlock                  = Constr 1 []     passes when the spent input is found among the inputs
////   Batch { expected }      = Constr 2 [n]    passes when exactly n inputs sit at the same script address
////                                             as the spent one (trace "lock_spend: batch size mismatch" otherwise)
////   Sweep { out_index }     = Constr 3 [i]    passes when output i goes to a key address and carries at least the
////                                             lovelace of the spent input minus the transaction fee
//// Any other redeemer fails with a MachineError. The datum is accepted as is (any Data).

use aiken/list
use aiken/transaction.{
  Input, NoDatum, Output, OutputReference, ScriptContext, Spend, Transaction,
  TransactionId,
}
use aiken/transaction/credential.{
  Address, ScriptCredential, VerificationKeyCredential,
}
use aiken/transaction/value.{lovelace_of}

pub type LockAction {
  Refund
  Unlock
  Batch { expected: Int }
  Sweep { out_index: Int }
}

fn find_own(ctx: ScriptContext) -> Option<Input> {
  expect Spend(reference) = ctx.purpose
  list.find(
    ctx.transaction.inputs,
    fn(input) { input.output_reference == reference },
  )
}

fn same_script(own: Input, other: Input) -> Bool {
  when own.output.address.payment_credential is {
    ScriptCredential(own_hash) ->
      when other.output.address.payment_credential is {
        ScriptCredential(other_hash) -> own_hash == other_hash
        _ -> False
      }
    _ -> False
  }
}

pub fn authorise(redeemer: LockAction, ctx: ScriptContext) -> Bool {
  when redeemer is {
    Refund -> {
      trace @"lock_spend: refund is disabled"
      False
    }
    Unlock -> {
      trace @"lock_spend: unlocking"
      when find_own(ctx) is {
        Some(_) -> True
        None -> False
      }
    }
    Batch { expected } ->
      when find_own(ctx) is {
        Some(own) -> {
          let batch = list.count(ctx.transaction.inputs, same_script(own, _))
          if batch == expected {
            True
          } else {
            trace @"lock_spend: batch size mismatch"
            False
          }
        }
        None -> False
      }
    Sweep { out_index } ->
      when (find_own(ctx), list.at(ctx.transaction.outputs, out_index)) is {
        (Some(own), Some(out)) ->
          when out.address.payment_credential is {
            VerificationKeyCredential(_) ->
              lovelace_of(out.value) >= lovelace_of(own.output.value) - lovelace_of(
                ctx.transaction.fee,
              )
            ScriptCredential(_) -> False
          }
        _ -> False
      }
  }
}

validator {
  fn spend(_datum: Data, redeemer: LockAction, ctx: ScriptContext) -> Bool {
    authorise(redeemer, ctx)
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`)

const test_script = #"11111111111111111111111111111111111111111111111111111111"

const test_key = #"22222222222222222222222222222222222222222222222222222222"

fn reference(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: TransactionId {
      hash: #"3333333333333333333333333333333333333333333333333333333333333333",
    },
    output_index: n,
  }
}

fn locked(n: Int, address: Address, lovelace: Int) -> Input {
  Input {
    output_reference: reference(n),
    output: Output {
      address,
      value: value.from_lovelace(lovelace),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn pay_to(address: Address, lovelace: Int) -> Output {
  Output {
    address,
    value: value.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

fn context(inputs: List<Input>, outputs: List<Output>) -> ScriptContext {
  ScriptContext {
    transaction: Transaction {
      ..transaction.placeholder(),
      inputs: inputs,
      outputs: outputs,
      fee: value.from_lovelace(200_000),
    },
    purpose: Spend(reference(0)),
  }
}

test unlock_passes() {
  authorise(
    Unlock,
    context([locked(0, credential.from_script(test_script), 5_000_000)], []),
  )
}

test unlock_of_a_missing_input_fails() {
  !authorise(
    Unlock,
    context([locked(1, credential.from_script(test_script), 5_000_000)], []),
  )
}

test refund_fails() {
  !authorise(
    Refund,
    context([locked(0, credential.from_script(test_script), 5_000_000)], []),
  )
}

test batch_counts_inputs_at_the_same_script() {
  let script = credential.from_script(test_script)
  let key = credential.from_verification_key(test_key)
  let ctx =
    context(
      [
        locked(0, script, 1_000_000),
        locked(1, script, 1_000_000),
        locked(2, key, 1_000_000),
      ],
      [],
    )
  and {
    authorise(Batch { expected: 2 }, ctx),
    !authorise(Batch { expected: 3 }, ctx),
  }
}

test sweep_to_a_key_address() {
  let script = credential.from_script(test_script)
  let key = credential.from_verification_key(test_key)
  and {
    authorise(
      Sweep { out_index: 0 },
      context([locked(0, script, 5_000_000)], [pay_to(key, 4_800_000)]),
    ),
    !authorise(
      Sweep { out_index: 0 },
      context([locked(0, script, 5_000_000)], [pay_to(key, 4_000_000)]),
    ),
    !authorise(
      Sweep { out_index: 0 },
      context([locked(0, script, 5_000_000)], [pay_to(script, 4_800_000)]),
    ),
    !authorise(
      Sweep { out_index: 3 },
      context([locked(0, script, 5_000_000)], []),
    ),
  }
}
