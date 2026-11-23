---
title: Launch readiness — sample audit and status brief
description: A fictional launch audit showing how to separate verified facts from unresolved work.
---

> **Hold the sample launch.** The access review and rollback rehearsal are not yet verified. The owner can change this call only after both have dated evidence. All names, dates, and statuses below are illustrative placeholders, not a real project update.

## Current gate

| Check | Status | Evidence | Owner | Next action |
|---|---|---|---|---|
| Scope agreed | Complete (sample) | Sample scope note, not attached | Project lead | Link the signed scope |
| Access review | Unknown | No sample evidence provided | Security lead | Record reviewer, scope, and result |
| Rollback rehearsal | Unknown | No sample evidence provided | Release lead | Rehearse in the target environment |
| Stakeholder notice | Draft (sample) | Sample notice, not sent | Communications | Confirm recipients and timing |

**Interpretation:** The two unknown gates are blockers, not failures and not zeros. The sample evidence labels deliberately avoid claiming a real review occurred.

## Risk register

| Risk | Why it happens | Warning sign | Mitigation |
|---|---|---|---|
| Unreviewed access | Permissions change after scope review | New account or role appears | Recheck access against the final target |
| Failed recovery | Rollback exists only on paper | No timed rehearsal record | Run a rehearsal and keep its result |
| Mixed messages | Draft notice circulates as final | Conflicting launch times | Send one approved notice from one owner |

## Decision rule

Change **hold** to **go** only when the gate table contains links to a dated access review and rollback result, the responsible owners accept the residual risks, and the notice has an approved send time. Otherwise, keep the hold and report the next review time as **Unknown** until one is set.

## Update checklist

1. Replace every sample entry with a verifiable observation and a source link.
2. Assign a real owner and due date for each open gate.
3. Record the decision, decision maker, and time in the next revision.

## Source note

This is a fictional template demonstrating [Briefkit report-writing guidance](https://github.com/taylorcjensen/briefkit/blob/main/AGENTS.md). There are no external project facts or live status assertions in this example.
