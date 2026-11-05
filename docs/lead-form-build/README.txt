# MetaCore approved lead-form creation

Task: t_f1170af3. Reviewed/deployed foundation: t_6ccc1dff.

One deployed endpoint: lead-form-build in MetaCore project rqqwsiybtwmdkpndlbfj.
No second endpoint, migration or receipt table is needed. The deployed foundation
was independently accepted by JARVIS. This delivery adds the requested agent
interface and operating instructions; it does not create a client form.

Windows command (uses the existing JARVIS connection; no Meta token on the PC):

    C:/jarvis-dashboard/.venv/Scripts/python.exe C:/jarvis-dashboard/tools/metacore_form_create.py <optimization_id> inspect --output <NEW.json>

Use inspect, create or read. Operation-first also works. Default is inspect.

    ... <optimization_id> create --prepare-only --output <NEW.json>

This calls read-only inspect. It cannot upload a photo, reserve a job or create a
form. It is not proof of live creation. Evidence filenames must be new.

Actual create requires Casey's approved form proposal and the existing JARVIS
held approval/buildform card. The reviewed client signs a short-lived exact-version
attestation only after checking that hold. Never manufacture a hold, caller
attestation or source payload. Server Page tokens remain server-side. Approval
attestation shares the existing JARVIS-key trust boundary (not an independent
human signature service).

The endpoint loads the stored proposal, source form, one connected client Page
and image itself. Supported: form_rewrite, same custom-question count, native
multiple-choice CUSTOM questions and supported contact fields. Unsupported
shapes fail closed. Generic across supported client proposals, not arbitrary
Meta form layouts.

No writes to ads, budgets, optimization new_form_id or approval release occur in
this creator. Photo/form POSTs use the existing durable apply journal. Receipt is
one deterministic namespaced apply_jobs primary key per optimization; the
optimization_id column is deliberately NULL to preserve the later ad-apply unique
slot. Interrupted reservations remain needs_fix; never reset or blindly replay.
Inspect/read first and review the journal with Forge. Unknown matching names,
duplicates and uncertain receipts refuse writes. Successful matching receipts are
read/reused rather than posted again.

After actual create, read separately and check the exact proposal: all questions,
options, contacts including ZIP, intro, image, original privacy URL, thank-you
and booking link. Vector owns Meta form creation and verification. Forge alone
maps GHL with Jacklight and reads every field back. Only after that mapping
handoff does Vector run tools/metacore_form_built.py to report completion; JARVIS
then releases its held approval through the normal flow, which may switch ads.
The report-built tool and JARVIS board core are existing dependencies, not changed
or bundled by this release.

Verification performed in this integration phase:
- Seven interface unit tests passed, including both argument orders, safe default,
  prepare-only dispatch, invalid input, required output and no overwrite.
- Live inspect: HTTP 200, no form ID and created=false.
- Live create --prepare-only: HTTP 200, effective operation inspect, created=false.
- Live read: HTTP 404, no new form.
- No actual form/photo creation, mapping, ad write or approval release.
- Foundation acceptance separately passed 38 fixtures and 37 read/source checks.
  Live create/native POST/replay recovery remain intentionally deferred to the
  approved first buildform card. Do not advertise those as live-tested.

Source layout:
- tools/metacore_form_create.py: thin CLI interface.
- crew/lead_form_build.py: existing reviewed approval/auth client.
- supabase/functions/lead-form-build/: deployed generic function and fixture tests.
- supabase/functions/_shared/: its source dependencies from the released package.
- docs/lead-form-build/: scoped Vector and Forge SOUL additions, not entire SOULs.

The PC's actual SOUL files were backed up before adding these sections. No Hermes
configuration, root dashboard Python or unrelated working-tree file was changed.
Do not deploy on push. This is a non-deploying review branch. No GitHub Actions
workflow exists in the cloned base. Deployment remains a separately consented
operation using the MetaCore Supabase release process.

Recovery reference on this PC:
C:/jarvis-dashboard/crew/lead-form-build-t_6ccc1dff/README.txt
