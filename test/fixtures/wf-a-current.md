# M-03 Library borrowing (current workflow fixture)

Goal: patron dapat meminjam buku dan stok berkurang dalam satu transaksi

## Context

The current planning workflow: milestone + stories + completion requirements.

## Scope

- endpoint + service + ledger

## Out of Scope

- UI, denda

## Risks / Constraints

- tanpa race pada stok

## S-01 Borrow flow

- Scope: service + endpoint, tanpa UI
- [ ] T-01 Add borrow endpoint
- [ ] T-01.1 Validate stock
- [ ] T-01.2 Write ledger entry
- [ ] T-02 Add borrow tests

## S-02 Ledger integrity

- Scope: rollback semantics
- [ ] T-03 Rollback on stock failure

## Completion Requirements

- CR-01: POST /borrow mengurangi stok dan menulis ledger
- CR-02: stok habis ditolak dengan 409
- CR-03: ledger rollback ketika stok gagal