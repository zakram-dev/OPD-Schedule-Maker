# OPD Schedule Maker

A free website for OPD team leads: add the day's schedule (screenshots, PDF, Excel/CSV, or typed), and it
assigns every associate a job (Pick, Disp, Backroom, Prep, SM/EXP) and a staggered lunch,
with a named cover for each Backroom / Prep / SM lunch. Everything stays editable.

## Run it

Easiest: double-click `index.html`.

Or run a small local server from this folder (needed for some browsers):

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123

Reading photos, PDFs and Excel needs internet the first time (it downloads free reading
libraries, about 10 MB). After that the browser caches them.

## How a lead uses it

1. **Add schedule**: drop in screenshots (or paste them with Ctrl/⌘+V), a PDF (text or scanned), an Excel / CSV / .txt file, or paste/type the list.
2. **Check people**: fix any misread names/times, tick **Team lead** for leads (remembered next time).
3. **Jobs & lunches**: three views:
   - **Lunch chart**: colorful timeline by team (Picking + SM/EXP on top, then Dispensing, Backroom, Prep).
     Yellow blocks are lunches, dashed boxes show who covers a Backroom/Prep/SM lunch, and each team's
     header shows how many are at lunch every half hour. Below it, **Lunch order** lists who goes when.
     Click a person to edit them. **Print chart** prints it in color, landscape.
   - **Edit jobs & lunches**: change any job/lunch/cover, then **Print** or **Download CSV**.
   - **Who's on the floor**: pickers/dispensers working each half hour, red when short.
   - **Redo schedule** re-plans everything you didn't change by hand (your edits show 🔒).
   - **Try another mix** gives a different but equally valid assignment.

## Put it online

See [DEPLOY.md](DEPLOY.md): Docker + Cloudflare Tunnel on an Ubuntu laptop, at https://zee-ogp.space.

## Rules built in (all changeable in Settings)

| Rule | Default |
|---|---|
| Department hours | 5:00 AM – 10:00 PM |
| Lunch | under 6h: none · 6h: 30 min · over 6h: 1 hour |
| Lunch timing | starts ≥ 3h into the shift, within 6h, ends ≥ 1h before shift end |
| One-person jobs | Backroom 5a–10p, Prep 6a–10p, SM/EXP 5a–8p, whole shift each |
| Lunch covers | any picker or dispenser on the floor |
| Dispenser share | 5% at open → 35% from 6:30a → 40% from 11a → 50% from 4p (from the sample sheets) |
| Minimums | 1 picker always, 1 dispenser 7a–10p |
| Team leads | no job, no lunch assigned |
| Rotation | looks back 7 saved days so people don't get the same job every day |

## Where data is saved

In the browser's local storage on that device. Use **Saved days → Download backup** to move
it to another computer. (A shared online database is the next step for multi-device use.)

## Files

- `js/scheduler.js`: the scheduling engine (jobs, lunches, covers, warnings)
- `js/parser.js`: turns schedule text into names + shift times
- `js/ocr.js`: free in-browser photo reading (Tesseract.js)
- `js/pdf.js`: PDF reading (PDF.js); scanned pages go to the photo reader
- `js/sheet.js`: Excel / CSV reading (SheetJS)
- `js/app.js`: the website screens
- `css/styles.css` + `fonts/`: the look; see [DESIGN.md](DESIGN.md) for the design system
