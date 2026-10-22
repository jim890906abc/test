// What the tray says about a message that is waiting to cut in (插隊). Kept
// apart from the composer so the wording can be tested without a browser.

// Why a message cut in (插隊) is still waiting, from what the hub knows
// (server/adapters/kimi-remote.js: cutInWhy, handoff). `name`: Kimi or DeepSeek.
// Null when the message is not waiting to cut in, or was not refused yet.
export function cutInWhyText(q, name = 'Kimi') {
  if (!q?.cutIn || q.steered || !q.cutInWhy) return null;
  if (q.cutInWhy === 'not-pending') return `${name} 那邊找不到這則排隊的訊息，正在核對`;
  if (q.cutInWhy === 'other') return `${name} 沒收下這則插隊${q.cutInMsg ? `（${q.cutInMsg}）` : ''}；每 2 秒再試一次`;
  // 'kimi-turn': the running turn is one the agent started itself (a background task finished).
  const own = `${name} 正在自己接續的回合（背景工作完成後自動開始），這種回合不收插隊`;
  // Sent again by the hub once already: not stopped a second time.
  if (q.handedOff) return `${own}。這則訊息已經接手重送過一次，不會再停它，這一輪結束就會讀到`;
  switch (q.handoff) {
    case 'grace':
      return `${own}。它若沒在幾秒內收尾，會在下一個安全點接手：先讓它讀你的訊息，背景工作照常進行`;
    case 'tool':
      return `${own}。它現在有工具在前景執行，等這個工具做完就接手，不會中斷工具`;
    case 'swarm':
      return `${own}。它在前景跑子代理群，沒辦法移到背景；要現在讀到，按「移到背景」中斷子代理群`;
    case 'approval':
      return `${own}。它在等你批准或回答，處理完就接手`;
    case 'working':
      return '正在接手：停下這一輪，把訊息重新送出…';
    default:
      return `${name} 暫時沒收這則插隊（正在換回合）；每 2 秒再試一次`;
  }
}
