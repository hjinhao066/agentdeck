'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('sidebar display: column hierarchy for UI rendering', () => {
  // Simulate the columns and ledger rows that the sidebar would use
  const columns = [
    { id: 'main', isMain: true, taskId: 'main-task', title: '队长' },
    { id: 'sub-capt', parentTaskId: 'main-task', taskId: 'sub-task', subCaptain: true, title: '项目小队长' },
    { id: 'child-1', parentTaskId: 'sub-task', taskId: 'child-task-1', title: '设计审查' },
    { id: 'child-2', parentTaskId: 'sub-task', taskId: 'child-task-2', title: '代码审查' },
    { id: 'other', taskId: 'other-task', title: '其他工作' },
  ];

  // Build the hierarchy tree from columns
  function buildSidebarHierarchy(cols) {
    const byTaskId = new Map(cols.map((c) => [c.taskId, c]));
    const roots = cols.filter((c) => !c.parentTaskId || !byTaskId.has(c.parentTaskId) || c.isMain);

    function nest(col, depth = 0) {
      const children = cols.filter((c) => c.parentTaskId === col.taskId);
      return {
        ...col,
        depth,
        children: children.map((c) => nest(c, depth + 1)),
      };
    }

    return roots.map((r) => nest(r));
  }

  const hierarchy = buildSidebarHierarchy(columns);

  // Verify structure
  assert.equal(hierarchy.length, 2, 'Should have 2 root items: main + other');

  const main = hierarchy.find((h) => h.isMain);
  assert.ok(main, 'Main captain should be in roots');
  assert.equal(main.children.length, 1, 'Main has 1 direct child: sub-captain');
  assert.equal(main.children[0].id, 'sub-capt', 'Child should be sub-captain');
  assert.equal(main.children[0].children.length, 2, 'Sub-captain has 2 children');
  assert.deepEqual(
    main.children[0].children.map((c) => c.id),
    ['child-1', 'child-2'],
    'Sub-captain children should be the design and code reviews'
  );

  const other = hierarchy.find((h) => h.id === 'other');
  assert.ok(other, 'Other work should be in roots');
  assert.equal(other.children.length, 0, 'Other has no children');

  // Verify depths for UI indentation
  assert.equal(main.depth, 0, 'Main at depth 0');
  assert.equal(main.children[0].depth, 1, 'Sub-captain at depth 1');
  assert.equal(main.children[0].children[0].depth, 2, 'Child at depth 2');

  // Helper: render the hierarchy as it would appear in sidebar
  function renderHierarchy(hierarchy) {
    const lines = [];
    function visit(item, prefix = '') {
      const indent = '  '.repeat(item.depth);
      lines.push(indent + item.title + (item.children.length ? ' ▼' : ''));
      for (const child of item.children) {
        visit(child, '  ');
      }
    }
    for (const item of hierarchy) {
      visit(item);
    }
    return lines.join('\n');
  }

  const sidebar = renderHierarchy(hierarchy);
  assert.match(sidebar, /队长 ▼/);
  assert.match(sidebar, /  项目小队长 ▼/);
  assert.match(sidebar, /    设计审查/);
  assert.match(sidebar, /    代码审查/);
  assert.match(sidebar, /其他工作/);

  // Sidebar should show the collapsed/expand indicator
  assert.ok(main.children[0].children.length > 0, 'Sub-captain should have children (can be collapsed)');
  assert.equal(other.children.length, 0, 'Other should have no children (no collapse arrow)');
});

test('sidebar display: collapsible state management', () => {
  // Simulate sidebar state tracking (which column is expanded/collapsed)
  const sidebarState = {
    expandedColIds: new Set(),  // Track which columns are expanded
  };

  function toggleExpanded(colId) {
    if (sidebarState.expandedColIds.has(colId)) {
      sidebarState.expandedColIds.delete(colId);
    } else {
      sidebarState.expandedColIds.add(colId);
    }
  }

  // Test toggle
  assert.equal(sidebarState.expandedColIds.size, 0, 'Initially no columns expanded');

  toggleExpanded('sub-capt');
  assert.ok(sidebarState.expandedColIds.has('sub-capt'), 'Sub-captain should be expanded');

  toggleExpanded('sub-capt');
  assert.ok(!sidebarState.expandedColIds.has('sub-capt'), 'Sub-captain should be collapsed');

  // Render function that respects collapsed state
  function renderWithCollapse(hierarchy, state) {
    const lines = [];
    function visit(item) {
      const indent = '  '.repeat(item.depth);
      const isExpanded = state.expandedColIds.has(item.id);
      const indicator = item.children.length ? (isExpanded ? '▼' : '▶') : '';
      lines.push(indent + item.title + (indicator ? ' ' + indicator : ''));

      // Only show children if expanded
      if (isExpanded) {
        for (const child of item.children) {
          visit(child);
        }
      }
    }
    for (const item of hierarchy) {
      visit(item);
    }
    return lines.join('\n');
  }

  // Build a test hierarchy
  const hierarchy = [
    {
      id: 'main',
      title: '队长',
      depth: 0,
      children: [
        {
          id: 'sub-capt',
          title: '项目小队长',
          depth: 1,
          children: [
            { id: 'child-1', title: '设计', depth: 2, children: [] },
            { id: 'child-2', title: '代码', depth: 2, children: [] },
          ],
        },
      ],
    },
  ];

  // With nothing expanded, main is collapsed too
  const collapsed = renderWithCollapse(hierarchy, sidebarState);
  assert.match(collapsed, /队长 ▶/);  // Main collapsed when not in expandedColIds
  assert.ok(!collapsed.includes('项目小队长'), 'Sub-captain hidden when main collapsed');

  // Expand main to see sub-captain
  sidebarState.expandedColIds.add('main');
  const withMain = renderWithCollapse(hierarchy, sidebarState);
  assert.match(withMain, /队长 ▼/);
  assert.match(withMain, /  项目小队长 ▶/);  // Sub-captain collapsed
  assert.ok(!withMain.includes('  设计'), 'Children hidden when sub-captain collapsed');

  // Expand sub-captain
  sidebarState.expandedColIds.add('sub-capt');
  const expanded = renderWithCollapse(hierarchy, sidebarState);
  assert.match(expanded, /队长 ▼/);
  assert.match(expanded, /  项目小队长 ▼/);
  assert.match(expanded, /    设计/);
  assert.match(expanded, /    代码/);
});
