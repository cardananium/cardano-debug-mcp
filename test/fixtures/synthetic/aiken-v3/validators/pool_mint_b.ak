//// pool_mint_b: an ARTIFICIAL one-shot NFT policy (Plutus V3, Aiken v1.1.x).
////
//// Compile-time parameter (applied with `aiken blueprint apply`, see compile.ts):
////   seed:  the output reference (Constr 0 [tx id, index]) that must be spent by the minting transaction,
////          which makes the policy usable exactly once
////
//// Redeemers (Plutus Data constructors):
////   MintNft { name } = Constr 0 [name]   the transaction spends the seed and mints exactly {name: 1} under this policy
////   BurnNft          = Constr 1 []       every quantity of this policy in the transaction is negative (and there is one)

use aiken/collection/dict
use aiken/collection/list
use cardano/address
use cardano/assets.{PolicyId, tokens}
use cardano/transaction.{Input, Output, OutputReference, Transaction}

pub type NftAction {
  MintNft { name: ByteArray }
  BurnNft
}

validator pool_mint_b(seed: OutputReference) {
  mint(redeemer: NftAction, policy_id: PolicyId, self: Transaction) {
    let minted = dict.to_pairs(tokens(self.mint, policy_id))
    when redeemer is {
      MintNft { name } -> and {
          list.any(self.inputs, fn(input) { input.output_reference == seed }),
          minted == [Pair(name, 1)],
        }
      BurnNft -> and {
          !list.is_empty(minted),
          list.all(minted, fn(Pair(_, quantity)) { quantity < 0 }),
        }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------------------------------
// Tests (`aiken check`)

const test_policy: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

const test_name = #"4e4654"

fn test_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
    output_index: 2,
  }
}

fn seed_input(reference: OutputReference) -> Input {
  Input {
    output_reference: reference,
    output: Output {
      address: address.from_verification_key(
        #"66666666666666666666666666666666666666666666666666666666",
      ),
      value: assets.from_lovelace(5_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

fn tx_with(inputs: List<Input>, minted: assets.Value) -> Transaction {
  Transaction { ..transaction.placeholder, inputs, mint: minted }
}

test the_nft_is_minted_once_with_the_seed() {
  pool_mint_b.mint(
    test_seed(),
    MintNft { name: test_name },
    test_policy,
    tx_with(
      [seed_input(test_seed())],
      assets.from_asset(test_policy, test_name, 1),
    ),
  )
}

test minting_without_the_seed_fails() {
  let other = OutputReference { ..test_seed(), output_index: 3 }
  !pool_mint_b.mint(
    test_seed(),
    MintNft { name: test_name },
    test_policy,
    tx_with([seed_input(other)], assets.from_asset(test_policy, test_name, 1)),
  )
}

test minting_two_fails() {
  !pool_mint_b.mint(
    test_seed(),
    MintNft { name: test_name },
    test_policy,
    tx_with(
      [seed_input(test_seed())],
      assets.from_asset(test_policy, test_name, 2),
    ),
  )
}

test minting_another_name_fails() {
  !pool_mint_b.mint(
    test_seed(),
    MintNft { name: test_name },
    test_policy,
    tx_with(
      [seed_input(test_seed())],
      assets.from_asset(test_policy, #"6f74686572", 1),
    ),
  )
}

test the_nft_is_burned() {
  and {
    pool_mint_b.mint(
      test_seed(),
      BurnNft,
      test_policy,
      tx_with([], assets.from_asset(test_policy, test_name, -1)),
    ),
    !pool_mint_b.mint(
      test_seed(),
      BurnNft,
      test_policy,
      tx_with([], assets.from_asset(test_policy, test_name, 1)),
    ),
    !pool_mint_b.mint(
      test_seed(),
      BurnNft,
      test_policy,
      tx_with([], assets.zero),
    ),
  }
}
