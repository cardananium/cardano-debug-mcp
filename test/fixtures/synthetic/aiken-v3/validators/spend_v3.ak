//// spend_v3: a small ARTIFICIAL time-lock vault (Plutus V3, Aiken v1.1.x). No parameters.
////
//// Datum (inline): Constr 0 [owner key hash, unlock_after posix ms]. The datum must be present, must decode,
//// and must be the very inline datum of the output being spent (a datum-hash input is refused).
////
//// Redeemers (Plutus Data constructors):
////   Withdraw = Constr 0 []   the owner is a required signer and the validity range starts at or after unlock_after
////   Extend   = Constr 1 []   fails with the trace message "spend_v3: extend is not supported"
//// A missing or malformed datum makes the script fail with a MachineError / expect failure.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}

pub type VaultDatum {
  owner: VerificationKeyHash,
  unlock_after: Int,
}

pub type VaultAction {
  Withdraw
  Extend
}

validator spend_v3 {
  spend(
    datum: Option<Data>,
    redeemer: VaultAction,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(raw) = datum
    expect vault: VaultDatum = raw
    expect Some(own) =
      list.find(self.inputs, fn(input) { input.output_reference == utxo })
    expect InlineDatum(inline) = own.output.datum
    when redeemer is {
      Withdraw -> and {
          inline == raw,
          list.has(self.extra_signatories, vault.owner),
          when self.validity_range.lower_bound.bound_type is {
            Finite(start) -> start >= vault.unlock_after
            _ -> False
          },
        }
      Extend -> {
        trace @"spend_v3: extend is not supported"
        False
      }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`)

const test_owner = #"11111111111111111111111111111111111111111111111111111111"

fn test_reference() -> OutputReference {
  OutputReference {
    transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
    output_index: 0,
  }
}

fn vault_datum() -> VaultDatum {
  VaultDatum { owner: test_owner, unlock_after: 1_000 }
}

fn vault_input(datum: transaction.Datum) -> Input {
  Input {
    output_reference: test_reference(),
    output: Output {
      address: address.from_script(
        #"33333333333333333333333333333333333333333333333333333333",
      ),
      value: assets.from_lovelace(5_000_000),
      datum,
      reference_script: None,
    },
  }
}

fn withdraw_tx(
  datum: transaction.Datum,
  signers: List<ByteArray>,
  from: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [vault_input(datum)],
    extra_signatories: signers,
    validity_range: interval.after(from),
  }
}

fn raw_datum() -> Data {
  let datum: Data = vault_datum()
  datum
}

test the_owner_withdraws_after_the_unlock_time() {
  spend_v3.spend(
    Some(raw_datum()),
    Withdraw,
    test_reference(),
    withdraw_tx(InlineDatum(raw_datum()), [test_owner], 1_000),
  )
}

test withdrawing_before_the_unlock_time_fails() {
  !spend_v3.spend(
    Some(raw_datum()),
    Withdraw,
    test_reference(),
    withdraw_tx(InlineDatum(raw_datum()), [test_owner], 999),
  )
}

test withdrawing_without_the_owner_fails() {
  !spend_v3.spend(
    Some(raw_datum()),
    Withdraw,
    test_reference(),
    withdraw_tx(InlineDatum(raw_datum()), [], 2_000),
  )
}

test extend_fails_with_a_trace() {
  !spend_v3.spend(
    Some(raw_datum()),
    Extend,
    test_reference(),
    withdraw_tx(InlineDatum(raw_datum()), [test_owner], 2_000),
  )
}

test a_missing_datum_fails() fail {
  spend_v3.spend(
    None,
    Withdraw,
    test_reference(),
    withdraw_tx(InlineDatum(raw_datum()), [test_owner], 2_000),
  )
}

test an_input_with_a_datum_hash_is_refused() fail {
  spend_v3.spend(
    Some(raw_datum()),
    Withdraw,
    test_reference(),
    withdraw_tx(
      DatumHash(
        #"4444444444444444444444444444444444444444444444444444444444444444",
      ),
      [test_owner],
      2_000,
    ),
  )
}

test an_input_without_a_datum_is_refused() fail {
  spend_v3.spend(
    Some(raw_datum()),
    Withdraw,
    test_reference(),
    withdraw_tx(NoDatum, [test_owner], 2_000),
  )
}
