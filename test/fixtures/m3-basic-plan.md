# M-03 Library borrowing (M3.4 e2e fixture)

Goal: patron dapat meminjam buku dan stok berkurang dalam satu transaksi

## Context

Modul borrowing belum ada.

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

## Completion Requirements

- CR-01: POST /borrow mengurangi stok dan menulis ledger
- CR-02: stok habis ditolak dengan 409
