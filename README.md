# RAS Product / Deployment Kit

This workspace folder contains the clean product planning artifacts for RunAgentSys RAS deployment package.

RAS package = customer VPS/cloud + RAS1 Hermes Main + RAS2 OpenClaw + Zernio OAuth/secrets + gog CLI + iSocial workflows + customizable CSKH chatbot template.

Do not copy runtime folders such as `.hermes` or `.hermes-cskh` wholesale into a public repo because they may contain secrets, logs, backups, credentials, and state.

Docs:
- `docs/ARCHITECTURE_DECISION_LOCKED.md` — final MVP architecture decision to follow
- `docs/RAS_DEPLOYMENT_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `pricing/RAS_PRICING_MODEL.md`
- `frontend-audit/RUNAGENTSYS_FRONTEND_AUDIT.md`
