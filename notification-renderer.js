window.notification.onItems((items) => {
  const host = document.getElementById('items');
  host.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = item.state;
    card.dataset.columnId = item.id;
    const open = document.createElement('button');
    open.className = 'open';
    const label = document.createElement('small');
    label.textContent = item.state === 'input' ? 'AGENTDECK · 等你回复' : 'AGENTDECK · 本轮输出已停止';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const hint = document.createElement('small');
    hint.textContent = '点击跳到这个对话，继续输入';
    open.append(label, title, hint);
    open.onclick = () => window.notification.open(item.id);
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭通知');
    close.onclick = () => window.notification.dismiss(item.id);
    card.append(open, close);
    host.append(card);
  }
});
