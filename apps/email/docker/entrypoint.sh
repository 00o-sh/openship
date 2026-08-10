#!/usr/bin/env bash
# First-boot / every-boot entrypoint for the openship-mail engine.
#
# Idempotent by construction — this is what makes `docker pull` + recreate safe:
#   1. seed-if-absent: copy baked config into empty bind mounts, never overwrite
#      operator edits (config dirs are host bind mounts; the queue/maildir/DKIM
#      data dirs start empty and are left alone).
#   2. reconcile: rewrite the baked `build-placeholder` DB password in every
#      daemon config to the real shared role password from the --env-file.
#   3. wait for the postgres SIDECAR (127.0.0.1:5432).
#   4. bootstrap the mail databases (roles + schema + first domain) if the vmail
#      schema isn't there yet — see db-bootstrap.sh; never re-init an existing DB.
#   5. pre-create the log files fail2ban tails (rsyslog fills them once daemons
#      log; a jail whose logpath is missing at start would crash-loop).
#   6. reuse-or-generate the DKIM key on its bind mount (never regenerate — a new
#      selector breaks DMARC until DNS repropagates).
#   7. hand off to supervisord (the CMD).
#
# Env (from ensure-container-mail.ts --env-file): FIRST_DOMAIN,
# OPENSHIP_MAIL_DB_{HOST,PORT,NAME,USER}, plus iRedMail secrets
# (VMAIL_DB_ADMIN_PASSWD, VMAIL_DB_BIND_PASSWD, AMAVISD_DB_PASSWD,
# IREDAPD_DB_PASSWD, FAIL2BAN_DB_PASSWD, PGSQL_ROOT_PASSWD, DOMAIN_ADMIN_PASSWD_PLAIN).
set -euo pipefail

log() { echo "[openship-mail] $*"; }

DB_HOST="${OPENSHIP_MAIL_DB_HOST:-127.0.0.1}"
DB_PORT="${OPENSHIP_MAIL_DB_PORT:-5432}"
FIRST_DOMAIN="${FIRST_DOMAIN:-}"
SEED_DIR="/opt/openship-mail/seed"

# 1. seed-if-absent for bind-mounted config dirs.
seed() { # <seed-subdir> <target>
  local src="$SEED_DIR/$1" dst="$2"
  if [ -d "$src" ] && [ -z "$(ls -A "$dst" 2>/dev/null || true)" ]; then
    log "seeding $dst from baked defaults"
    cp -a "$src/." "$dst/"
  fi
}
seed postfix /etc/postfix
seed dovecot /etc/dovecot
seed amavis-confd /etc/amavis/conf.d
mkdir -p /var/vmail /var/spool/postfix /var/lib/dkim /var/lib/clamav

# 2. reconcile baked placeholder secrets -> the real shared role password.
#    The image is built with `build-placeholder` in every daemon's DB config; all
#    five mail roles share one password (loopback-only sidecar; privsep via
#    GRANTs — see db-bootstrap.sh), so one global replace wires postfix/dovecot/
#    amavis/iredapd/fail2ban to the sidecar. Idempotent: once replaced there is no
#    placeholder left to match, so every later boot is a no-op.
if [ -n "${VMAIL_DB_BIND_PASSWD:-}" ]; then
  export _OPENSHIP_MAIL_PW="$VMAIL_DB_BIND_PASSWD"
  # Pipe grep straight into xargs, newline-delimited. A NUL-delimited list (grep
  # -Z / xargs -0) cannot round-trip through a shell variable — bash silently
  # drops NUL bytes, mashing every path into one bogus filename that rewrites
  # nothing. Config paths never contain spaces/newlines, so newline-split is safe.
  # Skip *.pyc: rewriting iRedAPD's compiled settings.pyc would corrupt it, and
  # it is redundant — Python recompiles it from settings.py (which we DO rewrite,
  # so its mtime is now newer). Deleting the stale .pyc below makes that certain.
  if grep -rl --exclude='*.pyc' 'build-placeholder' \
       /etc/postfix /etc/dovecot /etc/amavis /opt/iredapd /etc/fail2ban 2>/dev/null \
       | xargs -r perl -pi -e 's/\Qbuild-placeholder\E/$ENV{_OPENSHIP_MAIL_PW}/g'; then
    log "reconciled DB passwords in daemon configs"
  else
    log "no placeholder passwords to reconcile"
  fi
  rm -f /opt/iredapd/__pycache__/*.pyc 2>/dev/null || true
  unset _OPENSHIP_MAIL_PW
fi

# 3. wait for the sidecar DB.
log "waiting for the mail database at ${DB_HOST}:${DB_PORT}..."
for _ in $(seq 1 60); do
  if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then break; fi
  sleep 2
done

# 4. bootstrap the mail databases (idempotent; skips if the vmail schema exists).
bash /opt/openship-mail/db-bootstrap.sh || log "ERROR: db-bootstrap failed — inspect the log above"

# 5. pre-create the log files the fail2ban jails tail, so a jail never starts
#    against a missing path (rsyslog populates them as the daemons log).
mkdir -p /var/log/dovecot /var/log/iredapd /var/log/supervisor
touch /var/log/mail.log \
      /var/log/dovecot/dovecot.log /var/log/dovecot/imap.log \
      /var/log/dovecot/pop3.log /var/log/dovecot/lda.log /var/log/dovecot/sieve.log \
      /var/log/iredapd/iredapd.log
chown -R iredapd:iredapd /var/log/iredapd 2>/dev/null || true

# 6. DKIM: reuse the key on the mount, else generate one (per domain).
if [ -n "$FIRST_DOMAIN" ] && [ ! -s "/var/lib/dkim/${FIRST_DOMAIN}.pem" ]; then
  log "generating DKIM key for ${FIRST_DOMAIN}"
  # Debian ships the daemon as `amavisd` (no `amavisd-new` executable); try it
  # first and keep the old name only as a fallback for non-Debian bases.
  amavisd genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    amavisd-new genrsa "/var/lib/dkim/${FIRST_DOMAIN}.pem" 2048 || \
    log "WARN: DKIM keygen failed (no amavisd binary?)"
fi
chown -R amavis:amavis /var/lib/dkim 2>/dev/null || true

log "starting supervisord"
exec "$@"
