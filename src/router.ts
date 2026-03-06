import type { Channel, NewMessage } from './types.js';
import { logger } from './logger.js';

/** Escape XML special characters. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format an array of messages into XML for the agent prompt. */
export function formatMessages(messages: NewMessage[]): string {
  return messages
    .map(
      (m) =>
        `<message sender="${escapeXml(m.sender_name)}" timestamp="${m.timestamp}">${escapeXml(m.content)}</message>`,
    )
    .join('\n');
}

/** Strip <internal>...</internal> tags from agent output. */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/** Clean agent output for delivery to a channel. */
export function formatOutbound(raw: string): string {
  const cleaned = stripInternalTags(raw);
  return cleaned || '';
}

/** Route an outbound message to the appropriate channel. */
export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    throw new Error(`No connected channel found for JID: ${jid}`);
  }
  logger.debug({ channel: channel.name, jid }, 'Routing outbound message');
  return channel.sendMessage(jid, text);
}

/** Find the channel that owns a given JID. */
export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((ch) => ch.isConnected() && ch.ownsJid(jid));
}
