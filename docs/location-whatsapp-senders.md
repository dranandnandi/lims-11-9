# Per-location WhatsApp senders

How a lab gives each branch its own WhatsApp number instead of one number for
the whole lab. Written alongside the implementation (2026-08-20).

## Why this works at all

The WhatsApp backend keys every session by the **LIMS `users.id`** it was
registered under — `sync-user-to-whatsapp` posts `{ id: user.id, ... }` to
`/api/external/users/sync`, and every send passes that same id as `userId`.

So a lab could always hold several connected numbers at once, one per user who
had scanned a QR. What was missing was routing: every send path read a single
`labs.whatsapp_user_id`. Now the choice cascades.

## The cascade

Resolved in one place — `src/utils/whatsappSenderResolver.ts` for the browser,
`supabase/functions/_shared/whatsappSender.ts` for edge functions. The two are
hand-kept copies of the same logic (same convention `referenceRangeResolver`
follows); **change one, change the other**, and `npm run test:whatsapp-sender`
covers the shared one.

| Order | Source | Set in |
|---|---|---|
| 1 | `locations.whatsapp_user_id` | Masters -> Locations -> WhatsApp Sender |
| 2 | `labs.whatsapp_user_id` | Settings -> Lab Settings -> Default WhatsApp Sender |
| 3 | the current user / the user who triggered generation | implicit |

`NULL` means inherit, so a lab that configures nothing behaves exactly as before.

`locations.whatsapp_country_code` overrides the dialling code independently of
the sender: a branch can override just the number, just the code, or both. The
branch's code applies even when the branch inherits the lab's sender, because
the code describes the region the branch serves, not the account that sends.

## Setting up a branch number

1. **WhatsApp -> User Sync** — sync the user who will own the branch number.
   This is what registers them with the backend; until it happens their id is
   unknown there and nothing will send.
2. **WhatsApp -> Connection** — that user scans the QR on the branch's phone.
3. **Masters -> Locations -> edit the branch -> WhatsApp Sender** — pick them.

The dropdown marks users that have not been synced yet, and the form warns if
you pick one.

## Async sends

`notification_queue` carries `location_id`, stamped at enqueue time from the
order (or invoice). `process-notification-queue` resolves the sender from that
row, so a queued message drains through the same number the immediate attempt
would have used. Rows queued before this feature were backfilled from their
order.

## Known limits

- Each branch needs a real phone and a real scan; there is no way to attach two
  numbers to one session.
- Whether the WhatsApp backend caps concurrent sessions per lab or per instance
  is not visible from this repo — confirm before promising a lab many branches.
- `generate-pdf-auto` and `generate-pdf-auto-1` still read `labs.whatsapp_user_id`
  directly. Nothing in the app invokes them (the live path is
  `generate-pdf-letterhead`); if they are ever revived they need the resolver.
