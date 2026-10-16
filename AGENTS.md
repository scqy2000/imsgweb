# Repository Instructions

- This project is maintained independently at `scqy2000/imsgweb`.
- Commit, push, and open pull requests only in that repository. Use `origin/main`
  as the integration branch.
- Do not push to `PeronGH/imsgweb`, restore an upstream push target, or synchronize
  upstream changes unless the owner explicitly requests it.
- Preserve the original license and attribution. The `imsg/` submodule is a
  read-only reference dependency, not this application's development remote.
- Read `CLAUDE.md` for architecture, commands, and repository conventions.
- Before publishing, run checks and inspect staged files for credentials,
  Messages data, attachments, logs, and generated binaries. Do not publish them.
- Keep real Messages integration checks read-only unless the user explicitly
  requests a particular message or group mutation.
