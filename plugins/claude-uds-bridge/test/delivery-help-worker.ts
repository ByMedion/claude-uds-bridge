import { findPeer, peerAddress, sendFrames, userFrame } from '../src/claude';
import { withDeliveryHelp } from '../src/delivery-help';

const [configDir, stateDir, sessionId, text] = process.argv.slice(2);
if (!configDir || !stateDir || !sessionId || !text) throw new Error('Missing worker arguments');
const peer = findPeer(configDir, sessionId);
const frame = userFrame(peer, peerAddress('/tmp/synthetic-sender.sock'), 'synthetic-codex', crypto.randomUUID(),
  crypto.randomUUID(), text, 'prompting', 'a'.repeat(24));
const written = await withDeliveryHelp(stateDir, configDir, peer, [frame], outgoing => sendFrames(configDir, peer, outgoing));
if (!written) throw new Error('Worker did not send its message');
