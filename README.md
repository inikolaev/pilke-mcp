# Pilke DaisyFamily MCP

A local, unofficial MCP server for Pilke's DaisyFamily portal. It retrieves care bookings, message threads, parent bulletins and message attachments, and can create explicitly requested care bookings for one day or several date ranges. Weekly plans are often sent as attachments to messages, so search for schedules and read the relevant attachment as well as the message. The assistant should check message dates and distinguish a published plan from a confirmed arrival requirement.

## Setup

Requires Node.js 22 or later. Install dependencies with `npm install`. Copy `.env.example` to `.env`, set `DAISY_USERNAME` and `DAISY_PASSWORD`, and restrict the file to your user (`chmod 600 .env`). Use dotenv quoted values if the password contains special characters. Environment variables provided by the MCP client take precedence over `.env`. Keep `.env` and any exported family data private.

Add this stdio server to your MCP client, using absolute paths on your computer:

```json
{
  "mcpServers": {
    "pilke": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pilke-mcp/src/index.js"]
    }
  }
}
```

Restart the client after configuring it. For example, ask it to list recent messages, find the latest weekly plan and read its attachment, or show care times for a date range. The process reads `.env` relative to this project, independent of the client's working directory. The MCP client and any AI service it uses will receive the returned family data; use a client you trust.

## Tools

- `list_messages`: searchable recent thread previews and unread counts.
- `get_message_thread`: complete thread and attachment metadata.
- `read_message_attachment`: extracts PDF, DOCX and text content, or returns supported images for a vision-capable client. Scanned PDFs may have no extractable text.
- `get_care_times`: bookings and attendance data for a date range of at most 94 days. To avoid HTTP 400 responses observed for some short ranges, the server requests at least 14 days by extending the start date, then returns only the requested dates.
- `get_bulletins`: parent bulletin board.
- `book_care_time`: creates one explicitly requested weekday booking for one child, after checking placement, opening hours, calendar availability and existing bookings. It refuses to replace existing bookings and reads back the calendar to verify the result. If the outcome is uncertain, check DaisyFamily before trying again.
- `book_care_time_ranges`: accepts up to 20 inclusive ranges with independent daily times and optional `excluded_dates`, expands them into dates and sends one save request. It skips weekends, Finnish public holidays, Christmas Eve and Midsummer Eve. School holidays such as hiihtoloma are not automatic; pass those dates in `excluded_dates` or use separate ranges. At most 62 eligible weekdays can span at most 94 days. It refuses the whole request before submission if any eligible day has existing bookings, statuses or unavailable calendar data. After saving, it checks every date and reports confirmed and unconfirmed results; never automatically retry a partial or uncertain result.

The API is undocumented and may change. These tools return data for the authenticated guardian, possibly covering multiple children. Verify important dates and times in DaisyFamily, especially if the daycare sends corrections or attachments in unsupported formats. This server does not automatically monitor for new messages or send reminders.

## Booking and data safety

The site uses POST for several retrieval operations. The server permits only specific login, retrieval, and booking endpoints, rejects redirects and never calls message sending, mark-as-read, or deletion endpoints. The booking endpoint changes daycare records and is never retried automatically. Existing entries are not intentionally replaced, but DaisyFamily's undocumented API and concurrent changes limit what can be guaranteed. DaisyFamily's web interface marks unread threads read separately; this server does not make that call. Authentication creates a normal login session. Credentials and access tokens are kept out of logs and are sent only to the fixed Pilke HTTPS host; the token is held in process memory. Before an authenticated operation, the server checks the session using a read-only children request (which itself serves as the check when it is the operation). It logs in again if the check receives a 401, and retries a read-only operation once after a 401. A session can expire between the check and the operation; booking submissions are never automatically retried. Each operation normally makes one additional read-only request.

All DaisyFamily HTTP requests, including authentication and session checks, are spaced at least one second apart. The limiter is shared across clients within one server process, including concurrent tool calls; separate server processes do not coordinate their limits. This can make multi-day booking slower, and the request timeout starts only when the queued request is sent.

Run `npm test` for offline tests. No tests change daycare data.

For care-time troubleshooting, call `get_care_times` with `debug: true`. The response then includes the request URL, method, selected headers, status, and response body for each request, including failures. Login bodies and authorization headers are redacted; response bodies are capped at 100,000 characters. Diagnostics can contain private family information, including data from the extra days fetched for a short range, so enable them only when needed and review them before sharing. They are returned to the MCP client and are not written to a file by this server. Network failures include the underlying error code (for example, `ENOTFOUND`) to help distinguish DNS or sandbox restrictions from an HTTP error.
