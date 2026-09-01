---
name: warehouse-audit
description: Audit a warehouse aisle shelf by shelf while retaining bounded progress state.
metadata:
  skill-state: ./state.schema.json
---

# Warehouse Audit

Audit every shelf named by the user. For each shelf, inspect the supplied inventory source, record the shelf in `shelves_done`, append any defects, and add the number of inspected items to `items_counted`. Keep `notes` limited to the next concrete action. When all shelves are audited, call `skill_complete` with a concise result.
