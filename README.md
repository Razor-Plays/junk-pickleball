# Junk Pickleball

A phone-friendly app for running social pickleball: log a session in under a
minute, see who owes what each month, and send each person their bill on
WhatsApp. Data lives in a Google Sheet, so you can always open it there too.

- **App:** `app/` — a static web page (served by GitHub Pages at `/app/`)
- **Sheet API:** `apps-script/Code.gs` — runs inside the app's Google Sheet
- **Money rules:** `app/billing.js` — shared by the app and the tests
- **History import:** `tools/migrate-legacy.js` — one-off converter from the
  old "Attendance 2.0" sheet (that sheet is never modified)

The old stats dashboard (`index.html`, `dashboard-v2.*`) is still here,
untouched.

## What the app does

| Screen | What you do there |
| --- | --- |
| **Sessions** | Tap **＋ Session** (or a "To fill" booking). Set each member's court hours with +/−, tap the players who came, add guests with who pays for them (a player, Reclub, or themselves). The cost per player updates as you go. |
| **Bills** | Pick a month. Shows what each player owes (guests listed on the host's bill), each member's payback, Reclub income and what goes to the kitty. **Send bill** opens WhatsApp with the message filled in. **Mark paid** records payment. Warnings appear for sessions with no players, unassigned guests, etc. |
| **Club** | Membership hours used / left, record a new membership purchase (any price/hours/rate), kitty balance and spending, players (add, rename, make member, inactive, WhatsApp number), settings. |

### Money rules

- Session cost = booked hours × the rate saved **on that booking**. Changing
  the rate later never changes past sessions.
- Cost per player = session cost ÷ everyone who played (guests included),
  rounded to cents.
- Each player pays their own share **plus their guests'**.
- Members don't get a bill. Their payback = value of hours they booked −
  their own (and their guests') court fees. Negative means they owe.
- Reclub players pay the Reclub fee (saved per session); the difference over
  their court share goes to the kitty.
- New bookings use the rate of the member's oldest membership that still has
  hours left.

## One-time setup

1. Open the app's Google Sheet (**Junk Pickleball App (data)** in Drive).
2. **Extensions → Apps Script**. Delete the sample code, paste the contents
   of [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. In the function dropdown pick **setup** and press **Run**. Approve the
   permissions (Google warns it's unverified because it's your own script:
   *Advanced → Go to … (unsafe)*). This adds an `app_pin` to the
   **Settings** tab — change it to anything you like.
4. **Deploy → New deployment → Web app**. *Execute as:* **Me**,
   *Who has access:* **Anyone**. Deploy and copy the URL ending in `/exec`.
5. Put that URL in [`app/config.js`](app/config.js) (or paste it into the
   app's first screen on each phone).
6. Open the app on your phone, enter the PIN, and use *Add to Home Screen*.

When `Code.gs` changes: paste the new version, then **Deploy → Manage
deployments → Edit → Version: New version**. The URL stays the same.

### Security

"Anyone" means the URL works without a Google login, but every request needs
the PIN, which only lives in the sheet's Settings tab and on the phones that
use it. The PIN can't be changed or read through the app. Anyone with edit
access to the sheet can see it.

## Sheet layout

One row per thing, so adding people, members or price changes never needs a
formula edit.

| Tab | Columns |
| --- | --- |
| Players | name, role (`member`/`player`), active, phone, notes |
| Sessions | id, date (`YYYY-MM-DD`), reclub_fee, notes, updated_at |
| Bookings | session_id, member, hours, rate |
| Attendance | session_id, name, guest, pays |
| Memberships | id, member, date, amount, hours, rate, notes |
| Payments | month (`YYYY-MM`), person, amount, paid_on, note |
| Kitty | id, date, description, amount (spending is negative) |
| Settings | key, value |

## Development

```bash
npm test
```

No build step. To try the app locally, serve the repo (e.g.
`python3 -m http.server`) and open `/app/`.
