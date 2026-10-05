# M-03 Library borrowing (current workflow fixture)

Goal: a patron can borrow a book and stock decreases in a single transaction

## Context

The current planning workflow: milestone + stories + completion requirements.

## Scope

- endpoint + service + ledger

## Out of Scope

- UI, fines

## Risks / Constraints

- without stock race conditions

## S-01 Borrow flow

- Scope: service + endpoint, without UI
- [ ] T-01 Add borrow endpoint
- [ ] T-01.1 Validate stock
- [ ] T-01.2 Write ledger entry
- [ ] T-02 Add borrow tests

## S-02 Ledger integrity

- Scope: rollback semantics
- [ ] T-03 Rollback on stock failure

## Completion Requirements

- CR-01: POST /borrow reduces stock and writes ledger
- CR-02: out of stock is rejected with 409
- CR-03: ledger rollback when stock fails
