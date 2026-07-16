# RAS Product Implementation Plan

## Audit nghĩa là gì?

Audit là bước kiểm kê và xác minh hiện trạng trước khi triển khai: đang có service nào, repo nào, config nào, thành phần nào dùng được, thành phần nào thiếu, rủi ro bảo mật/chi phí/deploy ở đâu. Mục tiêu là tránh đoán sai kiến trúc và tránh bê nhầm runtime chứa secret vào repo product.

## Workstreams

### A. Product repo readiness

Status:
- No dedicated product repo yet.
- GitHub CLI token invalid; cannot create/push remote safely now.

Tasks:
1. Create local clean skeleton under `projects/ras-product`.
2. Add docs, templates, compose skeleton, deploy scripts.
3. Add `.gitignore` and `.env.example`.
4. Owner confirms GitHub repo name.
5. Re-auth `gh` or provide valid GitHub token.
6. Create remote repo and push.

Recommended repo name:
- `ras-deployment-kit`
- Alternative: `runagentsys-ras-stack`, `ras-customer-deploy`, `runagentsys-product`

### B. RAS1 Hermes Main

Tasks:
1. Inventory Hermes main runtime.
2. Identify reusable skills/tools vs local secrets/state.
3. Define Hermes customer config template.
4. Add chatbot CSKH template derived from Hermes-CSKH.
5. Add social/iSocial connector checklist.

### C. RAS2 OpenClaw

Tasks:
1. Inventory installed content/video plugins.
2. Define task API/contract from RAS1 to RAS2.
3. Create sample content/video task flow.
4. Add asset storage template.

### D. Zernio

Tasks:
1. Locate actual Zernio implementation/API/CLI/spec.
2. Define adapter interface.
3. Implement mock/dry-run adapter first.
4. Add OAuth2/secret reference conventions.
5. Add provider onboarding flows.

### E. gog CLI

Tasks:
1. Verify gog CLI availability.
2. Create customer Google Workspace onboarding guide.
3. Define per-customer account isolation.
4. Add lead-to-Sheets sample.

### F. Frontend

Tasks:
1. Audit current RunAgentSys landing page.
2. Confirm it sells full setup package, not just chatbot/VPS/source code.
3. Confirm quick contact widget is prominent.
4. Add package explanation: RAS1 + RAS2 + Zernio + gog + iSocial.
5. Add realistic pricing and CTA.

### G. Pricing

Tasks:
1. Estimate fixed and variable costs.
2. Define setup fee + monthly managed fee.
3. Separate base package vs add-ons.
4. Include margin and support risk.

## Suggested Timeline

### Day 1
- Create local repo skeleton.
- Write architecture docs.
- Write config templates.
- Audit frontend and cost.

### Day 2
- Add deploy skeleton.
- Add Zernio adapter mock.
- Add Hermes-CSKH template extraction.
- Add first Telegram customer-care sample.

### Day 3
- Add gog CLI onboarding sample.
- Add RAS1→RAS2 task mock.
- Add test scripts.

### Day 4+
- Connect real Zernio once actual API/CLI is confirmed.
- Deploy to test VPS.
- Harden security and docs.
