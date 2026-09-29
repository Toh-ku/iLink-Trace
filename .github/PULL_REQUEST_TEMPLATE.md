## Summary

<!-- What changed and why? Keep this focused on observable behavior. -->

## Scope

- Milestone/issue:
- Affected packages:
- Out of scope:

## Verification

<!-- List exact commands and results. -->

- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration` when applicable
- [ ] `pnpm build`

## Safety checklist

- [ ] No real iLink/Weixin service was contacted by automated tests.
- [ ] No token, Authorization header, QR secret, user data, or real message was committed.
- [ ] Proxy changes preserve cancellation, size limits, and transparent forwarding.
- [ ] Replay changes remain fail-closed and cannot reach real side-effecting endpoints.
- [ ] Storage or API changes include migration/contract compatibility notes.
- [ ] User-visible behavior and configuration are documented.

## Risks and follow-ups

<!-- State unverified behavior and known limitations explicitly. -->
