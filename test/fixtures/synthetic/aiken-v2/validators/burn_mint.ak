//// burn_mint: an ARTIFICIAL token policy (Plutus V2, old Aiken compiler).
////
//// Compile-time parameters (applied with `aiken blueprint apply`, see compile.ts):
////   admin:       payment key hash that must sign every mint
////   max_supply:  largest quantity one transaction may mint per asset name
////
//// Redeemers (Plutus Data constructors):
////   Mint { asset_name } = Constr 0 [asset_name]   admin signature, positive quantity <= max_supply
////   Burn                = Constr 1 []              every quantity of this policy in the transaction is negative
////
//// A minting policy gets no datum; the burn path needs no signature.

use aiken/hash.{Blake2b_224, Hash}
use aiken/list
use aiken/transaction.{Mint, ScriptContext, Transaction}
use aiken/transaction/credential.{VerificationKey}
use aiken/transaction/value.{
  AssetName, PolicyId, from_minted_value, to_minted_value,
}

pub type MintAction {
  MintTokens { asset_name: AssetName }
  Burn
}

fn own_entries(
  ctx: ScriptContext,
  policy: PolicyId,
) -> List<(PolicyId, AssetName, Int)> {
  list.filter(
    value.flatten(from_minted_value(ctx.transaction.mint)),
    fn(entry) {
      let (entry_policy, _name, _quantity) = entry
      entry_policy == policy
    },
  )
}

pub fn authorise(
  admin: Hash<Blake2b_224, VerificationKey>,
  max_supply: Int,
  redeemer: MintAction,
  ctx: ScriptContext,
) -> Bool {
  expect Mint(policy) = ctx.purpose
  let entries = own_entries(ctx, policy)
  when redeemer is {
    MintTokens { asset_name } -> and {
        list.has(ctx.transaction.extra_signatories, admin),
        list.length(entries) == 1,
        list.all(
          entries,
          fn(entry) {
            let (_policy, name, quantity) = entry
            and {
              name == asset_name,
              quantity > 0,
              quantity <= max_supply,
            }
          },
        ),
      }
    Burn -> and {
        !list.is_empty(entries),
        list.all(
          entries,
          fn(entry) {
            let (_policy, _name, quantity) = entry
            quantity < 0
          },
        ),
      }
  }
}

validator(admin: Hash<Blake2b_224, VerificationKey>, max_supply: Int) {
  fn mint(redeemer: MintAction, ctx: ScriptContext) -> Bool {
    authorise(admin, max_supply, redeemer, ctx)
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`)

const test_admin = #"11111111111111111111111111111111111111111111111111111111"

const test_stranger =
  #"22222222222222222222222222222222222222222222222222222222"

const test_policy = #"33333333333333333333333333333333333333333333333333333333"

const test_other_policy =
  #"44444444444444444444444444444444444444444444444444444444"

const test_name = #"4d454c44"

fn mint_context(
  minted: value.Value,
  signers: List<Hash<Blake2b_224, VerificationKey>>,
) -> ScriptContext {
  ScriptContext {
    transaction: Transaction {
      ..transaction.placeholder(),
      mint: to_minted_value(minted),
      extra_signatories: signers,
    },
    purpose: Mint(test_policy),
  }
}

test mint_by_admin() {
  authorise(
    test_admin,
    1_000,
    MintTokens { asset_name: test_name },
    mint_context(value.from_asset(test_policy, test_name, 500), [test_admin]),
  )
}

test mint_without_admin_fails() {
  !authorise(
    test_admin,
    1_000,
    MintTokens { asset_name: test_name },
    mint_context(value.from_asset(test_policy, test_name, 500), [test_stranger]),
  )
}

test mint_over_the_cap_fails() {
  !authorise(
    test_admin,
    1_000,
    MintTokens { asset_name: test_name },
    mint_context(value.from_asset(test_policy, test_name, 1_001), [test_admin]),
  )
}

test mint_of_another_name_fails() {
  !authorise(
    test_admin,
    1_000,
    MintTokens { asset_name: #"6f74686572" },
    mint_context(value.from_asset(test_policy, test_name, 1), [test_admin]),
  )
}

test burn_needs_no_signature() {
  authorise(
    test_admin,
    1_000,
    Burn,
    mint_context(value.from_asset(test_policy, test_name, -7), []),
  )
}

test burn_with_a_positive_quantity_fails() {
  !authorise(
    test_admin,
    1_000,
    Burn,
    mint_context(
      value.from_asset(test_policy, test_name, -7)
        |> value.add(test_policy, #"6f74686572", 1),
      [],
    ),
  )
}

test burn_ignores_other_policies() {
  authorise(
    test_admin,
    1_000,
    Burn,
    mint_context(
      value.from_asset(test_policy, test_name, -7)
        |> value.add(test_other_policy, test_name, 9),
      [],
    ),
  )
}

test burn_of_nothing_fails() {
  !authorise(test_admin, 1_000, Burn, mint_context(value.zero(), []))
}
