import { Bridge } from '../src/bridge';
const root = process.argv[2]!, id = process.argv[3]!;
const bridge = new Bridge(id, root, root, root + '/missing.sock');
await bridge.close();
console.log('ok');
