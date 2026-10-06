# macOS signing and privacy permissions

## Why signing decides whether grants survive an upgrade

macOS stores each privacy grant (Screen & System Audio Recording, Accessibility, Automation, ...) in the TCC
database together with a *code requirement* (`csreq`) taken from the app's designated requirement (DR) when the
grant was made. On every access the system checks that the running code satisfies that stored requirement.
Apple's DTS engineer puts it this way: "The signing identity is used as a component of the designated
requirement (DR), and TCC uses the DR to track whether build N+1 of your program is the same as build N"
([Apple Developer Forums, thread 707177](https://developer.apple.com/forums/thread/707177); background in
[TN3127 Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
and the [Code Signing Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html):
a `cdhash` test "unambiguously identifies one specific version", and with an ad-hoc signature there are no
certificates at all).

| How the build is signed | DR | Grant after an upgrade |
|---|---|---|
| ad-hoc / unsigned | `cdhash H"<hash of this build>"` | lost: the hash changes every build |
| fixed certificate (`AgentDeck Dev`) | `identifier "com.jinhao.agentdeck" and certificate leaf = H"5d8e641b…33d6"` | kept: identical for every version |

AgentDeck must therefore always be signed with the same certificate. The pinned identity is in
`build/signing-identity.json` and `package.json` (`build.mac.identity`).

## What can go wrong: electron-builder falls back to ad-hoc

If the `AgentDeck Dev` identity is not a valid identity in the keychain at build time (keychain locked or
reset, other user, CI), electron-builder 26 on macOS does **not** fail: `forceCodeSigning` is only enforced for
Windows and `.pkg`, so the app keeps Electron's ad-hoc signature and every privacy grant is lost on install.
The old screen-recording grant on the author's Mac is exactly this: it was created on 2026-06-07 from such an
ad-hoc build (the `AgentDeck Dev` certificate was only created on 2026-06-11) and stays bound to that build's cdhash.

## Guards in this repository

- `scripts/signing-check.js --identity`: fails unless the pinned certificate is a valid code-signing identity
  (runs in `scripts/release.js` before the build).
- `scripts/signing-check.js <App.app> [...]`: fails unless every app has exactly the pinned DR; several apps
  must all match (runs in `scripts/release.js` on the app inside the DMG, next to `codesign --verify`).
- `tests/signing-stability.test.js`: signs two throwaway versions with the pinned identity and shows the DR is
  identical and that a requirement stored from 1.0.0 accepts 1.0.1; signs two ad-hoc versions and shows the DR
  differs and the old requirement rejects the new build (the failure mode). The identity-based test is skipped
  where the identity is absent.

Manual check of any app: `codesign -d -r- /Applications/AgentDeck.app` or `node scripts/signing-check.js /Applications/AgentDeck.app`.

## Keep the certificate

The grant is bound to the certificate's SHA-1 (`5d8e641b…33d6`). A new certificate, even with the same name,
is a different identity and costs every grant once. Never recreate `AgentDeck Dev`; back up the identity
(Keychain Access → login → My Certificates → AgentDeck Dev → Export as .p12 with a password kept in the
password manager) so a keychain loss or a new Mac does not change the identity.

## Repairing one stale grant (needs the user)

A grant made by an old ad-hoc build keeps its cdhash requirement. Fix it once in System Settings → Privacy &
Security → Screen & System Audio Recording: select AgentDeck, click `−` (system asks for Touch ID or password),
click `+`, add `/Applications/AgentDeck.app`, turn it on, and choose Quit & Reopen if offered. The new grant
stores the stable DR. Do not use `tccutil reset`, which also clears other grants.
