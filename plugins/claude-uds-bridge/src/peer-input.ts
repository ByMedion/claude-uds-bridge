type PeerInput = {
  senderName: string;
  sessionId: string;
  messageId: string;
  text: string;
  sourceAddress: string | null;
};

// Presentation only. Authentication, guards and input correlation use the
// original stored frame, never this rendered text.
export function formatPeerInput({ senderName, sessionId, messageId, text, sourceAddress }: PeerInput) {
  const envelope = /^<cross-session-message\b([^>\r\n]*)>\r?\n([\s\S]*?)\r?\n<\/cross-session-message>$/.exec(text);
  const from = envelope?.[1]?.match(/(?:^|\s)from="([^"\r\n]+)"/)?.[1];
  // Hide only a complete outer envelope bound to the recorded peer address.
  const body = envelope && sourceAddress && from === sourceAddress ? envelope[2]! : text;
  const name = senderName.replace(/[\r\n\u2028\u2029]/g, ' ');
  return `Отправитель: ${name}\nsessionId для ответа: ${sessionId}\nmessageId: ${messageId}\n\n${body}`;
}
