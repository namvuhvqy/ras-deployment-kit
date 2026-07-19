#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${VPS_HOST:-100.127.124.58}"
VPS_USER="${VPS_USER:-root}"
VPS_PATH="${VPS_PATH:-/opt/ras-deployment-kit}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

if [[ -z "${SSHPASS:-}" ]]; then
  echo "SSHPASS is required for password deploy, or run this script from an SSH-authenticated shell." >&2
  exit 2
fi

sshpass -e ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "mkdir -p ${VPS_PATH}"
if command -v rsync >/dev/null 2>&1; then
  RSYNC_RSH="sshpass -e ssh ${SSH_OPTS[*]}" rsync -az --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude .git \
    --exclude .env \
    --exclude .env.staging \
    ./ "${VPS_USER}@${VPS_HOST}:${VPS_PATH}/"
else
  tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=.env.staging -czf - . \
    | sshpass -e ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "rm -rf ${VPS_PATH}.tmp && mkdir -p ${VPS_PATH}.tmp && tar -xzf - -C ${VPS_PATH}.tmp && cp -n ${VPS_PATH}/.env.staging ${VPS_PATH}.tmp/.env.staging 2>/dev/null || true && rm -rf ${VPS_PATH} && mv ${VPS_PATH}.tmp ${VPS_PATH}"
fi
sshpass -e ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_HOST}" "cd ${VPS_PATH} && test -f .env.staging || cp .env.staging.example .env.staging && if docker compose version >/dev/null 2>&1; then docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build && docker compose --env-file .env.staging -f docker-compose.staging.yml ps; elif command -v docker-compose >/dev/null 2>&1; then docker-compose --env-file .env.staging -f docker-compose.staging.yml up -d --build && docker-compose --env-file .env.staging -f docker-compose.staging.yml ps; else echo 'docker compose plugin/docker-compose missing on VPS' >&2; exit 3; fi"
