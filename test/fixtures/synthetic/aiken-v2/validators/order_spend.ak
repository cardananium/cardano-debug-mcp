//// order_spend: an ARTIFICIAL order-book style spend validator (Plutus V2, old Aiken compiler), PARAMETERISED.
//// The rules are in lib/order_book.ak (redeemers, datum, what each path checks).
////
//// Compile-time parameters (applied one by one with `aiken blueprint apply`, see compile.ts):
////   operator:       payment key hash of the order-book operator (collects the protocol fee, may cancel)
////   fee_numerator:  protocol fee in basis points of the filled price
////
//// The published script is the blueprint program with both parameters applied, so the program is an outer
//// Apply chain whose first arguments are `con data` parameters.

use aiken/hash.{Blake2b_224, Hash}
use aiken/transaction.{ScriptContext}
use aiken/transaction/credential.{VerificationKey}
use order_book.{OrderAction, OrderDatum}

validator(operator: Hash<Blake2b_224, VerificationKey>, fee_numerator: Int) {
  fn spend(datum: OrderDatum, redeemer: OrderAction, ctx: ScriptContext) -> Bool {
    order_book.check(operator, fee_numerator, datum, redeemer, ctx)
  }
}
