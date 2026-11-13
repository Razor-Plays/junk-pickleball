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
| **Court Fees** (the Monthly Tab) | Pick a month. The header shows the sessions, the court cost and, for admins, how much has been collected so far. Below that, one line per player and per member: tap a name for their page, tap the circle when they've paid, and tap the arrow to send their bill on WhatsApp. **Share summary with the group** lists everyone: regulars, guests (with their host) and members. Reclub, warnings and the money check sit at the bottom. |
| **Club** | Membership hours used / left, record a new membership purchase (any price/hours/rate), kitty balance and spending, players (add, rename, make member, inactive, WhatsApp number), settings, the invite link for another phone, and the on/off switch for the public stats page. |

Membership credit is tracked in money. The court takes credit off as soon as
a court is booked and gives it back if the booking is released, so the app
does the same. When the court
gives a balance, enter it (**Club → Membership Balance → Enter court
balance**): from that date the app counts down from the court's figure and
shows how far it differed from our own records since the previous court
balance. Past sessions, fees and paybacks are never changed. Each member's
bar shows how much is left out of the court balance before their latest
top-up plus the top-ups since (e.g. the Sept 2025 ledger + the Jan 2026
top-up), so it only refills when money is added.

Each session records where it was played and how long it ran, so 4 booked
hours read as "2 courts × 2h". Tapping a name (on Club, or **History** on a
bill) opens that person's page: games, first game, fees, games per month, and
every month's lines.

A named guest who has come three times is suggested as a regular; making them
one carries their past visits over. Names must be unique (ignoring case), since
bills are kept by name: a second Neil has to be "Neil G".

The look follows the club's colours (navy, orange, ocean blue and ball yellow
on cream). `app/logo.svg` is the club logo as a vector, `app/ball.svg` is the
ball on its own for small spaces, and `app/icon-*.png` are the home-screen
icons. The big logo banner sits at the top of the Sessions screen and scrolls
away; a slim navy bar takes over once it has gone. Day mode is the default;
the moon button in the top bar switches that phone to night mode.

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
deployments → Edit → Version: New version**. The URL stays the same, so
nobody has to reinstall or sign in again. (Don't use *New deployment* for an
update: that makes a different URL.)

### Two codes

| Code (Settings tab) | For | Can do |
| --- | --- | --- |
| `access_code` | the people who run the club | everything |
| `member_code` | regular members | look only: sessions, who played, and bills |

The member code is enforced by the sheet script, not just by hidden buttons:
every change is refused, and the script never sends a member's phone the
memberships (hours left), who booked which court, paybacks, the kitty, the
Reclub fee, phone numbers or notes. **Club → Share** has a link for each code.

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
| Sessions | id, date (`YYYY-MM-DD`), reclub_fee, notes, updated_at, location, play_hours |
| Bookings | session_id, member, hours, rate |
| Attendance | session_id, name, guest, pays |
| Memberships | id, member, date, amount, hours, rate, notes, kind (`purchase` or `balance`: what the court said was left on that date), covers (for a balance: bookings for later sessions already included, `sessionId:hours,...`) |
| Payments | month (`YYYY-MM`), person, amount, paid_on, note |
| Kitty | id, date, description, amount (spending is negative) |
| Settings | key, value (`club_name`, `default_rate`, `reclub_fee`, `currency`, `pay_to`, `public_stats`, `access_code`, `member_code`) |

## Development

```bash
npm test
```

No build step. The tests cover the money rules, the history import, and the
sheet API (run against a small fake of Apps Script in `tests/fake-gas.js`).
To try the pages locally, serve the repo (e.g. `python3 -m http.server`) and
open `/` or `/app/`.
