# Handoff: mobile quota panel restyle (feat/mobile-quota)

Worktree: /Users/jinhao/agentdeck-mobile-quota  (branch feat/mobile-quota)

## Task
Align the phone drawer's quota area with the desktop compact panel (feat/quota-panel-compact c78f028,
reference /Users/jinhao/reports/agentdeck-quota-panel/after-panel-dark.png): 5h/7d header once; each cell =
% + reset time + thin bar; used up = red cell, ⊘ + reset time only, light-red row; low yellow/red; no data "—" + empty bar;
Claude rows flag only (captain seat gets crown), no CN/US; brand icon colours; tap a row -> popup with account,
exact reset times, source, sample time. Icon-button rules apply. Commit+push, E2E single worker, 390/430 dark/light
screenshots to /Users/jinhao/reports/agentdeck-mobile-quota/, then receipt via $AGENTDECK_BOARD_CLI complete.

## Done
- Merged origin/feat/quota-panel-compact into feat/mobile-quota (commit 8fffda1); resolved quota-core.js
  (summary now returns both `failures` and `source`/`confidence`) and tests/quota-core.test.js (kept both tests).
  `node --test tests/quota-core.test.js` passes.
- No mobile code changed yet.

## Next (plan)
1. New shared UMD `quota-panel-core.js` (QuotaPanelCore): shortReset/longReset (desktop wording), level (10/20),
   pct, meterPct, cells(list, out, recoveryAt) -> always [5h,7d] (blocked-only => out 5h cell). Use it in
   renderer.js renderQuotaBar (replace local helpers ~L3654-3675) and load via index.html script tag + package.json files.
2. mobile-web.js: serve /quota-panel-core.js from repo root (ASSETS currently maps to mobile-web/ dir); add it to
   mobile-web/index.html before app.js. quotaView: pass through sanitized `source` (and confidence) text;
   QuotaCore.mobile: add source/confidence, short names ChatGPT / Grok 4.7 / Gemini (update unit test key list).
3. mobile-web/app.js renderQuota (~L319-435): header row 5h/7d, cells like desktop (.quota-line/.quota-pct/.quota-ban/
   .quota-reset/.quota-meter), name = flag only for Claude seats + crown; drop note lines; tap opens a popover
   (account, seat, both windows with exact reset, source, sample time, 数据已旧/查询失败), Esc/outside tap closes.
   Keep stale/expired/failed dimming (level 'none', grey).
4. mobile-web/style.css: port desktop rules + brand tokens (--brand-claude etc.) for both themes.
5. Update tests/e2e/mobile-web.spec.js 'sidebar' test (L397+) to the new markup; run
   `npx playwright test tests/e2e/mobile-web.spec.js tests/e2e/quota-panel.spec.js --workers=1` with
   AGENTDECK_MOBILE_SCREENSHOT_DIR=/Users/jinhao/reports/agentdeck-mobile-quota; npm test; docs/mobile-web.md.
