# Handoff: mobile quota panel (feat/mobile-quota)

Worktree: /Users/jinhao/agentdeck-mobile-quota  (branch feat/mobile-quota)

## Task
Phone drawer shows each account's quota (Claude CN / US, Codex, Cursor, Gemini): remaining % and reset time,
readable at 390 wide, dark + light, same data as the desktop (QuotaCore.mobile -> GET /api/quota). Unknown says 未知,
never an invented number. Icon-button rules apply. Push the branch; no merge, no packaging, no restart.

## Done in this WIP commit (unit tests pass, E2E does NOT pass yet)
- mobile-web/app.js: rows are now a compact grid (5h / 7d always two columns; % + reset + thin meter; exhausted =
  ban icon + recovery time on a tinted row; missing window = "—"; no data = 未知 across both columns; note line only
  for 数据已旧 / 查询失败). Tapping a row opens a details sheet over the drawer (#quota-sheet: both windows with exact
  reset, 状态, 账号, 来源, 采样; close icon button, Esc, tap outside). The old inline expand is gone.
- mobile-web/index.html: #quota-columns header (5h / 7d), #quota-sheet + #quota-sheet-scrim.
- mobile-web/style.css: quota block rewritten, brand colour tokens for both themes, sheet styles.
- quota-core.js / mobile-web.js: rows carry a sanitized `source` (max 60 chars); Cursor's short name is now "Cursor"
  (was "Grok"), and the Cursor row uses the Cursor mark.
- tests/quota-core.test.js, tests/mobile-web.test.js updated; `node --test` on those two files: 70 pass.
- tests/e2e/mobile-web.spec.js 'sidebar' test rewritten for the new markup and the sheet.

## Known problem (where I stopped)
- E2E 'sidebar' fails at the header alignment check (~L443): the #quota-columns spans sit 25px to the right of the
  row cells (110/216 vs 85/191). Cause not found yet. Suspects: a scrollbar in .quota-rows, or .quota-name not
  growing inside the wrapping flex row. Everything after that assertion in the test has never run.

## Not done
- Fix the alignment, then get `npx playwright test tests/e2e/mobile-web.spec.js --workers=1` green with
  AGENTDECK_MOBILE_SCREENSHOT_DIR=/Users/jinhao/reports/agentdeck-mobile-quota (writes sidebar-390/430-dark/light,
  quota-detail-390-dark/light). The screenshots in that directory are still from the OLD layout.
- Look at the new screenshots in both themes and tune; full `npm test`; docs/mobile-web.md (L74-79, L133) still
  describes the inline expand and has no `source` field.
- Design choices to report to the user: "Cursor" instead of the desktop's "Grok 4.7" / "Codex" instead of "ChatGPT";
  details in a bottom sheet instead of inline; desktop renderer.js left untouched (no shared quota-panel-core.js).
- Delete this file when finished.
