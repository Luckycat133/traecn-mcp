# traecn-mcp: reconcile the existing Glama listing

This is a maintenance handoff, not authorization to create another hosted product. Historical Glama URLs may retain the old repository slug. Resolve the existing listing from `docs/CHANNEL-LEDGER.md` and the authenticated maintainer account; do not assume a new URL exists after a GitHub rename.

## Preflight

- Confirm current public source `Luckycat133/traecn-mcp` and record the exact inspected commit.
- Inspect the existing package/Release identity and generated Dockerfile/metadata at that commit. New display names must not point to nonexistent renamed assets.
- Preserve legacy package/registry names where they are still the working compatibility path.
- Check the current ledger for a prior hosted-release removal request or failed install. Reverify the actual page instead of repeating an old request as a new fact.
- Code/package changes belong in canonical templates and builders, then generated distribution. Never patch runtime Skill bytes independently.

## Browser procedure

1. Sign in using the already authorized account and locate the existing listing by repository, owner or recorded URL.
2. Record its current listing ID, display name, source URL and install command before changing fields.
3. Update visible product naming to `traecn-mcp` and source links to the current repository. Preserve an immutable listing slug when renaming it would break existing installs.
4. Refresh ownership metadata/claim only when required by the actual UI. Do not grant unrelated scopes or change repository visibility.
5. Trigger the current sync action; record the observed revision rather than assuming the button means sync completed.
6. Inspect README, license, runtime/platform description, entry point and exact 20 tools.
7. If a private build is needed, use the matching public artifact and recorded checksum. Schema inspection may run without Trae; do not enable mock answers to imply real desktop access.
8. Do not publish a cloud-hosted release just to raise a score. A container cannot transparently operate the user's local Mac.
9. Save actionable field/build errors with their canonical owner. Verify the public page after changes, not merely the edit form.

## Report

```text
Existing listing URL / ID:
Observed source commit:
Visible product name and source URL:
Retained compatibility slugs/package names:
Artifact version and checksum:
Generated installation command:
Ownership/sync state:
Tool count and exact contract check:
Schema-build outcome:
Real Mac task tested: no / exact separate evidence
Remaining blocker and next action:
```

No credentials or unrelated account data in the report. Do not mark pending review as verified. A new listing is a last resort only when the existing identity cannot be reconciled and the maintainer approves that migration.
