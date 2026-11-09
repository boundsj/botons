import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliInstaller } from '../src/cli-install.ts';
import { managedBin, managedRoot } from '../src/managed-clis.ts';
import { loadConfig } from '../src/config.ts';
import { startServer, until } from './helpers.ts';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'botons-cli-install-'));
  const root = join(home, 'managed');
  let selected = '/usr/local/bin/codex';
  const phases: string[] = [];
  let runs = 0;
  const service = new CliInstaller({home,root,node:process.execPath,current:()=>selected,activate:(_id,bin)=>{selected=bin;},maintain:run=>run(),run:async(cmd,args)=>{runs++;assert.equal(cmd,process.execPath);assert.ok(args.includes('@openai/codex@latest'));},verify:async()=>{}});
  return {home,root,service,phases,selected:()=>selected,runs:()=>runs,cleanup:()=>rmSync(home,{recursive:true,force:true})};
}

test('system CLI upgrade installs immutable managed copy only after exact-command consent and records the switch', async () => {
  const f=fixture();
  try {
    const plan=f.service.review('codex-cli');
    assert.ok(plan.available); assert.ok(!plan.command.includes('sudo'));
    assert.match(plan.command, /@openai\/codex@latest/);
    await assert.rejects(f.service.install('codex-cli',plan.command,false,()=>{}),/confirm/);
    await assert.rejects(f.service.install('codex-cli','other',true,()=>{}),/confirm/);
    assert.equal(f.runs(),0); assert.equal(existsSync(f.root),false);
    await f.service.install('codex-cli',plan.command,true,phase=>f.phases.push(phase));
    assert.equal(f.runs(),1);assert.deepEqual(f.phases,['started','succeeded']);assert.equal(f.selected(),plan.bin);
    assert.equal(managedBin(f.home,'codex-cli','/usr/local/bin/codex',f.root),plan.bin);
    assert.equal(managedBin(f.home,'codex-cli','/custom/codex',f.root),'/custom/codex','a later explicit override wins');
    const next=f.service.review('codex-cli');assert.notEqual(next.bin,plan.bin,'updates never overwrite an active binary');

  } finally {await f.service.close();f.cleanup();}
});

test('verification failure or audit refusal preserves selected CLI and persistent configuration', async () => {
  const f=fixture();
  try {
    let runs=0;
    const service=new CliInstaller({home:f.home,root:f.root,node:process.execPath,current:()=>'/system/codex',activate:()=>assert.fail('cannot switch'),maintain:run=>run(),run:async()=>{runs++;},verify:async()=>{throw new Error('incompatible');}});
    let plan=service.review('codex-cli');
    await assert.rejects(service.install('codex-cli',plan.command,true,()=>{throw new Error('audit unavailable');}),/audit/);assert.equal(runs,0);
    plan=service.review('codex-cli');
    await assert.rejects(service.install('codex-cli',plan.command,true,p=>f.phases.push(p)),/incompatible/);
    assert.deepEqual(f.phases,['started','failed']);assert.equal(existsSync(join(f.home,'managed-clis.json')),false);
    await service.close();
  } finally {f.cleanup();}
});

test('managed directory symlink is refused before the installer runs', async () => {
  const f=fixture();
  try {
    const other=join(f.home,'other');mkdirSync(other);symlinkSync(other,f.root);
    const plan=f.service.review('codex-cli');
    await assert.rejects(f.service.install('codex-cli',plan.command,true,()=>{}),/symlink/);assert.equal(f.runs(),0);
  } finally {await f.service.close();f.cleanup();}
});

test('paired owner action validates consent, audits and activates; unpaired/boton tokens cannot install', async () => {
  const home=mkdtempSync(join(tmpdir(),'botons-cli-api-'));let runs=0;
  const s=await startServer({home,appOptions:{cliInstaller:{root:join(home,'managed'),node:process.execPath,run:async()=>{runs++;},verify:async()=>{}}}});
  try {
    const plans=(await s.call('GET','/api/brain-clis')).data.installs;const plan=plans.find((p:any)=>p.provider==='codex-cli');
    assert.equal((await s.call('POST','/api/brain-clis/codex-cli/install',{consent:true,command:plan.command},null)).status,401);
    const bot=await s.newBot('Dave'); const turn=s.app.auth.mintBotonToken(bot.id);
    assert.equal((await s.call('POST','/api/brain-clis/codex-cli/install',{consent:true,command:plan.command},turn.token)).status,403);turn.revoke();
    assert.equal((await s.call('POST','/api/brain-clis/codex-cli/install',{command:plan.command})).status,400);
    assert.equal((await s.call('POST','/api/brain-clis/codex-cli/install',{consent:true,command:'stale'})).status,409);
    assert.equal(runs,0);
    const result=await s.call('POST','/api/brain-clis/codex-cli/install',{consent:true,command:plan.command});
    assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(runs,1);assert.equal(s.cfg.codexBin,plan.bin);
    const audit=JSON.stringify((await s.call('GET','/api/audit')).data);assert.ok(audit.includes('brain.cli_install_started'));assert.ok(audit.includes('brain.cli_install_succeeded'));
  } finally {await s.stop();rmSync(home,{recursive:true,force:true});}
});

test('maintenance drains active turns without interrupting, holds new work, and resumes after install failure', async () => {
  const s=await startServer();
  let release!:()=>void;let installed=false;
  try {
    s.mock.script=async()=>{if(s.mock.turns.length===1)await new Promise<void>(r=>{release=r;});return 'done';};
    const a=await s.newBot('Kevin');const b=await s.newBot('Stuart');
    await s.call('POST',`/api/bots/${a.id}/messages`,{text:'first'});await until(()=>s.mock.turns.length===1);
    const operation=s.app.engine.maintain(async()=>{installed=true;throw new Error('installer failure');});
    const rejected=assert.rejects(operation,/installer failure/);
    await s.call('POST',`/api/bots/${b.id}/messages`,{text:'queued'});
    assert.equal(installed,false);assert.equal(s.mock.turns.length,1);
    release();await rejected;await until(()=>s.mock.turns.length===2);
    assert.equal(installed,true);
  } finally {release?.();await s.stop();}
});

test('shutdown cancels the installer, serializes concurrent clicks, and never switches a partial install', async () => {
  const f=fixture();let began!:()=>void;const started=new Promise<void>(r=>{began=r;});
  const service=new CliInstaller({home:f.home,root:f.root,node:process.execPath,current:()=>'/system/codex',activate:()=>assert.fail('cannot switch partial install'),maintain:run=>run(),run:async(_cmd,_args,signal)=>{began();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));},verify:async()=>{}});
  try {
    const plan=service.review('codex-cli');const operation=service.install('codex-cli',plan.command,true,()=>{});const rejection=assert.rejects(operation,/aborted/);await started;
    await assert.rejects(service.install('codex-cli',plan.command,true,()=>{}),/already running/);
    await service.close();await rejection;assert.equal(existsSync(join(f.home,'managed-clis.json')),false);
  }finally{await service.close();f.cleanup();}
});

test('server and doctor config reuse the selected managed copy on restart while a new explicit override wins', () => {
  const home=mkdtempSync(join(tmpdir(),'botons-cli-restart-'));
  try {
    const bin=join(managedRoot(home),'clis/codex-cli/releases/release-1/bin/codex');
    writeFileSync(join(home,'managed-clis.json'),JSON.stringify({'codex-cli':{bin,previous:'/usr/local/bin/codex'}}));
    const env={HOME:home,BOTONS_HOME:home,BOTONS_NO_TAILSCALE:'1',BOTONS_CODEX_BIN:'/usr/local/bin/codex'};
    assert.equal(loadConfig(env).codexBin,bin);
    assert.equal(loadConfig({...env,BOTONS_CODEX_BIN:'/custom/codex'}).codexBin,'/custom/codex');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('a drain timeout never runs the installer or interrupts the active turn', async () => {
  const s=await startServer();let release!:()=>void;
  try {
    let interrupted=false;
    s.mock.script=async req=>{await new Promise<void>(r=>{release=r;});interrupted=req.signal.aborted;return 'done';};
    const bot=await s.newBot('Bob');await s.call('POST',`/api/bots/${bot.id}/messages`,{text:'work'});await until(()=>s.mock.turns.length===1);
    await assert.rejects(s.app.engine.maintain(async()=>assert.fail('must wait for active turn'),0),/still finishing/);
    assert.equal(s.mock.turns[0].signal.aborted,false);release();await s.untilState(bot.id,'idle');assert.equal(interrupted,false);
  }finally{release?.();await s.stop();}
});

test('release cleanup preserves selected copy, system files, unrelated directories and symlink targets', async () => {
  const { pruneManagedReleases } = await import('../src/managed-clis.ts');
  const f=fixture();
  try {
    const releases=join(f.root,'clis/codex-cli/releases');
    const old=join(releases,'11111111-1111-1111-1111-111111111111');
    const current=join(releases,'22222222-2222-2222-2222-222222222222/bin/codex');
    mkdirSync(old,{recursive:true});writeFileSync(join(old,'old'),'old');mkdirSync(join(releases,'notes'));
    mkdirSync(join(releases,'22222222-2222-2222-2222-222222222222/bin'),{recursive:true});writeFileSync(current,'binary');
    const other=join(f.home,'system');mkdirSync(other);writeFileSync(join(other,'keep'),'system');symlinkSync(other,join(releases,'33333333-3333-3333-3333-333333333333'));
    pruneManagedReleases(f.root,'codex-cli',join(other,'keep'));assert.equal(existsSync(old),true);
    pruneManagedReleases(f.root,'codex-cli',current);
    assert.equal(existsSync(old),false);assert.equal(existsSync(current),true);assert.equal(existsSync(join(releases,'notes')),true);assert.equal(readFileSync(join(other,'keep'),'utf8'),'system');
  }finally{f.cleanup();}
});

for (const via of ['release', 'bin', 'executable'] as const) {
  test(`cleanup retains an in-tree backing release reached through a selected ${via} symlink`, async () => {
    const { pruneManagedReleases } = await import('../src/managed-clis.ts');
    const f=fixture();
    try {
      const releases=join(f.root,'clis/codex-cli/releases');
      const a=join(releases,'11111111-1111-1111-1111-111111111111');
      const b=join(releases,'22222222-2222-2222-2222-222222222222');
      mkdirSync(join(b,'bin'),{recursive:true});writeFileSync(join(b,'bin/codex'),'selected binary');
      if(via==='release')symlinkSync(b,a);
      else if(via==='bin'){mkdirSync(a);symlinkSync(join(b,'bin'),join(a,'bin'));}
      else {mkdirSync(join(a,'bin'),{recursive:true});symlinkSync(join(b,'bin/codex'),join(a,'bin/codex'));}
      pruneManagedReleases(f.root,'codex-cli',join(a,'bin/codex'));
      assert.equal(readFileSync(join(a,'bin/codex'),'utf8'),'selected binary');
      assert.equal(existsSync(join(b,'bin/codex')),true);
    }finally{f.cleanup();}
  });
}

test('a publisher executable symlink within its own release still permits safe cleanup', async () => {
  const { pruneManagedReleases } = await import('../src/managed-clis.ts');const f=fixture();
  try {
    const releases=join(f.root,'clis/codex-cli/releases');
    const a=join(releases,'11111111-1111-1111-1111-111111111111');const b=join(releases,'22222222-2222-2222-2222-222222222222');
    mkdirSync(join(a,'bin'),{recursive:true});mkdirSync(join(a,'lib'));writeFileSync(join(a,'lib/codex'),'publisher binary');symlinkSync('../lib/codex',join(a,'bin/codex'));mkdirSync(b);
    pruneManagedReleases(f.root,'codex-cli',join(a,'bin/codex'));assert.equal(readFileSync(join(a,'bin/codex'),'utf8'),'publisher binary');assert.equal(existsSync(b),false);
  }finally{f.cleanup();}
});
