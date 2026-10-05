# Kanban-style workflow (different planning, contract-compliant)

Goal: ship the kanban export without breaking the board import

The planning process may differ across workflows. This one uses a totally
different section vocabulary, but the plan it hands to the adapter satisfies the
Universal Adapter Contract: tasks live inside `## S-<nn>` story sections.

## Planning notes

- this is prose
- [ ] (a planning note, must never become a task)

## S-01 Export

- [ ] T-01 Serialize the board
- [ ] T-02 Ship the export endpoint

## Risks / Constraints

- import must keep working

## Completion Requirements

- CR-001: export endpoint is up
- CR-002: import still works