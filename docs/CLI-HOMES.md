# Botons-owned CLI homes

Botons must not start with its owner's CLI instructions, skills, plugins or MCP configuration.
Use `BOTONS_HOME/cli/codex` (`CODEX_HOME`) and `BOTONS_HOME/cli/claude`
(`CLAUDE_CONFIG_DIR`) for turns, probes, login and updates. Directory selection belongs
in one module, not individual providers. New directories are private (0700).

Compatibility: when only personal file credentials exist, turns and probes retain
that personal home until the owner acts. Login always targets the isolated home.
Never copy secrets on upgrade. Brains offers “Use your existing Codex sign-in for
Botons” (explicit paired-owner confirmation, auth.json only, audit before copying)
or “Sign in separately”. Import uses exclusive creation and rejects symlink files.
No instructions, settings, skills, MCP definitions or history are imported. Switching
homes may invalidate old resume IDs; existing session recovery should start fresh.
A running process retains its chosen environment until it ends.

We accept temporary personal-home configuration exposure to preserve unattended operation; doctor
must explain the next step. Replacing personal symlinks is no longer a setup task.
Keep personal-home doctor repair available. Copying all configuration loses isolation;
silently copying credentials violates consent; forcing logout breaks unattended upgrades.

Official references checked 2026-11-07:
- https://learn.chatgpt.com/docs/auth?surface=cli (CODEX_HOME/auth.json; keychain also possible)
- https://code.claude.com/docs/en/settings (CLAUDE_CONFIG_DIR)

Verify file-based login paths with installed CLIs. Keychain-only personal credentials
need explicit separate login; do not export keychain secrets automatically. Preserve
existing sandbox filtering as defense in depth. Test fresh isolation, personal symlinks,
personal-home fallback, consent/import races, guided login, probes, and update environments.
First implementation: central home policy and credential-only migration API, then
plain-language Brains controls and CLI login wrapper.
