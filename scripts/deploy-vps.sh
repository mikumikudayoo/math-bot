#!/usr/bin/env bash
# Invoke manually ON the prepared VPS, as the deployment account.
set -euo pipefail
revision="${1:-}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: bash scripts/deploy-vps.sh FULL_COMMIT_SHA'; exit 1; }
deploy_root=/srv/math-bot
repo="$deploy_root/repo"
shared="$deploy_root/shared"
release="$deploy_root/releases/$revision"
[[ -d "$repo/.git" && -f "$shared/.env.production" && -f "$shared/.env.ai.production" ]] || { echo 'Prepare the VPS repository, service account, secrets, and systemd units first. See docs/operations.md.'; exit 1; }
mkdir -p "$deploy_root/releases" "$shared/data"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.'; exit 1; }
git -C "$repo" fetch origin
git -C "$repo" cat-file -e "$revision^{commit}"
[[ -n "$(git -C "$repo" for-each-ref --contains "$revision" --format='%(refname)' refs/remotes/origin/)" ]] || { echo 'Revision must be present on origin.'; exit 1; }
[[ ! -e "$release" ]] || { echo 'This release already exists. Inspect it before choosing another revision.'; exit 1; }
git -C "$repo" worktree add --detach "$release" "$revision"
ln -s "$shared/.env.production" "$release/.env.production"
ln -s "$shared/.env.ai.production" "$release/.env.ai.production"
ln -s "$shared/data" "$release/data"
cd "$release"
npm ci
npm run check
npm run build
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
# Validate config before touching the running release. Never print credentials.
BOT_ENV=production node --input-type=module -e 'import {loadConfig} from "./dist/config.js"; import {serviceConfig} from "./dist/service/config.js"; loadConfig(); serviceConfig();'
previous="$(readlink -f "$deploy_root/current" || true)"
if [[ -n "$previous" && "$previous" != "$deploy_root/releases/"* ]]; then echo 'Unexpected current release path.'; exit 1; fi
rollback() {
  echo 'Deployment failed; restoring previous release if available.'
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$deploy_root/current.next"
    mv -Tf "$deploy_root/current.next" "$deploy_root/current"
    sudo systemctl restart math-bot-ai math-bot
  else
    sudo systemctl stop math-bot math-bot-ai
  fi
}
trap rollback ERR
ln -sfn "$release" "$deploy_root/current.next"
mv -Tf "$deploy_root/current.next" "$deploy_root/current"
sudo systemctl restart math-bot-ai math-bot
sleep 3
sudo systemctl is-active --quiet math-bot-ai math-bot
BOT_ENV=production node --input-type=module -e 'import {loadConfig} from "./dist/config.js"; const c=loadConfig(); const r=await fetch(c.serviceURL+"/health",{headers:{Authorization:"Bearer "+c.serviceToken},signal:AbortSignal.timeout(5000)}); if(!r.ok)process.exit(1);'
trap - ERR
echo 'Release started. Check journal logs for Discord login. Slash commands require a separate explicit registration command.'
