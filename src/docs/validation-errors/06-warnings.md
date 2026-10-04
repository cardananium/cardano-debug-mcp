---
gist: which warnings are benign and which predict a node rejection; the server errors the node may accept.
---
# Warnings: benign versus predictive

Mostly benign (BudgetIsBiggerThanExpected <~20%); DRepNotRegistered, Duplicate*InTx predict rejection; CannotCheck*Refund needs live deposits; provider_warnings `script_unverified` predicts MissingRequiredScript.

Node may accept server errors: ExtraneousSignature; ReferenceInputsNotAllowedForPlutusV1; ReferenceInputOverlapsWithInput; ExtraneousDatumWitnesses (see their entries); also DisallowedVoters (SPO, ParameterChange) without changedParameters (see defaults_applied).
