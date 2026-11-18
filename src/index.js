import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DaisyClient } from './daisy.js';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const client = new DaisyClient({ username: process.env.DAISY_USERNAME, password: process.env.DAISY_PASSWORD });
const server = new McpServer({ name: 'pilke-daisyfamily', version: '0.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const handle = fn => async args => { try { return await fn(args); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; } };

server.registerTool('list_messages', {
  description: 'List recent message threads and previews, newest first. Includes unread and attachment counts. Does not mark messages read. Use thread IDs with get_message_thread.',
  inputSchema: { limit: z.number().int().min(1).max(100).default(30), unread_only: z.boolean().default(false), search: z.string().max(200).optional().describe('Case-insensitive text to find in the subject or preview, e.g. weekly schedule.') }, annotations
}, handle(async ({ limit, unread_only, search }) => {
  const messages = await client.listMessages();
  const q = search?.toLocaleLowerCase();
  const matching = messages.filter(m => (!unread_only || m.CountNotReadMessages > 0) && (!q || `${m.Title || ''} ${m.PartContent || ''}`.toLocaleLowerCase().includes(q)));
  return output({ totalMatching: matching.length, threads: matching.slice(0, limit).map(m => ({ threadId: m.ThreadId, subject: m.Title, preview: m.PartContent, newestSaved: m.NewestSaved, sender: m.MessageSender?.Name, unreadCount: m.CountNotReadMessages, messageCount: m.CountMessages, attachmentCount: m.CountAttachment })) });
}));
server.registerTool('get_message_thread', {
  description: 'Get the full text and attachment metadata for a message thread without calling the mark-as-read endpoint. Weekly activity plans are often attachments; use read_message_attachment.',
  inputSchema: { thread_id: z.string().uuid() }, annotations
}, handle(async ({ thread_id }) => output(await client.getThread(thread_id))));
server.registerTool('read_message_attachment', {
  description: 'Read an attachment belonging to a message thread. Extracts text from PDFs and Word documents, returns supported images for visual inspection. Text extraction cannot read scanned PDFs. Does not mark messages read.',
  inputSchema: { thread_id: z.string().uuid(), attachment_id: z.string().uuid() }, annotations
}, handle(async ({ thread_id, attachment_id }) => {
  const file = await client.attachment(thread_id, attachment_id);
  if (file.bytes.length > 20_000_000) throw new Error('Attachment exceeds the 20 MB size limit.');
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimeType)) return { content: [{ type: 'text', text: `Attachment: ${file.name}` }, { type: 'image', data: file.bytes.toString('base64'), mimeType: file.mimeType }] };
  let text;
  if (file.mimeType === 'application/pdf') { const pdf = new PDFParse({ data: file.bytes }); try { text = (await pdf.getText()).text; } finally { await pdf.destroy(); } }
  else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') text = (await mammoth.extractRawText({ buffer: file.bytes })).value;
  else if (file.mimeType.startsWith('text/')) text = file.bytes.toString('utf8');
  else throw new Error(`Unsupported attachment type: ${file.mimeType}.`);
  return output({ name: file.name, mimeType: file.mimeType, text: text.slice(0, 200000), truncated: text.length > 200000, note: text.trim() ? undefined : 'No text extracted; the document may be scanned or image-only.' });
}));
server.registerTool('get_care_times', {
  description: 'Get booked and recorded care times for the selected date range. Distinguish bookings from actual attendance. Does not change bookings. Set debug=true only to troubleshoot: raw responses may contain private family data.',
  inputSchema: { start_date: z.string().describe('First date, YYYY-MM-DD'), end_date: z.string().describe('Last date, YYYY-MM-DD; maximum range 94 days'), debug: z.boolean().default(false).describe('Include HTTP request and response diagnostics, which can contain private family data. Credentials and tokens are redacted.') }, annotations
}, async ({ start_date, end_date, debug }) => {
  const trace = debug ? [] : undefined;
  try {
    const result = await client.careTimes(start_date, end_date, { trace });
    return output(debug ? { ...result, diagnostics: trace } : result);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, ...(debug ? { diagnostics: trace } : {}) }, null, 2) }] };
  }
});
server.registerTool('get_bulletins', { description: 'Get the parent bulletin board, including any notice and attachment metadata.', inputSchema: {}, annotations }, handle(async () => output(await client.bulletins())));
server.registerTool('book_care_time', {
  description: 'Create a single same-day care booking only when the user explicitly requested the specific child, date, and times. Checks placement, availability, opening hours and conflicts; never replaces existing bookings. Verify the result. If the outcome is uncertain, do not retry; check DaisyFamily first.',
  inputSchema: { child_name: z.string().min(1).describe('Unique child first or full name'), date: z.string().describe('Date in YYYY-MM-DD'), start_time: z.string().describe('Drop-off time in local daycare time, HH:MM'), end_time: z.string().describe('Pick-up time in local daycare time, HH:MM') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, handle(async ({ child_name, date, start_time, end_time }) => output(await client.bookCareTime({ childName: child_name, date, startTime: start_time, endTime: end_time }))));
server.registerTool('book_care_time_ranges', {
  description: 'Submit one bulk booking for one child, using one or more inclusive date ranges with times. Only call when the user explicitly requests these dates and times. Automatically skips weekends, Finnish holidays, Christmas Eve, Midsummer Eve, and excluded_dates. Refuses existing bookings or unavailable dates before submitting. Checks each result afterward; never automatically retry an uncertain or partial result. Maximum 62 eligible days spanning 94 days.',
  inputSchema: {
    child_name: z.string().min(1).describe('Unique child first or full name'),
    ranges: z.array(z.object({ start_date: z.string().describe('First date, YYYY-MM-DD'), end_date: z.string().describe('Last date, YYYY-MM-DD, inclusive'), start_time: z.string().describe('Drop-off, local time HH:MM'), end_time: z.string().describe('Pick-up, local time HH:MM') })).min(1).max(20),
    excluded_dates: z.array(z.string().describe('Additional date to skip, YYYY-MM-DD')).max(94).default([])
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, handle(async ({ child_name, ranges, excluded_dates }) => output(await client.bookCareTimeRanges({ childName: child_name, ranges: ranges.map(r => ({ startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time })), excludedDates: excluded_dates }))));
await server.connect(new StdioServerTransport());
