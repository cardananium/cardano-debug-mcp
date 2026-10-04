//// order_book: the logic shared by the validators `order_spend` (parameters applied with
//// `aiken blueprint apply`) and `order_fixed` (the same values compiled in as constants).
//// ARTIFICIAL order-book style logic over the Plutus V2 ScriptContext.
////
//// A maker locks tokens at the validator together with an `OrderDatum`. Anyone may `Fill` (buy) part of
//// the order, the maker (or the operator) may `Cancel` it, the maker may `Reprice` it.
////
//// Redeemers (Plutus Data constructors):
////   Cancel                        = Constr 0 []
////     passes when the maker (payment key of the datum's maker address) or the operator is a required signer.
////   Fill { amount, payout_index } = Constr 1 [amount, payout_index]
////     passes when ALL of: 0 < amount <= quantity; the validity range has a finite upper bound not after
////     expires_at; nothing of the sold policy is minted (burning is fine); the spent input carries at
////     least `quantity` of the sold token; output payout_index pays the maker at least
////     unit_price * amount - fee lovelace (and at least 1 ada); the operator is paid at least fee lovelace in
////     total (fee = unit_price * amount * fee_numerator / 10000); and either the whole order is filled or an
////     output at the same address carries the remaining tokens and an inline datum equal to the old one with
////     `quantity` reduced by `amount`.
////   Reprice { new_unit_price }    = Constr 2 [new_unit_price]
////     passes when new_unit_price > 0, the maker is a required signer and an output at the same address
////     carries an inline datum equal to the old one with the new unit price.
////
//// Datum: Constr 0 [maker address, sell_policy, sell_asset, unit_price, quantity, expires_at, memo].
//// A datum that is not a constructor (for example a list) makes the script fail with a MachineError.

use aiken/hash.{Blake2b_224, Hash}
use aiken/interval.{Finite, IntervalBound}
use aiken/list
use aiken/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, ScriptContext, Spend,
  Transaction, TransactionId,
}
use aiken/transaction/credential.{
  Address, ScriptCredential, VerificationKey, VerificationKeyCredential,
}
use aiken/transaction/value.{
  AssetName, PolicyId, from_minted_value, lovelace_of, quantity_of,
}

pub type OrderDatum {
  maker: Address,
  sell_policy: PolicyId,
  sell_asset: AssetName,
  unit_price: Int,
  quantity: Int,
  expires_at: Int,
  memo: ByteArray,
}

pub type OrderAction {
  Cancel
  Fill { amount: Int, payout_index: Int }
  Reprice { new_unit_price: Int }
}

const bps_base = 10_000

const min_lovelace_payout = 1_000_000

pub fn signed_by(
  tx: Transaction,
  key_hash: Hash<Blake2b_224, VerificationKey>,
) -> Bool {
  list.has(tx.extra_signatories, key_hash)
}

fn maker_key(maker: Address) -> Option<Hash<Blake2b_224, VerificationKey>> {
  when maker.payment_credential is {
    VerificationKeyCredential(key_hash) -> Some(key_hash)
    ScriptCredential(_) -> None
  }
}

fn maker_signed(tx: Transaction, maker: Address) -> Bool {
  when maker_key(maker) is {
    Some(key_hash) -> signed_by(tx, key_hash)
    None -> False
  }
}

fn expires_before(tx: Transaction, deadline: Int) -> Bool {
  when tx.validity_range.upper_bound is {
    IntervalBound { bound_type: Finite(upper), is_inclusive: _ } ->
      upper <= deadline
    _ -> False
  }
}

fn own_input(ctx: ScriptContext) -> Option<Input> {
  when ctx.purpose is {
    Spend(reference) -> find_by_reference(ctx.transaction.inputs, reference)
    _ -> None
  }
}

fn find_by_reference(
  inputs: List<Input>,
  reference: OutputReference,
) -> Option<Input> {
  list.find(inputs, fn(input) { input.output_reference == reference })
}

fn paid_to_key(
  outputs: List<Output>,
  key_hash: Hash<Blake2b_224, VerificationKey>,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(output, total) {
      when output.address.payment_credential is {
        VerificationKeyCredential(paid) ->
          if paid == key_hash {
            total + lovelace_of(output.value)
          } else {
            total
          }
        ScriptCredential(_) -> total
      }
    },
  )
}

fn paid_to_maker(output: Output, maker: Address) -> Int {
  if output.address.payment_credential == maker.payment_credential {
    lovelace_of(output.value)
  } else {
    0
  }
}

// Burning the sold token is fine while the order is filled; minting more of it is not.
fn burn_only(tx: Transaction, policy: PolicyId) -> Bool {
  list.all(
    value.flatten(from_minted_value(tx.mint)),
    fn(entry) {
      let (entry_policy, _name, quantity) = entry
      entry_policy != policy || quantity < 0
    },
  )
}

fn protocol_fee(price: Int, fee_numerator: Int) -> Int {
  price * fee_numerator / bps_base
}

fn continuing_output(
  outputs: List<Output>,
  script_address: Address,
) -> Option<Output> {
  list.find(outputs, fn(output) { output.address == script_address })
}

fn valid_fill(
  datum: OrderDatum,
  amount: Int,
  payout_index: Int,
  operator: Hash<Blake2b_224, VerificationKey>,
  fee_numerator: Int,
  ctx: ScriptContext,
) -> Bool {
  let tx = ctx.transaction
  expect Some(own) = own_input(ctx)
  let price = datum.unit_price * amount
  let fee = protocol_fee(price, fee_numerator)
  let remaining = datum.quantity - amount
  and {
    amount > 0,
    amount <= datum.quantity,
    expires_before(tx, datum.expires_at),
    burn_only(tx, datum.sell_policy),
    quantity_of(own.output.value, datum.sell_policy, datum.sell_asset) >= datum.quantity,
    when list.at(tx.outputs, payout_index) is {
      Some(payout) -> and {
          paid_to_maker(payout, datum.maker) >= price - fee,
          paid_to_maker(payout, datum.maker) >= min_lovelace_payout,
        }
      None -> False
    },
    paid_to_key(tx.outputs, operator) >= fee,
    if remaining == 0 {
      True
    } else {
      when continuing_output(tx.outputs, own.output.address) is {
        Some(next) ->
          when next.datum is {
            InlineDatum(raw) -> {
              expect continued: OrderDatum = raw
              and {
                continued == OrderDatum { ..datum, quantity: remaining },
                quantity_of(next.value, datum.sell_policy, datum.sell_asset) >= remaining,
              }
            }
            _ -> False
          }
        None -> False
      }
    },
  }
}

fn valid_reprice(
  datum: OrderDatum,
  new_unit_price: Int,
  ctx: ScriptContext,
) -> Bool {
  let tx = ctx.transaction
  expect Some(own) = own_input(ctx)
  and {
    new_unit_price > 0,
    maker_signed(tx, datum.maker),
    when continuing_output(tx.outputs, own.output.address) is {
      Some(next) ->
        when next.datum is {
          InlineDatum(raw) -> {
            expect continued: OrderDatum = raw
            continued == OrderDatum { ..datum, unit_price: new_unit_price }
          }
          _ -> False
        }
      None -> False
    },
  }
}

pub fn check(
  operator: Hash<Blake2b_224, VerificationKey>,
  fee_numerator: Int,
  datum: OrderDatum,
  redeemer: OrderAction,
  ctx: ScriptContext,
) -> Bool {
  when redeemer is {
    Cancel -> or {
        maker_signed(ctx.transaction, datum.maker),
        signed_by(ctx.transaction, operator),
      }
    Fill { amount, payout_index } ->
      valid_fill(datum, amount, payout_index, operator, fee_numerator, ctx)
    Reprice { new_unit_price } -> valid_reprice(datum, new_unit_price, ctx)
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`): the transactions are built with the stdlib placeholder, nothing here is on chain.

const test_operator =
  #"11111111111111111111111111111111111111111111111111111111"

const test_maker_key =
  #"22222222222222222222222222222222222222222222222222222222"

const test_buyer_key =
  #"33333333333333333333333333333333333333333333333333333333"

const test_script = #"44444444444444444444444444444444444444444444444444444444"

const test_policy = #"55555555555555555555555555555555555555555555555555555555"

const test_asset = #"4f524445"

const test_fee = 30

fn test_maker() -> Address {
  credential.from_verification_key(test_maker_key)
}

fn test_script_address() -> Address {
  credential.from_script(test_script)
}

fn test_datum(quantity: Int) -> OrderDatum {
  OrderDatum {
    maker: test_maker(),
    sell_policy: test_policy,
    sell_asset: test_asset,
    unit_price: 2_000_000,
    quantity,
    expires_at: 1_000_000,
    memo: #"6d656d6f",
  }
}

fn test_reference() -> OutputReference {
  OutputReference {
    transaction_id: TransactionId {
      hash: #"66666666666666666666666666666666666666666666666666666666666666aa",
    },
    output_index: 0,
  }
}

fn order_value(quantity: Int) -> value.Value {
  value.from_lovelace(2_000_000)
    |> value.add(test_policy, test_asset, quantity)
}

fn order_input(datum: OrderDatum) -> Input {
  Input {
    output_reference: test_reference(),
    output: Output {
      address: test_script_address(),
      value: order_value(datum.quantity),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn pay(address: Address, lovelace: Int) -> Output {
  Output {
    address,
    value: value.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

fn continuation(datum: OrderDatum, tokens_left: Int) -> Output {
  Output {
    address: test_script_address(),
    value: order_value(tokens_left),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn context(datum: OrderDatum, tx: Transaction) -> ScriptContext {
  ScriptContext {
    transaction: Transaction { ..tx, inputs: [order_input(datum)] },
    purpose: Spend(test_reference()),
  }
}

fn base_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder(),
    validity_range: interval.before(900_000),
  }
}

fn run(datum: OrderDatum, redeemer: OrderAction, tx: Transaction) -> Bool {
  check(test_operator, test_fee, datum, redeemer, context(datum, tx))
}

test cancel_by_maker() {
  let tx = Transaction { ..base_tx(), extra_signatories: [test_maker_key] }
  run(test_datum(5), Cancel, tx)
}

test cancel_by_operator() {
  let tx = Transaction { ..base_tx(), extra_signatories: [test_operator] }
  run(test_datum(5), Cancel, tx)
}

test cancel_by_stranger_fails() {
  let tx = Transaction { ..base_tx(), extra_signatories: [test_buyer_key] }
  !run(test_datum(5), Cancel, tx)
}

test fill_whole_order() {
  // 5 units at 2 ada: 10 ada, fee 30 bps = 30_000 lovelace
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        pay(test_maker(), 9_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_part_of_the_order() {
  // 2 of 5 units: 4 ada, fee 12_000; 3 units stay in the order with the datum's quantity reduced
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        pay(test_maker(), 3_988_000),
        pay(credential.from_verification_key(test_operator), 12_000),
        continuation(test_datum(3), 3),
      ],
    }
  run(test_datum(5), Fill { amount: 2, payout_index: 0 }, tx)
}

test fill_part_with_wrong_continuation_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        pay(test_maker(), 3_988_000),
        pay(credential.from_verification_key(test_operator), 12_000),
        continuation(test_datum(4), 3),
      ],
    }
  !run(test_datum(5), Fill { amount: 2, payout_index: 0 }, tx)
}

test fill_underpaying_the_maker_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        pay(test_maker(), 9_000_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  !run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_without_the_operator_fee_fails() {
  let tx = Transaction { ..base_tx(), outputs: [pay(test_maker(), 9_970_000)] }
  !run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_after_expiry_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      validity_range: interval.before(1_000_001),
      outputs: [
        pay(test_maker(), 9_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  !run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_without_upper_bound_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      validity_range: interval.everything(),
      outputs: [
        pay(test_maker(), 9_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  !run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_while_minting_the_sold_token_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      mint: value.from_asset(test_policy, test_asset, 1)
        |> value.to_minted_value,
      outputs: [
        pay(test_maker(), 9_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  !run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_while_burning_the_sold_token_is_fine() {
  let tx =
    Transaction {
      ..base_tx(),
      mint: value.from_asset(test_policy, test_asset, -1)
        |> value.to_minted_value,
      outputs: [
        pay(test_maker(), 9_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  run(test_datum(5), Fill { amount: 5, payout_index: 0 }, tx)
}

test fill_more_than_the_order_holds_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        pay(test_maker(), 11_970_000),
        pay(credential.from_verification_key(test_operator), 30_000),
      ],
    }
  !run(test_datum(5), Fill { amount: 6, payout_index: 0 }, tx)
}

test reprice_by_maker() {
  let tx =
    Transaction {
      ..base_tx(),
      extra_signatories: [test_maker_key],
      outputs: [
        continuation(OrderDatum { ..test_datum(5), unit_price: 3_000_000 }, 5),
      ],
    }
  run(test_datum(5), Reprice { new_unit_price: 3_000_000 }, tx)
}

test reprice_without_signature_fails() {
  let tx =
    Transaction {
      ..base_tx(),
      outputs: [
        continuation(OrderDatum { ..test_datum(5), unit_price: 3_000_000 }, 5),
      ],
    }
  !run(test_datum(5), Reprice { new_unit_price: 3_000_000 }, tx)
}
