// Preloaded into a server by process.test.ts: the first SIGUSR2 leaves a promise rejection unhandled; the second throws.
let faults = 0;
process.on('SIGUSR2', () => {
  faults++;
  if (faults === 1) void Promise.reject(new Error('test unhandled rejection'));
  else throw new Error('test uncaught exception');
});
