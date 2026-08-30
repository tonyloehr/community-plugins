---
name: run-fusion-cloud-recipes
description: Prepare, submit and reconcile reviewed Fusion Automation jobs with exact sources, scoped authorization and explicit budgets. Not for arbitrary model-generated cloud scripts.
---

Inspect `fusion_cloud_status`, authorization owner, reviewed recipes, scope and admission budget. Never reuse native MCP tokens, distribute a client secret or request a PAT.

Choose an installed recipe and declared typed inputs. Freeze exact source versions/configuration/hashes. A generic signed activity does not constrain code, data or cost.

Use `fusion_cloud_job_prepare` to resolve actual dependencies and reservation. Required hard-cap or immutability guarantees remain blockers when unsupported; do not weaken them silently.

Submit the unchanged plan with an existing compute grant and unique idempotency key. Durable intent/reservation precedes submission. Lost acknowledgments and unknown states never justify blind resubmission.

Poll the plugin job ID. Provider success remains validating until trusted output checks pass. Cancel only where qualified; cancellation is not rollback or free compute. Final billing comes from the trusted reconciliation adapter; unknown exposure retains its reservation.

Report processing, validation, artifact and cost evidence separately. Offline mocks do not establish geometry, residency, metering or service compatibility. See [enterprise recipes](../../docs/enterprise.md).
