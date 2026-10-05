# M-04 M3 handoff probe (no execution)

Goal: the adapter creates a pi-goal from this approved plan and stops; do not execute any task, do not run tests, do not collect evidence, do not complete or audit the goal

## Context

This is a handoff probe fixture for M3.4. Its objective is deliberately not real work.

## Scope

- verify goal creation, task ids, parent-child links, verification contract, block_completion

## Out of Scope

- executing any task, running tests, auditing, completing the goal

## Risks / Constraints

- the goal must stay open with all tasks pending

## S-01 Handoff check

- Scope: handoff only
- [ ] T-01 Confirm goal exists
- [ ] T-01.1 Confirm task ids
- [ ] T-01.2 Confirm contract line
- [ ] T-02 Confirm block_completion

## Completion Requirements

- CR-01: goal exists with the four task ids and T-01.1/T-01.2 under T-01
- CR-02: goal verification contract carries CR-01 and CR-02 on one line
