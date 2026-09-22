# Sophos "Lockdown" blocking the unsigned fork installer

## What the user saw

Installing `orca-windows-setup.exe` from a fork release (built by
[`fork-win-release.yml`](../../.github/workflows/fork-win-release.yml), unsigned
— see that workflow's own header comment for why) triggers:

> **'Lockdown' malicious behavior prevented in Next-gen IDE for parallel agentic
> development.**

Sophos closes the installer, notifies the user, and generates a threat graph.
No file was quarantined; nothing was removed from disk.

## What "Lockdown" actually is

Per Sophos's own documentation
([Deal with application lockdown events](https://docs.sophos.com/central/customer/help/en-us/ManageYourProducts/Alerts/ThreatAdvice/ApplicationLockdownAdvice/)):

> "The application lockdown feature stops attacks that abuse legitimate features
> in commonly-used applications to perform an attack or launch malware. When an
> application under lockdown does something prohibited, such as **installing
> other software or changing system settings**, Sophos Endpoint automatically
> closes the application."

This is Sophos's HIPS-style exploit-mitigation engine, not its signature/
reputation scanner. It watches a fixed set of "commonly-abused" application
categories — installers/setup executables are one — for specific *behaviors
during execution*: spawning child processes, writing to protected locations,
modifying the registry, swapping out an uninstaller. It does not primarily
evaluate the file's Authenticode signature or SmartScreen reputation; the
remediation path Sophos documents
([Stop detecting an application](https://docs.sophos.com/central/customer/help/en-us/ManageYourProducts/Alerts/ThreatAdvice/FalsePositive/StopDetectingApp/))
is an **admin-side allowlist** by certificate, SHA-256, or install path — not a
build-side toggle.

## Why this installer trips it

`orca-windows-setup.exe` is an NSIS-built Electron installer doing exactly the
category of thing Lockdown watches installers for:

- It writes files under Program Files/AppData and creates registry Run/
  Uninstall keys — ordinary NSIS install behavior, but exactly the "installing
  other software or changing system settings" pattern the feature is built to
  catch.
- `config/nsis/orca-installer-hooks.nsh` runs an uninstaller-swap and
  relocated-daemon cleanup sweep during update — the same shape
  [`windows-edr-posture.md`](./windows-edr-posture.md#L36) already documents
  Microsoft Defender for Endpoint flagging independently, as its "update
  cluster" (`orca-windows-setup.exe` → `old-uninstaller.exe`,
  `Uninstall Orca.exe`).

That EDR-posture document's central finding, proven against Defender on this
exact codebase, is directly relevant here even though Sophos is a different
product:

> **"Antigravity IDE's main executable is `NotSigned` and was not flagged,
> while Orca's is signed and was flagged six times... signing is not the gate
> here — behaviour is."**
> ([`windows-edr-posture.md:339-341`](./windows-edr-posture.md#L339-L341))

Read literally, that finding says behavior dominates over signing for
Defender's process-tree scoring. It does **not** prove the same for Sophos
Lockdown, which is a narrower, installer-specific behavioral trigger with a
different detection surface. What *is* true regardless of mechanism: this
fork's build (via `fork-win-release.yml`) is both unsigned and has zero
install-base prevalence (every release ships a new file hash with no
accumulated reputation) — both are real, independently plausible contributing
factors that a code change can actually address, unlike the installer's core
NSIS behavior, which cannot be removed without breaking install/update.

## What fixes this

### For the affected user, right now (admin-side, no code change)

Per Sophos's documented false-positive workflow
([Stop detecting an application](https://docs.sophos.com/central/customer/help/en-us/ManageYourProducts/Alerts/ThreatAdvice/FalsePositive/StopDetectingApp/)),
a Sophos Central admin can allow the installer by:

- **Certificate** (recommended once the build is signed — also covers future
  builds sharing that certificate).
- **SHA-256** (covers only this exact build; a new release needs a new entry).
- **Path** (covers the install location regardless of file identity).

**Path exclusions alone are not equivalent to an allow-list entry for a
behavioral engine** — this mirrors the same trap
[`windows-edr-posture.md`](./windows-edr-posture.md#L406-L413) documents for
Defender EDR: an AV path exclusion suppresses *scan* detections, not
behavioral-engine interventions. Use Sophos's own per-detection "Allow this
application" flow (Certificate/SHA-256/Path in the event details dialog), not
a generic folder exclusion.

### For the release build (code/process change, in flight)

Getting `fork-win-release.yml`'s installer actually signed is the lever within
reach of this repo. Two paths:

1. **SignPath Foundation** (what the upstream release channel already uses —
   see `win.signtoolOptions.publisherName` in
   [`config/electron-builder.config.cjs`](../../config/electron-builder.config.cjs#L428-L431)
   and the relay mechanism in
   [`windows-uninstaller-signing.cjs`](../../config/scripts/windows-uninstaller-signing.cjs)).
   Free for OSS, CI-integrated via HSM (no physical token), but the trust model
   ties the certificate to "verif[ying] that the binary was built from your
   open source repository" (signpath.org) — whether a *fork* repository
   qualifies independently, or needs to be added as a second target under the
   existing `stablyai/orca` SignPath project, is unresolved; the application
   form at [signpath.org/apply](https://signpath.org/apply) is JS-rendered and
   did not expose its eligibility criteria to a non-interactive fetch.
2. **A commercial OV/EV code-signing certificate.** Costs money; an OV cert
   alone does not immediately clear SmartScreen/reputation-based blocks either,
   since those also key on prevalence, not just signature validity.

Signing does not guarantee Lockdown stops firing — Sophos's own documentation
frames the feature around *behavior*, not signature — but it removes the
"unsigned, zero-prevalence" contributing factor and is a prerequisite for the
Certificate-based allowlist path above, which is Sophos's own recommended
remediation.

## What this document does not establish

- Whether signing alone resolves the Sophos Lockdown trigger specifically —
  unmeasured; no access to a real Sophos endpoint from this environment.
- SignPath Foundation's eligibility policy for a forked repository.
- Whether Sophos's installer-category Lockdown watch is configurable per-tenant
  (narrower or wider than the default) — not covered by the docs consulted
  here.

Update this document once a signing attempt or a Sophos-side test yields a
real verdict, per the framing in
[`windows-edr-posture.md`](./windows-edr-posture.md#L360-L374): record what
was actually measured, not what seems plausible.
