
## MetaCore approved lead-form creation (Casey 2026-11-05)
- One generic creator: deployed lead-form-build; no client-specific substitute or direct Meta POST.
- Command: C:/jarvis-dashboard/.venv/Scripts/python.exe C:/jarvis-dashboard/tools/metacore_form_create.py <optimization_id> inspect|create|read --output <NEW evidence.json>. Operation-first also works; omitted operation defaults to inspect.
- create --prepare-only is read-only inspect, NOT creation proof. inspect/read do not mint approval, reserve a job, upload photos, switch ads or release approval.
- Actual create waits for Casey's existing form approval AND JARVIS's metacore:buildform card. The command requires JARVIS's existing held approve verdict and exact proposal signature. Never fabricate a hold/attestation or treat deployment consent as form approval.
- After create, run read separately and require all live content/image/privacy/contact/ZIP/booking checks. Unsupported proposal shapes fail closed; this does not promise every possible Meta form shape.
- Interrupted/uncertain create: inspect/read and hand Forge the journal evidence. Never clear/reset/replay a reservation; never create a second form by another path.
- Forge maintains tools/metacore_form_create.py (thin interface), crew/lead_form_build.py (reviewed approval/auth client) and the deployed lead-form-build function in MetaCore project rqqwsiybtwmdkpndlbfj.
- Durable source/tests/recovery notes: C:/jarvis-dashboard/crew/lead-form-build-t_6ccc1dff/README.txt. Load metacore-lead-form-build and ghl-jacklight before the corresponding work.
- Existing apply_jobs/apply_attempts are the receipt journal; no new schema needed. Namespaced primary key, optimization_id column deliberately NULL so later ad application keeps its unique slot. needs_fix is a no-auto-replay parking state.
- Back up every changed file, test and use one independent review lane. A function redeploy requires scope-specific consent; do not deploy the obsolete fixed-v5 endpoint or receipt.sql.
- Mapping is Forge-only through Jacklight: back up the current integration, map all approved fields, read back enabled state and exact field destinations; return that evidence to Vector. Do not report form-built or release approval from maintenance/capability tests.
