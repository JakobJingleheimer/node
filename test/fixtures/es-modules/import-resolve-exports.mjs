import { strictEqual } from 'assert';

try {
  const resolved = import.meta.resolve('pkgexports-sugar');
  strictEqual(typeof resolved, 'string');
} catch(e) {
  console.error(e);
  process.exit(1);
}
