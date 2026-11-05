
## MetaCore approved lead-form creation (Casey 2026-11-05)
- One generic creator: deployed lead-form-build; no client-specific substitute or direct Meta POST.
- Command: C:/jarvis-dashboard/.venv/Scripts/python.exe C:/jarvis-dashboard/tools/metacore_form_create.py <optimization_id> inspect|create|read --output <NEW evidence.json>. Operation-first also works; omitted operation defaults to inspect.
- create --prepare-only is read-only inspect, NOT creation proof. inspect/read do not mint approval, reserve a job, upload photos, switch ads or release approval.
- Actual create waits for Casey's existing form approval AND JARVIS's metacore:buildform card. The command requires JARVIS's existing held approve verdict and exact proposal signature. Never fabricate a hold/attestation or treat deployment consent as form approval.
- After create, run read separately and require all live content/image/privacy/contact/ZIP/booking checks. Unsupported proposal shapes fail closed; this does not promise every possible Meta form shape.
- Interrupted/uncertain create: inspect/read and hand Forge the journal evidence. Never clear/reset/replay a reservation; never create a second form by another path.
- Vector owns building and verifying the Meta form. Hand Forge an approved mapping card with client, optimization ID, new form ID, live read evidence and required fields. Jacklight stays Forge-only.
- Only after Forge maps in GHL and reads it back, run C:/jarvis-dashboard/tools/metacore_form_built.py <optimization_id> <form_id> --mapped "<Forge read-back>". This releases the held approval through JARVIS and may switch ads; never run it from a capability test.
- First live creation/native POST acceptance is still deferred to the approved buildform card; read-only and fixture acceptance are not live create/idempotency proof.
