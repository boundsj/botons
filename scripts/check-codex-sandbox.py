"""Credential-free Linux helper regression. Supply three absolute Codex binaries.

Use PATH to select bubblewrap. Requires user/mount namespaces and bubblewrap 0.12.0.
No model endpoint, login, or existing CLI home is used. Only disposable fixtures run.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

assert len(sys.argv) == 4, 'Usage: python3 scripts/check-codex-sandbox.py CODEX_160 CODEX_166 CODEX_167'
assert subprocess.check_output(['bwrap', '--version'], text=True).strip() == 'bubblewrap 0.12.0'
with tempfile.TemporaryDirectory(prefix='botons-codex-', dir='/var/tmp') as tmp:
    root = Path(tmp)
    home, workspace, shared = [root / name for name in ['home', 'workspace', 'shared']]
    for path in [home, workspace, shared]:
        path.mkdir()
    private = root / 'private.txt'
    private.write_text('private fixture')
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CODEX_HOME': str(home)}

    def run(binary, policy, command):
        args = [str(Path(binary).resolve()), 'sandbox', '-C', str(workspace), '-P', 'boton',
                '-c', 'permissions.boton.extends=":workspace"',
                '-c', 'permissions.boton.network.enabled=true',
                '-c', 'permissions.boton.filesystem=' + json.dumps(policy).replace(': ', '='),
                '--', '/bin/sh', '-c', command]
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=30)
        print(json.dumps({'binary': Path(binary).name, 'code': result.returncode,
                          'stdout': result.stdout, 'stderr': result.stderr}), flush=True)
        return result

    policy = {str(workspace / '.claude'): 'read', str(workspace / 'AGENTS.md'): 'read',
              str(private): 'none', str(shared): 'write'}
    command = f'''set -e
 touch normal.txt {shared}/normal.txt
 if cat {private} 2>/dev/null; then exit 12; fi
 if touch .claude 2>/dev/null; then exit 10; fi
 if touch AGENTS.md 2>/dev/null; then exit 11; fi
 echo WORKSPACE_OK'''
    old = run(sys.argv[1], policy, command)
    assert old.returncode != 0 and 'Bad file descriptor' in old.stderr
    for binary in sys.argv[2:]:
        result = run(binary, policy, command)
        assert result.returncode == 0 and 'WORKSPACE_OK' in result.stdout
    instructions = home / 'AGENTS.md'
    instructions.symlink_to(private)
    linked = run(sys.argv[3], {str(instructions): 'none'}, 'true')
    assert linked.returncode != 0 and "Can't mount on symlink destination" in linked.stderr
    instructions.unlink()
    instructions.write_text('reviewed fixture')
    assert run(sys.argv[3], {str(instructions): 'none'}, 'true').returncode == 0
