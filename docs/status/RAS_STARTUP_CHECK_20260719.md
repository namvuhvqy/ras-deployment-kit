# RAS Startup Check — 2026-07-19

## Kết luận

Trạng thái: **GO cho triển khai MVP có kiểm soát**.

## Context đã xác nhận

- State files tồn tại:
  - `/opt/data/projects/ras/RAS_PROJECT_STATE.md`
  - `/opt/data/projects/ras/RAS_DAILY_DIGEST.md`
  - `/opt/data/projects/ras/ras-zernio-architecture-final.md`
- Cron báo cáo hằng ngày đã có:
  - Name: `RAS daily MD report 17h VN`
  - Schedule: `0 10 * * *` = 17:00 Asia/Saigon
  - Deliver: `origin`
  - Toolsets: `file`, `terminal`
- Topic RAS đã map trong memory:
  - PMO 27
  - Backend 28
  - Zernio 29
  - Frontend 30
  - Marketing 31
  - Sales 32
  - Ops 33

## Repo / code

- `ras-deployment-kit` remote reachable.
- Current HEAD: `f1d2fe9 Lock RAS architecture decision`.
- Landing page build OK: `next build` compiled successfully.
- Vercel CLI chưa có trong container / project chưa link `.vercel`.
- `gh` CLI chưa có trong container, nhưng git remote fetch OK.

## VPS

- Target VPS: `100.127.124.58` qua `tailscale0`.
- SSH handshake OK, nhưng container hiện không có SSH key/password automation sẵn để login non-interactive.
- Cần thêm key deploy hoặc cài/cấp `sshpass`/secret đúng cách trước khi tự động deploy.

## Blockers nhẹ

1. Chưa login SSH non-interactive vào VPS từ container.
2. Chưa có Vercel CLI/link để kiểm tra/deploy landing trực tiếp.
3. Chưa có `gh` CLI để tạo PR/release bằng lệnh `gh`.

## Quyết định triển khai

Bắt đầu theo hướng repo sạch:

1. Skeleton monorepo:
   - `apps/ras-api`
   - `apps/ras-worker`
   - `packages/zernio-adapter`
   - `packages/queue`
   - `packages/shared`
   - `infra/docker`
   - `scripts`
   - `tests`
2. Ưu tiên mock/dry-run adapter trước khi đụng OAuth/Zernio live.
3. Không copy runtime Hermes/OpenClaw/ZaloCRM có secret vào repo.
