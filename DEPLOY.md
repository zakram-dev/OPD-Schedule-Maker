# Putting it online

## Recommended: Cloudflare Pages (no servers to run)

The site is only files (all the work happens in each person's browser), so Cloudflare Pages hosts it
for free on its global network. It keeps working through power, internet or hardware problems at
home, and every push to GitHub updates the site automatically.

Pages settings (Workers & Pages → Create → Pages → Import an existing Git repository):

| Setting | Value |
|---|---|
| Repository | `zakram-dev/OPD-Schedule-Maker`, branch `main` |
| Framework preset | None |
| Build command | `sh deploy/build-site.sh dist` |
| Build output directory | `dist` |

The build downloads the reading libraries and bundles them, like the Docker image does.
`deploy/pages/_headers` sets the security headers and caching, and `deploy/pages/_redirects` makes
`/tip` point to the Ko-fi page. Add `zee-ogp.space` and `www.zee-ogp.space` under the project's
**Custom domains** (remove the old tunnel routes for those names first).

---

# Alternative: Ubuntu laptop + Docker + Cloudflare Tunnel

Result: the site is live at **https://zee-ogp.space**, served from your old laptop, with no ports
opened on your home router. Cloudflare provides the https certificate for free.

Why the laptop is plenty: all the heavy work (reading photos/PDFs, making the schedule) runs in each
lead's own phone or computer. The laptop only sends files. Expect about 40 MB of RAM in use.

---

## 1. Check the laptop (2 min)

On the laptop:

```bash
uname -m
```

It must say `x86_64` (64-bit). If it says `i686`, Docker won't run on that install. Tell me and we'll use another way.

## 2. Copy the project to the laptop

From your **Mac**, in the project folder (replace `you@192.168.1.50` with the laptop's user name and IP;
`hostname -I` on the laptop shows the IP):

```bash
tar czf - --exclude ./tests --exclude ./test-files --exclude ./.claude --exclude ./.env --exclude ./.git . | ssh you@192.168.1.50 'mkdir -p ~/ogp-schedule && tar xzf - -C ~/ogp-schedule'
```

## 3. One-time server setup (5 min)

```bash
ssh -t you@192.168.1.50 'sudo sh ~/ogp-schedule/deploy/server-setup.sh'
```

This installs Docker, makes Docker start on every boot, keeps the laptop awake with the lid closed,
sets the clock to Arkansas time and installs rsync for later updates. It's safe to run again.

Optional: in the laptop's BIOS, turn on "Restore on AC power loss" if it has it, so it powers back on
after a long outage. The containers restart automatically once Docker is up.

## 4. Create the Cloudflare tunnel (10 min, in the browser)

1. Your domain must be on Cloudflare. If you bought zee-ogp.space somewhere else, go to
   dash.cloudflare.com → **Add a site** → enter `zee-ogp.space` → Free plan, then change the domain's
   nameservers at the place you bought it to the two Cloudflare gives you. Wait until Cloudflare says **Active**.
2. Go to **Zero Trust** (left menu) → **Networks → Tunnels** → **Create a tunnel** → **Cloudflared**.
3. Name it `ogp-schedule` → Save.
4. Choose **Docker**. You'll see a command like `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...`.
   Copy just the long token after `--token`. **Keep it secret.**
5. First delete any old **A/AAAA/CNAME** records for `zee-ogp.space` and `www` under the domain's
   **DNS → Records** (for example a registrar parking page), or the route can't be created.
6. Open the tunnel → **Routes → Add route → Published application**:
   - Subdomain: *(leave empty)*, Domain: `zee-ogp.space`, Path: *(empty)*
   - Service URL: `http://web:80` (not localhost)
7. Add a second route the same way with Subdomain `www`.

## 5. Start it (on the laptop)

```bash
cd ~/ogp-schedule && cp .env.example .env && nano .env
```

Paste the token after `TUNNEL_TOKEN=`, then save (Ctrl+O, Enter, Ctrl+X).

```bash
docker compose up -d --build
```

The first build takes a few minutes on a Core 2 Duo (it downloads about 22 MB of reading libraries). Check it:

```bash
docker compose ps
```

Both `ogp-schedule-web` and `ogp-schedule-tunnel` should say `Up` (the web one also shows `healthy` after a minute).
In Cloudflare the tunnel turns **Healthy**. Open **https://zee-ogp.space**. 🎉

On your home Wi-Fi you can also open `http://<laptop-ip>:8080`.

## 6. Recommended: only let your team in (free)

The site keeps schedules only on each lead's own device, but it's still work stuff, so lock the door:

Zero Trust → **Access → Applications → Add an application → Self-hosted** → domain `zee-ogp.space` →
add a policy **Allow** → **Emails** → list your leads' emails. They'll get a one-time code by email the first time.
It's free for up to 50 people.

## Updating after changes

Copy the files again (step 2), then on the laptop:

```bash
cd ~/ogp-schedule && docker compose up -d --build
```

## Troubleshooting

| Problem | Check |
|---|---|
| Site doesn't load | `docker compose logs tunnel`: look for "Registered tunnel connection". Token wrong? Fix `.env`, then `docker compose up -d` |
| Cloudflare shows error 502 | The route's Service URL must be `http://web:80` (not localhost) |
| `www` works on mobile data but not home Wi-Fi | Your router remembered "doesn't exist" from before the route existed. Wait 30 min or restart the router |
| Build fails while downloading | Internet hiccup: run `docker compose up -d --build` again |
| Laptop went to sleep | Run step 3 again |
| Need to stop it | `docker compose down` |

## Good to know

- **Data:** saved days, team leads and settings live in each person's browser, not on the laptop.
  Each lead's phone keeps its own history. Use **Saved days → Download backup** to move it.
  A shared database on the laptop is a possible next step.
- **Store network:** check with management that using a personal site for work schedules is okay.
