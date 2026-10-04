//// reward_ok: an ARTIFICIAL staking validator (Plutus V2, old Aiken compiler).
////
//// Used for zero-lovelace reward withdrawals (the "withdraw zero" trick) and for certificates of a
//// script stake credential. No parameters.
////
//// Redeemers (Plutus Data constructors):
////   Allow = Constr 0 []   passes
////   Deny  = Constr 1 []   fails with the trace message "reward_ok: denied"
//// Anything else is not a RewardAction and makes the script fail with a MachineError.

use aiken/transaction.{ScriptContext}

pub type RewardAction {
  Allow
  Deny
}

pub fn decide(redeemer: RewardAction, ctx: ScriptContext) -> Bool {
  when redeemer is {
    Allow -> well_formed(ctx)
    Deny -> {
      trace @"reward_ok: denied"
      False
    }
  }
}

fn well_formed(ctx: ScriptContext) -> Bool {
  // always true for a well-formed context; keeps the validator from being a bare `True`
  ctx.transaction.fee == ctx.transaction.fee
}

validator {
  fn withdraw(redeemer: RewardAction, ctx: ScriptContext) -> Bool {
    decide(redeemer, ctx)
  }
}

test allow_passes() {
  decide(
    Allow,
    ScriptContext {
      transaction: transaction.placeholder(),
      purpose: transaction.Mint(
        #"00000000000000000000000000000000000000000000000000000000",
      ),
    },
  )
}

test deny_fails() {
  !decide(
    Deny,
    ScriptContext {
      transaction: transaction.placeholder(),
      purpose: transaction.Mint(
        #"00000000000000000000000000000000000000000000000000000000",
      ),
    },
  )
}
