//// pool_mint_a: an ARTIFICIAL CIP-68 style policy (Plutus V3, Aiken v1.1.x): a reference token (label 100)
//// and a user token (label 222) with the same name suffix are minted together.
////
//// Compile-time parameters (applied with `aiken blueprint apply`, see compile.ts):
////   owner:             payment key hash that must be among the required signers of every mint / burn
////   reference_holder:  script hash of the address that must receive the reference token with an inline datum
////
//// Redeemers (Plutus Data constructors):
////   MintPair { name, reference_output } = Constr 0 [name, i]
////       the transaction mints exactly {000643b0 ++ name: 1, 000de140 ++ name: 1} under this policy, is signed
////       by the owner, and output i pays the reference token to `reference_holder` with an inline datum of the
////       shape Constr 0 [metadata map, version int, extra data] (CIP-68), where the metadata map carries the
////       byte-string keys "name" and "image" and the version is 1; the name suffix is 1..28 bytes long.
////   BurnPair { name } = Constr 1 [name]
////       the transaction burns exactly {…reference: -1, …user: -1} under this policy and is signed by the owner.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of, tokens}
use cardano/transaction.{InlineDatum, Output, Transaction}

const label_reference = #"000643b0"

const label_user = #"000de140"

pub type Cip68Datum {
  metadata: Pairs<Data, Data>,
  version: Int,
  extra: Data,
}

const key_name = #"6e616d65"

const key_image = #"696d616765"

const max_suffix_length = 28

fn has_key(metadata: Pairs<Data, Data>, key: ByteArray) -> Bool {
  let wanted: Data = key
  list.any(metadata, fn(Pair(candidate, _)) { candidate == wanted })
}

fn valid_suffix(name: ByteArray) -> Bool {
  bytearray.length(name) >= 1 && bytearray.length(name) <= max_suffix_length
}

pub type PairAction {
  MintPair { name: ByteArray, reference_output: Int }
  BurnPair { name: ByteArray }
}

validator pool_mint_a(
  owner: VerificationKeyHash,
  reference_holder: ScriptHash,
) {
  mint(redeemer: PairAction, policy_id: PolicyId, self: Transaction) {
    let signed = list.has(self.extra_signatories, owner)
    let minted = dict.to_pairs(tokens(self.mint, policy_id))
    when redeemer is {
      MintPair { name, reference_output } -> {
        let reference_name = bytearray.concat(label_reference, name)
        let user_name = bytearray.concat(label_user, name)
        expect Some(holder) = list.at(self.outputs, reference_output)
        expect InlineDatum(raw) = holder.datum
        expect Cip68Datum { metadata, version, extra: _ } = raw
        and {
          signed,
          valid_suffix(name),
          version == 1,
          has_key(metadata, key_name),
          has_key(metadata, key_image),
          list.length(minted) == 2,
          quantity_of(self.mint, policy_id, reference_name) == 1,
          quantity_of(self.mint, policy_id, user_name) == 1,
          holder.address.payment_credential == Script(reference_holder),
          quantity_of(holder.value, policy_id, reference_name) == 1,
        }
      }
      BurnPair { name } -> {
        let reference_name = bytearray.concat(label_reference, name)
        let user_name = bytearray.concat(label_user, name)
        and {
          signed,
          list.length(minted) == 2,
          quantity_of(self.mint, policy_id, reference_name) == -1,
          quantity_of(self.mint, policy_id, user_name) == -1,
        }
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

const test_holder = #"22222222222222222222222222222222222222222222222222222222"

const test_policy: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

const test_suffix = #"506f6f6c"

fn reference_name() -> ByteArray {
  bytearray.concat(label_reference, test_suffix)
}

fn user_name() -> ByteArray {
  bytearray.concat(label_user, test_suffix)
}

fn datum_with(entries: Pairs<Data, Data>, version: Int) -> Data {
  let datum: Data = Cip68Datum { metadata: entries, version, extra: 0 }
  datum
}

fn good_metadata() -> Pairs<Data, Data> {
  let name_key: Data = key_name
  let image_key: Data = key_image
  let name_value: Data = #"506f6f6c"
  let image_value: Data = #"697066733a2f2f78"
  [Pair(name_key, name_value), Pair(image_key, image_value)]
}

fn holder_output(datum: Data, holder: ByteArray) -> Output {
  Output {
    address: address.from_script(holder),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(test_policy, reference_name(), 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn minting_tx(
  minted: assets.Value,
  outputs: List<Output>,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    mint: minted,
    outputs,
    extra_signatories: signers,
  }
}

fn pair_minted() -> assets.Value {
  assets.from_asset(test_policy, reference_name(), 1)
    |> assets.add(test_policy, user_name(), 1)
}

fn mint_pair(tx: Transaction, name: ByteArray) -> Bool {
  pool_mint_a.mint(
    test_owner,
    test_holder,
    MintPair { name, reference_output: 0 },
    test_policy,
    tx,
  )
}

test the_pair_is_minted() {
  mint_pair(
    minting_tx(
      pair_minted(),
      [holder_output(datum_with(good_metadata(), 1), test_holder)],
      [test_owner],
    ),
    test_suffix,
  )
}

test minting_without_the_owner_fails() {
  !mint_pair(
    minting_tx(
      pair_minted(),
      [holder_output(datum_with(good_metadata(), 1), test_holder)],
      [],
    ),
    test_suffix,
  )
}

test minting_with_a_wrong_datum_version_fails() {
  !mint_pair(
    minting_tx(
      pair_minted(),
      [holder_output(datum_with(good_metadata(), 2), test_holder)],
      [test_owner],
    ),
    test_suffix,
  )
}

test minting_with_incomplete_metadata_fails() {
  let name_key: Data = key_name
  let name_value: Data = #"506f6f6c"
  let only_name: Pairs<Data, Data> = [Pair(name_key, name_value)]
  !mint_pair(
    minting_tx(
      pair_minted(),
      [holder_output(datum_with(only_name, 1), test_holder)],
      [test_owner],
    ),
    test_suffix,
  )
}

test the_reference_token_must_go_to_the_holder() {
  !mint_pair(
    minting_tx(
      pair_minted(),
      [
        holder_output(
          datum_with(good_metadata(), 1),
          #"44444444444444444444444444444444444444444444444444444444",
        ),
      ],
      [test_owner],
    ),
    test_suffix,
  )
}

test an_extra_minted_token_fails() {
  !mint_pair(
    minting_tx(
      pair_minted() |> assets.add(test_policy, #"6578747261", 1),
      [holder_output(datum_with(good_metadata(), 1), test_holder)],
      [test_owner],
    ),
    test_suffix,
  )
}

test a_name_suffix_that_is_too_long_fails() {
  let long = #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d"
  let reference_long = bytearray.concat(label_reference, long)
  let user_long = bytearray.concat(label_user, long)
  let minted =
    assets.from_asset(test_policy, reference_long, 1)
      |> assets.add(test_policy, user_long, 1)
  let holder =
    Output {
      address: address.from_script(test_holder),
      value: assets.from_asset(test_policy, reference_long, 1),
      datum: InlineDatum(datum_with(good_metadata(), 1)),
      reference_script: None,
    }
  !mint_pair(minting_tx(minted, [holder], [test_owner]), long)
}

test the_pair_is_burned() {
  let burned =
    assets.from_asset(test_policy, reference_name(), -1)
      |> assets.add(test_policy, user_name(), -1)
  and {
    pool_mint_a.mint(
      test_owner,
      test_holder,
      BurnPair { name: test_suffix },
      test_policy,
      minting_tx(burned, [], [test_owner]),
    ),
    !pool_mint_a.mint(
      test_owner,
      test_holder,
      BurnPair { name: test_suffix },
      test_policy,
      minting_tx(burned, [], []),
    ),
  }
}

test burning_only_one_of_the_pair_fails() {
  !pool_mint_a.mint(
    test_owner,
    test_holder,
    BurnPair { name: test_suffix },
    test_policy,
    minting_tx(
      assets.from_asset(test_policy, user_name(), -1),
      [],
      [test_owner],
    ),
  )
}
