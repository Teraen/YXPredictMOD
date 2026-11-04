// Reproduce observer/quotes.py sources() for an hourly room's frozen opening roster.
// Only the observer assigns the five electronic titles, and never includes AI in the draw.
const humanTitles = new Set(['特等马', '上等马', '中等马', '牛马', '海马', '未定马']);
const aiTitles = new Set(['电子马·地狱', '电子马·极难', '电子马·困难', '电子马·中等', '电子马·简单']);

export function shuffleReveal(room) {
  if (!room.eventSlot || !room.horseShuffle || !(room.tradingClosed || room.ended || room.settled)) return null;
  const titles = room.horseTitles;
  if (titles?.length !== 8 || !titles.every(t => humanTitles.has(t) || aiTitles.has(t))) return null;

  const humans = room.players.map((player, index) => index).filter(i => humanTitles.has(titles[i]));
  const uid = i => room.players[i].uid;
  humans.sort((a, b) => Buffer.compare(Buffer.from(uid(a)), Buffer.from(uid(b))));
  const transfers = [];
  if (humans.length >= 2) {
    const modulus = 2147483647;
    let seed = 17;
    for (const ch of room.gameId + ':horse-shuffle-v1' + humans.map(uid).join('')) {
      seed = (seed * 131 + ch.codePointAt(0)) % modulus;
    }
    const draw = () => (seed = (seed * 48271 + 1) % modulus);
    const count = Math.min(humans.length, 2 + draw() % 2);
    for (let i = humans.length - 1; i > 0; i--) {
      const other = draw() % (i + 1);
      [humans[i], humans[other]] = [humans[other], humans[i]];
    }
    for (let i = 0; i < count; i++) {
      const to = humans[i], from = humans[(i + 1) % count];
      transfers.push({fromSeat: from + 1, fromName: room.players[from].name, toSeat: to + 1, toName: room.players[to].name, title: titles[to]});
    }
    transfers.sort((a, b) => a.toSeat - b.toSeat);
  }
  return {kind: 'duma-public-v1', noticeType: 'shuffle', code: room.code, round: Math.max(room.round, room.liveRound ?? 0),
    tradingClosed: true, settled: !!room.settled, players: [], battles: [], shuffleTransfers: transfers};
}
