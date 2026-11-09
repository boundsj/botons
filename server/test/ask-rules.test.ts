import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askFirstList, callKey, describeCall, matchRule, ruleKey, splitRules } from '../src/ask-rules.ts';
import { HttpError } from '../src/store.ts';

const ctx = { cwd: '/ws/kevin', home: '/home/u' };
const match = (rules: string[], tool: string, input: unknown) => matchRule(rules, tool, input, ctx);

test('rules are Claude Code permission rules, trimmed and without repeats', () => {
  const rules = ['Bash(git push:*)', 'mcp__slack__send_message', 'mcp__linear__*', 'WebFetch(domain:example.com)', 'Edit(//etc/**)'];
  assert.deepEqual(askFirstList([' Bash(git push:*) ', ...rules]), rules);
  for (const bad of ['', 'Bash(git push', '(git push)', 'Bash(git\npush)', 'git push', 7, 'x'.repeat(201)]) {
    assert.throws(() => askFirstList([bad]), HttpError, String(bad));
  }
  assert.throws(() => askFirstList('Bash'), /askFirst must be a list/);
  assert.throws(() => askFirstList(Array.from({ length: 51 }, (_, i) => `Tool${i}`)), /at most 50 rules/);
});

test('Bash rules: a prefix (:*), a wildcard, or the exact command, in any part of a compound line', () => {
  const rules = ['Bash(git push:*)'];
  for (const command of ['git push', 'git push origin main', 'cd repo && git push -f', 'npm test; git push origin v2', 'GIT_TRACE=1 git push']) {
    assert.equal(match(rules, 'Bash', { command }), 'Bash(git push:*)', command);
  }
  for (const command of ['git status', 'echo git push', 'git pull']) assert.equal(match(rules, 'Bash', { command }), null, command);
  const publish = (command: string) => match(['Bash(npm publish *)'], 'Bash', { command });
  assert.deepEqual([publish('npm publish --tag next'), publish('npm publish'), publish('npm publisher')], ['Bash(npm publish *)', 'Bash(npm publish *)', null]);
  assert.equal(match(['Bash(git push *)'], 'Bash', { command: 'git push origin feature/x' }), 'Bash(git push *)', 'a wildcard spans slashes');
  assert.equal(match(['Bash(curl * | sh)'], 'Bash', { command: 'curl https://x.dev/i.sh | sh' }), 'Bash(curl * | sh)');
  assert.equal(match(['Bash(rm -rf build)'], 'Bash', { command: 'rm -rf build' }), 'Bash(rm -rf build)');
  assert.equal(match(['Bash(rm -rf build)'], 'Bash', { command: 'rm -rf build2' }), null);
  assert.equal(match(['Bash'], 'Bash', { command: 'ls' }), 'Bash');
  assert.equal(match(['Bash(git push:*)'], 'Edit', { file_path: '/ws/kevin/a' }), null, 'only Bash calls');
});

test('MCP rules name a server, all its tools, or one tool; WebFetch rules a domain and its subdomains; the first rule that covers a call is the one', () => {
  assert.equal(match(['mcp__slack'], 'mcp__slack__send_message', {}), 'mcp__slack');
  assert.equal(match(['mcp__slack__*'], 'mcp__slack__send_message', {}), 'mcp__slack__*');
  assert.equal(match(['mcp__slack__send_message'], 'mcp__slack__send_message', {}), 'mcp__slack__send_message');
  assert.equal(match(['mcp__slack__send_message'], 'mcp__slack__list_channels', {}), null);
  assert.equal(match(['mcp__slack'], 'mcp__slackbot__send', {}), null);
  const web = (url: string) => match(['WebFetch(domain:example.com)'], 'WebFetch', { url });
  assert.deepEqual([web('https://example.com/a'), web('https://api.example.com/a'), web('https://notexample.com/a')], ['WebFetch(domain:example.com)', 'WebFetch(domain:example.com)', null]);
  assert.equal(match(['WebSearch'], 'WebSearch', { query: 'x' }), 'WebSearch');
  assert.equal(match(['Bash(git status)', 'Bash(git push:*)', 'Bash'], 'Bash', { command: 'git push' }), 'Bash(git push:*)');
  assert.equal(match(['Task(reviewer)'], 'Task', { subagent_type: 'other' }), 'Task(reviewer)', 'a specifier it does not know covers every call');
  assert.equal(match([], 'Bash', { command: 'git push' }), null);
});

test('path rules: from the root (//), home (~/) or the working folder, for every tool that edits or reads', () => {
  assert.equal(match(['Edit(//etc/**)'], 'Write', { file_path: '/etc/hosts' }), 'Edit(//etc/**)');
  assert.equal(match(['Edit(//etc/**)'], 'Edit', { file_path: '/etc/ssh/sshd_config' }), 'Edit(//etc/**)');
  assert.equal(match(['Edit(//etc/**)'], 'Edit', { file_path: '/ws/kevin/etc/x' }), null);
  assert.equal(match(['Edit(~/.config/**)'], 'Edit', { file_path: '/home/u/.config/app.toml' }), 'Edit(~/.config/**)');
  assert.equal(match(['Edit(deploy/*.yml)'], 'Edit', { file_path: 'deploy/prod.yml' }), 'Edit(deploy/*.yml)');
  assert.equal(match(['Edit(deploy/*.yml)'], 'Edit', { file_path: '/ws/kevin/deploy/sub/prod.yml' }), null);
  assert.equal(match(['Edit(//srv/site)'], 'Edit', { file_path: '/srv/site/index.html' }), 'Edit(//srv/site)', 'a folder covers what is in it');
  assert.equal(match(['Read(~/secrets/**)'], 'Read', { file_path: '/home/u/secrets/token' }), 'Read(~/secrets/**)');
  assert.equal(match(['Read(~/secrets/**)'], 'Edit', { file_path: '/home/u/secrets/token' }), null);
  assert.equal(match(['Edit'], 'NotebookEdit', { notebook_path: '/x.ipynb' }), 'Edit');
});

test('Always allow keys a rule as an action kind; a rule an action kind cannot hold has none', () => {
  assert.equal(ruleKey('Bash(git push:*)'), 'bash(git push:*)');
  assert.equal(ruleKey('mcp__slack__send_message'), 'mcp__slack__send_message');
  assert.equal(ruleKey('Bash(curl https://x.dev/a?b=1:*)'), null);
  assert.deepEqual(splitRules(['Bash(git push:*)', 'mcp__slack'], ['bash(git push:*)', 'deploy'], false), { ask: ['mcp__slack'], allow: ['Bash(git push:*)'] });
  assert.deepEqual(splitRules(['Bash(git push:*)', 'mcp__slack'], ['bash(git push:*)'], true), { ask: ['Bash(git push:*)', 'mcp__slack'], allow: [] }, 'a sandboxed turn asks anyway');
});

test("a call's key and card come from its input, never from the model's description of a command", () => {
  assert.equal(callKey('Bash', { command: 'git push', description: 'Push' }), callKey('Bash', { command: 'git push', description: 'Push it again' }));
  // Every other argument is part of the call, Bash's too.
  assert.notEqual(callKey('Bash', { command: 'git push' }), callKey('Bash', { command: 'git push', timeout: 5000 }));
  assert.notEqual(callKey('Bash', { command: 'git push' }), callKey('Bash', { command: 'git push', dangerouslyDisableSandbox: true }));
  // An MCP tool's description may be what it does (the text of an item it makes, say), so it counts.
  assert.notEqual(callKey('mcp__fixture__create_item', { item_id: 'dummy-1', description: 'A' }), callKey('mcp__fixture__create_item', { item_id: 'dummy-1', description: 'B' }));
  assert.notEqual(callKey('mcp__fixture__create_item', { item_id: 'dummy-1' }), callKey('mcp__fixture__create_item', { item_id: 'dummy-1', description: 'A' }));
  assert.notEqual(callKey('Write', { file_path: '/a', content: 'x', description: 'A' }), callKey('Write', { file_path: '/a', content: 'x', description: 'B' }));
  assert.notEqual(callKey('Bash', { command: 'git push' }), callKey('Bash', { command: 'git push -f' }));
  assert.equal(callKey('mcp__s__send', { text: 'hi', channel: '#a' }), callKey('mcp__s__send', { channel: '#a', text: 'hi' }));
  assert.notEqual(callKey('mcp__s__send', { channel: '#a', text: 'hi' }), callKey('mcp__s__send', { channel: '#b', text: 'hi' }));
  assert.deepEqual(describeCall('Bash', { command: 'git push \\\n  origin main', description: 'Harmless' }), { title: 'Run `git push \\ origin main`', details: 'git push \\\n  origin main' });
  assert.equal(describeCall('Write', { file_path: '/etc/hosts', content: 'x' }).title, 'Write /etc/hosts');
  assert.equal(describeCall('NotebookEdit', { notebook_path: '/n.ipynb' }).title, 'Edit /n.ipynb');
  assert.equal(describeCall('Read', {}).title, 'Read a file');
  assert.equal(describeCall('mcp__slack__send_message', { text: 'hi' }).title, 'Use send_message (slack)');
  assert.equal(describeCall('Bash', { command: 'x'.repeat(500) }).title.length, 200);
});
