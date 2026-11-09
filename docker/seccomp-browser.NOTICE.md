# Browser seccomp profile

`seccomp-browser.json` derives from Moby profiles, licensed under Apache-2.0.
The upstream license is included in [LICENSE.seccomp-browser](LICENSE.seccomp-browser).

Source: https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json

Botons modifies the profile with three additional rules: ordinary `clone`,
`s390` argument-layout `clone`, and `unshare`. These permit Chromium to create
user, PID and network namespaces without adding capabilities. The `unshare`
rule also forbids time namespaces; clone retains its separate low signal-bit
semantics. All upstream syscall rules are retained.

The application remains MIT licensed; the vendored profile retains its
Apache-2.0 license.
