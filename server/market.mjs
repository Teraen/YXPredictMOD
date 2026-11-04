// Public market snapshots contain no wallet/observer identifiers.
export function marketSnapshot(room){
 const pools=Array(8).fill(0),prizes=Array(8).fill(0);
 for(const [key,positions]of Object.entries(room.positions))if(!room.forfeited?.[key])positions.forEach((p,i)=>{
  if(p&&!p.resolved&&p.rank===1){pools[i]+=p.stake;prizes[i]+=p.claim??0;}
 });
 return {round:room.round,rates:room.players.map((_,i)=>room.active?.[i]===false||room.ranks[i]?null:room.quoteRates?.[i*8]>0?room.quoteRates[i*8]:null),pools,prizes};
}
export function rememberMarket(room){
 const point=marketSnapshot(room),history=room.marketHistory??=[];
 if(history.at(-1)?.round===point.round)history[history.length-1]=point;
 else {history.push(point);if(history.length>100)history.shift();}
}
export function marketPresentation(rooms,room){
 const current=marketSnapshot(room),history=structuredClone(room.marketHistory??[]);
 if(history.at(-1)?.round===current.round)history[history.length-1]=current;else history.push(current);
 return {kind:'duma-market-v1',code:room.code,round:room.round,status:rooms.availability(room).message,closed:!!room.tradingClosed||room.round>=10,settled:!!room.settled,allInOpen:!!rooms.isOpen(room,true),allInMultiplier:rooms.allInMultiplier(room),
  players:room.players.map((p,i)=>({index:i,name:p.name,horseTitle:room.horseTitles?.[i]??'',rank:room.ranks[i],active:room.active?.[i]??!room.ranks[i]})),history:history.slice(-100)};
}
