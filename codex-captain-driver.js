'use strict';

// One owner schedules native tool-output turns; it never drains receipt queues.
function createDriver({ rpc, snapshot, acknowledge, intervalMs = 60000, onError = () => {} }) {
  let threadId = '', busy = false, checking = false, due = false, closed = false, generation = 0;
  let activeTurnId = '';
  const deliveries = new Map(), completed = new Map();
  async function finish(id, status) {
    const ids = deliveries.get(id);
    if (!ids) { if (checking) completed.set(id, status); return; }
    deliveries.delete(id);
    if (status === 'completed' && ids.length) {
      try { await acknowledge(ids); } catch (error) { onError(error); }
    }
  }
  async function check() {
    if (closed || busy || checking || !due || !threadId) return;
    checking = true;
    const id = threadId, gen = generation;
    try {
      const board = await snapshot();
      if (closed || generation !== gen || busy) return;
      due = false;
      if (!board.active) return;
      busy = true;
      const result = await rpc('turn/start', { threadId: id, input: [], toolOutput: {
        name: 'agentdeck_board_check', output: JSON.stringify({
          reason: '自动巡检任务看板', unreadReceipts: board.unread, openTasks: board.open,
          receipts: board.receipts || [],
          instruction: '这是宿主定时事件，无需用户新消息。回执已通过只读快照附在本工具结果中，不再调用 receipts 消费它们；宿主仅在本轮成功结束后确认这些receiptId。先 task list 查看整个任务看板，验收回执结果，核对状态，解决能自行解决的阻塞，按依赖和空位续派。按receiptId与已有任务状态核对重试，已验收/已派发的事不重复执行。不要凭 ledger 的 done 宣称完成。不要挂 receipts --wait 后台监听，宿主已有唯一巡检驱动；不经过终端输入框。需要用户决定的事记录为 needs_user，其他事继续推进。',
        }),
      } });
      if (closed || generation !== gen) return;
      deliveries.set(result.turn.id, (board.receipts || []).map((r) => r.receiptId));
      if (completed.has(result.turn.id)) {
        const status = completed.get(result.turn.id); completed.delete(result.turn.id);
        await finish(result.turn.id, status);
      }
    } catch (error) {
      // No receipt was consumed. Retry on the next tick, not in a tight loop.
      if (generation === gen) { busy = !!activeTurnId; due = true; }
      onError(error);
    } finally {
      checking = false;
      if (due && !busy && generation !== gen) void check();
    }
  }
  const timer = setInterval(() => { due = true; void check(); }, intervalMs);
  return {
    bind(id) { threadId = id; generation++; activeTurnId = ''; busy = false; due = false; deliveries.clear(); completed.clear(); },
    event(method, params) {
      if (closed || params.threadId !== threadId) return;
      if (method === 'turn/started') { busy = true; activeTurnId = params.turn.id; }
      if (method === 'turn/completed') {
        if (activeTurnId === params.turn.id) activeTurnId = '';
        // Do not race the next snapshot against this turn's acknowledgement.
        const gen = generation;
        void finish(params.turn.id, params.turn.status).finally(() => { if (gen === generation) { busy = false; void check(); } });
      }
    },
    requestCheck() { due = true; return check(); },
    close() { closed = true; clearInterval(timer); },
  };
}

module.exports = { createDriver };
