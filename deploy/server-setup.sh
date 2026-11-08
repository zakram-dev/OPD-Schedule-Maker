#!/bin/sh
# One-time setup for the Ubuntu server. Run it on the server with:
#   sudo sh ~/ogp-schedule/deploy/server-setup.sh
# It is safe to run more than once.
set -eu

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"

echo "== Checking the CPU =="
ARCH="$(uname -m)"
echo "Architecture: $ARCH"
if [ "$ARCH" != "x86_64" ]; then
  echo "This install is $ARCH. Docker needs a 64-bit (x86_64) Ubuntu. Stopping."; exit 1
fi

echo "== Setting the clock to Arkansas time and adding rsync (for updates) =="
timedatectl set-timezone America/Chicago || true
apt-get update -qq && apt-get install -y -qq rsync curl

echo "== Installing Docker (skipped if already there) =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "== Starting Docker on every boot =="
systemctl enable --now containerd docker

echo "== Letting $USER_NAME run docker without sudo =="
usermod -aG docker "$USER_NAME"

echo "== Keeping the laptop awake (lid closed, no sleep) =="
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/ogp-schedule.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
systemctl kill -s HUP systemd-logind || true
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

echo
echo "Done. Docker version: $(docker --version)"
echo "Log out and back in once so the docker group applies to $USER_NAME."
