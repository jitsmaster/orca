# SignPath Foundation application — draft (jitsmaster/orca fork)

Not submitted. Drafted from this repo's actual Windows build/CI setup so the
project owner can review, adjust, and submit at
[signpath.org/apply](https://signpath.org/apply). The application form itself
is JS-rendered and did not expose its exact field list or eligibility
criteria to a non-interactive fetch, so treat the structure below as content
to adapt to whatever fields the live form actually asks for — not a literal
transcription of the form.

## Project identity

- **Project name:** Orca (fork build)
- **Repository:** https://github.com/jitsmaster/orca
- **Upstream repository:** https://github.com/stablyai/orca (this is a public
  fork; upstream already has its own SignPath Foundation certificate — see
  "Relationship to upstream's existing certificate" below, this is the open
  question that needs resolving with SignPath directly before or during
  application).
- **License:** MIT (per this repo's `README.md`/root license file).
- **Project description:** Orca is an Electron-based IDE for orchestrating
  multiple parallel coding-agent CLIs (Claude Code, Codex, etc.), each in its
  own git worktree, with a companion mobile app. Desktop targets macOS,
  Windows, and Linux.

## Why signing is being requested

The fork publishes its own unsigned Windows installer builds via a dedicated
GitHub Actions workflow
([`fork-win-release.yml`](../../.github/workflows/fork-win-release.yml)),
separate from upstream's signed dev-channel/release pipeline (upstream's
SignPath-based signing is not accessible to fork maintainers — see that
workflow's header comment: _"The upstream dev-channel workflow targets
stablyai's orca-\* repos with app tokens we do not have"_). Unsigned installer
builds are being flagged by endpoint security software (Sophos "Application
Lockdown") on install; see
[`windows-sophos-lockdown-installer.md`](./windows-sophos-lockdown-installer.md)
for the underlying research. Signing is the standard, admin-recommended path
to allow-list the build by certificate.

## Build process summary (for SignPath's CI-integration review)

- **CI platform:** GitHub Actions, `windows-2022` runner.
- **Build tool:** `electron-builder` via `pnpm exec electron-builder --config
  config/electron-builder.config.cjs --win`
  ([`config/electron-builder.config.cjs`](../../config/electron-builder.config.cjs)).
- **Installer target:** NSIS (`orca-windows-setup.exe`), configured under the
  `nsis:` block of that config file.
- **Existing signing hook shape:** electron-builder's
  `win.signtoolOptions.sign` is already wired to a relay function,
  `signWindowsUninstallerViaSignPath`
  ([`config/scripts/windows-uninstaller-signing.cjs`](../../config/scripts/windows-uninstaller-signing.cjs)),
  which today only handles the NSIS-embedded uninstaller sub-binary via an
  export/re-import relay around a human-approved SignPath request — it does
  not currently sign the main installer or app binaries for this fork's
  build. Any new SignPath integration for the fork would need its own
  signing credentials wired into this same hook point (`win:` block of
  `electron-builder.config.cjs`), not a parallel signing mechanism, per this
  repo's own "reuse before reimplementing" convention.
- **No committed secrets/keys:** the current relay mechanism explicitly holds
  no certificate material in the repo; signing happens out-of-band via
  SignPath's own request/approval flow, consistent with SignPath's stated
  HSM-based model (no private key ever leaves SignPath's infrastructure).

## Relationship to upstream's existing certificate

This is the key open question, unresolved by the sources checked:

- Upstream (`stablyai/orca`) already has a SignPath Foundation certificate
  (`CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US`,
  per
  [`windows-edr-posture.md:346-349`](./windows-edr-posture.md#L346-L349)).
- It is unclear whether:
  1. A fork repository (`jitsmaster/orca`) can apply for and receive its
     **own independent** SignPath Foundation project/certificate, tied to the
     fork's own repository identity, or
  2. The fork would need to be added as an additional signing target/build
     definition under the **existing** `stablyai/orca` SignPath project,
     which would require coordination with whoever administers that project
     upstream (fork maintainers do not currently have that access, per the
     `fork-win-release.yml` header comment quoted above).
- **Recommendation before submitting:** ask this question directly in the
  application's free-text/notes field, or via SignPath's contact channel,
  rather than assuming either answer. If (2) is required, submitting this
  application may need upstream maintainer involvement rather than being a
  fork-only decision.

## What to prepare before submitting

- Confirm who at `jitsmaster/orca` will hold the SignPath.io account/CI
  integration (this affects the GitHub Actions secret/token setup on the
  fork's side, separate from `stablyai/orca`'s).
- Have `fork-win-release.yml`'s workflow file ready to link/reference — most
  free code-signing programs for OSS want to see the actual CI config that
  will call the signing service.
- Decide whether to request signing for `fork-win-release.yml`'s installer
  only, or eventually also `dist/orca-windows-setup.exe`'s inner binaries
  (`Orca.exe`, the daemon host, etc.) — the current relay hook only covers
  the uninstaller; signing everything would need broader wiring in
  `config/electron-builder.config.cjs`'s `win:` block.
