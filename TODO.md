# Wownerogue Development Todo

## High Priority
- [ ] **Verify Server Startup**: Ensure `npm run dev` starts cleanly without errors after recent refactors.
- [ ] **Test Payment Flow**: Verify the full payment lifecycle (Request -> QR -> Payment -> Confirmation -> Game Start).
- [ ] **Test Payouts**: Confirm payouts are triggered correctly upon winning in paid modes.
- [ ] **Address Persistence**: Verify that payout addresses persist across server restarts via session tokens.

## Improvements / Refactoring
- [ ] **Error Handling**: Extend `normalizeError` usage to remaining network modules for consistent error reporting.
- [ ] **Configuration Persistence**: Implement persistence for payment configuration updates to support hot reloads.
- [ ] **Monitoring Dashboard**: Build a lightweight dashboard for live metrics (active games, queue length, rate limits).
- [ ] **Frontend Cleanup**: Remove any remaining dead code or unused assets from the `html/` directory.

## Documentation
- [ ] **API Documentation**: Expand API documentation in `README.md` with request/response examples.
- [ ] **Deployment Guide**: Create a detailed deployment guide including reverse proxy setup (Nginx/Caddy).
