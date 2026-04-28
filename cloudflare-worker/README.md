# Cloudflare Worker — Stripe Webhook Relay

Stripe webhook delivery to Apps Script `/exec` fails because Apps Script
returns a 302 redirect to a one-time-use URL on `script.googleusercontent.com`,
and Stripe preserves POST through the redirect. `googleusercontent.com`
only accepts GET, so the result is a 4xx + Google Drive 404 page.

This Worker is a thin relay that handles the redirect correctly. Free tier
covers 100,000 requests/day — far beyond what NenanaWISP will ever use.

## Setup (web UI, no CLI required)

1. Sign in to https://dash.cloudflare.com (use the same account that hosts
   the nnabroadband.com DNS).
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker**.
3. Name: `nna-stripe-relay` (or whatever you like — this becomes part of the
   public URL).
4. Click **Deploy**. Cloudflare ships the default Hello World worker first;
   you have to deploy once before you can edit the code.
5. Click **Edit code** (top right of the Worker page).
6. Replace the entire file contents with `stripe-relay.js` from this folder.
7. Click **Deploy** (top right of the editor).
8. Go back to the Worker overview → **Settings** tab → **Variables and Secrets**.
9. Click **Add** to set two secrets:

   | Name | Type | Value |
   |---|---|---|
   | `APPS_SCRIPT_URL` | Secret | The Apps Script `/exec` URL **without** any `?secret=` suffix — the Worker adds it. |
   | `WEBHOOK_URL_SECRET` | Secret | Same value already set as a Script Property in Apps Script. |

   Use the **Secret** type for both so they're encrypted at rest and don't
   show in plaintext after saving.

10. Note the Worker URL at the top of the overview page. It looks like:
    `https://nna-stripe-relay.<your-account-subdomain>.workers.dev`

## Update Stripe webhook URL

11. Stripe Dashboard → Webhooks → `exquisite-victory` → **Update destination**.
12. Replace the **Endpoint URL** with:
    ```
    https://nna-stripe-relay.<your-account-subdomain>.workers.dev?secret=<WEBHOOK_URL_SECRET>
    ```
    (The Worker URL replaces the Apps Script URL; keep the same `?secret=`
    value you used before.)
13. Save. Re-enable the destination if it's currently disabled.

## Test

14. In Stripe → Events, click into one of the recent failed events (404 ERR)
    and click **Resend** in the top-right.
15. Verify success in three places:
    - **Stripe Activity tab**: should now show **200 OK**, body `ok`.
    - **Google Sheet → `Webhook_Log` tab**: new row with status `processed`.
    - **Google Sheet → `Customers` tab**: new customer row from the resent
      `checkout.session.completed`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` | `?secret=` in Stripe URL doesn't match `WEBHOOK_URL_SECRET` env var | Re-check both values for typos / extra spaces |
| `500 Worker not configured` | One of the env vars isn't set | Set both in Workers → Settings → Variables and Secrets |
| `502 Apps Script returned redirect with no Location` | Apps Script deployment URL wrong or unreachable | Verify `APPS_SCRIPT_URL` env var matches the active Apps Script deployment |
| Stripe shows `webhook auth not configured` | Apps Script `WEBHOOK_URL_SECRET` Script Property not set | Set it; redeploy Apps Script |
| Timeout (Stripe shows generic delivery failure) | Apps Script cold start (5–15s typical) | Stripe retries automatically — usually self-resolves |

## Quotas (Cloudflare Free Plan)

- 100,000 Worker requests/day
- 10ms CPU per request (we only `await fetch()`, which doesn't count toward
  CPU time)
- No bandwidth limit on free plan

You will not hit any of these.
