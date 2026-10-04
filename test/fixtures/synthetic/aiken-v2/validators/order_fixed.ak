//// order_fixed: the same order-book logic as order_spend (lib/order_book.ak) with the operator and the fee
//// compiled in as constants instead of applied as parameters. No parameters; the program has no applied
//// `con data` arguments, so the decompiler's first note is "Outer Apply chain — no compile-time params".
////
//// operator = payment key hash of the named fixture key `payment/script-operator`
//// (compile.ts checks that the constant below equals it), fee = 30 basis points.

use aiken/transaction.{ScriptContext}
use order_book.{OrderAction, OrderDatum}

const operator = #"22aaefe63392548892f4c9e52f197f25f531905d252eec3553484e67"

const fee_numerator = 30

validator {
  fn spend(datum: OrderDatum, redeemer: OrderAction, ctx: ScriptContext) -> Bool {
    order_book.check(operator, fee_numerator, datum, redeemer, ctx)
  }
}
