import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('handover certificates have valid positive serials for every leading-byte boundary', () => {
  const moduleUrl = new URL('../src/browser-cert.ts', import.meta.url).href;
  for (const serial of ['00010101010101010101010101010101', '00008001010101010101010101010101', '00000000000000000000000000000000', '01010101010101010101010101010101', '7f010101010101010101010101010101', '80010101010101010101010101010101', 'ff010101010101010101010101010101']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createSecureContext } from 'node:tls';
crypto.randomBytes = () => Buffer.from(${JSON.stringify(serial)}, 'hex');
syncBuiltinESMExports();
const { interceptCert } = await import(${JSON.stringify(moduleUrl)});
const pair = interceptCert();
createSecureContext({ key: pair.key, cert: pair.cert });
const cert = new crypto.X509Certificate(pair.cert);
assert.equal(cert.verify(cert.publicKey), true);
assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(pair.key)), true);
assert.ok(BigInt('0x' + cert.serialNumber) > 0n);
`, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, `${serial}: ${result.stderr}`);
  }
});
