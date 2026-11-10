# Junk Pickleball

A phone-friendly app for running social pickleball: log a session in under a
minute, see who owes what each month, and send each person their bill on
WhatsApp. Data lives in a Google Sheet, so you can always open it there too.

- **Manager app:** `app/` — <https://razor-plays.github.io/junk-pickleball/app/>
- **Stats page for friends:** `index.html` + `dashboard-v2.js` —
  <https://razor-plays.github.io/junk-pickleball/> (attendance only, no money)
- **Sheet API:** `apps-script/Code.gs` — runs inside the app's Google Sheet
- **Money rules:** `app/billing.js` — shared by the app and the tests
- **History import:** `tools/migrate-legacy.js` — one-off converter from the
  old "Attendance 2.0" sheet (that sheet is never modified)

## What the app does

| Screen | What you do there |
| --- | --- |
| **Sessions** | Tap **＋ Session** (or a "To fill" booking). Set each member's court hours with +/−, tap the players who came, add guests with who pays for them (a player, Reclub, or themselves). Returning guests are suggested as you type, with their usual host filled in. The cost per player updates as you go. |
| **Bills** | Pick a month. Shows what each player owes (guests listed on the host's bill), each member's payback, Reclub income and what goes to the kitty. **Send bill** opens WhatsApp with the message filled in. **Mark paid** records payment, flags a bill that changed after it was paid, and lists anything still unpaid from earlier months. Warnings appear for sessions with no players, unassigned guests, etc. |
| **Club** | Membership hours used / left, record a new membership purchase (any price/hours/rate), kitty balance and spending, players (add, rename, make member, inactive, WhatsApp number), settings, the invite link for another phone, and the on/off switch for the public stats page. |

Two people can use it at once: if someone else changed a session while you
had it open, your save is refused with a message instead of overwriting
theirs.

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

The Google Sheet (**Junk Pickleball App (data)**) already has its tabs,
history and an access code. What's left is switching on the script that lets
the app read and write it:

1. Open the sheet, then **Extensions → Apps Script**.
2. Delete the sample code, paste the contents of
   [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. **Deploy → New deployment → ⚙ → Web app**. *Execute as:* **Me**,
   *Who has access:* **Anyone**. Click **Deploy** and approve the permissions
   (Google warns it's unverified because it's your own script:
   *Advanced → Go to … (unsafe)*).
4. Copy the **Web app URL** (ends in `/exec`) into
   [`app/config.js`](app/config.js).
5. Open the app, enter the access code from the sheet's **Settings** tab
   once, and use *Add to Home Screen*. For other phones use
   **Club → Send invite link**.

Starting from an empty sheet instead? Run the `setup` function once before
deploying; it creates the tabs and an access code.

When `Code.gs` changes: paste the new version, then **Deploy → Manage
deployments → Edit → Version: New version**. The URL stays the same.

### Security and privacy

- "Anyone" means the URL works without a Google login, but every data
  request needs the access code. It lives only in the sheet's Settings tab
  and on the phones that use the app; the app can't read or change it.
  Anyone with edit access to the sheet can see it. To lock everyone out,
  change it in the sheet and send a new invite link.
- After 30 wrong codes in 10 minutes the API refuses everything for a while.
- The stats page gets one feed without the code: first names and the dates
  they played. No money, phone numbers or notes, and guests appear as
  "Guest 1", "Guest 2". Turn it off in **Club → Settings** (or set
  `public_stats` to `FALSE` in the sheet).

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
| Settings | key, value (`club_name`, `default_rate`, `reclub_fee`, `currency`, `pay_to`, `public_stats`, `access_code`) |

## Development

```bash
npm test
```

No build step. The tests cover the money rules, the history import, and the
sheet API (run against a small fake of Apps Script in `tests/fake-gas.js`).
To try the pages locally, serve the repo (e.g. `python3 -m http.server`) and
open `/` or `/app/`.
