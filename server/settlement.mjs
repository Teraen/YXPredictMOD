/** Read-only per-room cash accounting. Grants and other games never enter this report. */
export function settlementReport(rooms,r){
 if(!r.settled)return null;
 const keys=new Set([...Object.keys(r.positions),...Object.keys(r.cashflows??{}),...Object.keys(r.actionCounts??{})]),groups=new Map();
 for(const key of keys){
  const ps=r.positions[key]??[],flow=r.cashflows?.[key],counts=r.actionCounts?.[key]??[];
  if(!flow&&!ps.some(Boolean)&&!counts.some(Boolean))continue;
  const a=rooms.state.accounts[key];if(!a||a.systemObserver)continue;
  // Legacy rooms with exactly one buy on every populated position are provable.
  // More complicated old history has no sale ledger and must stay unknown.
  const simple=!flow&&counts.length>0&&counts.every((n,i)=>n===(ps[i]?1:0));
  const known=flow?.known??simple,invested=flow?.invested??(simple?ps.reduce((n,p)=>n+(p?.stake??0),0):null),sold=flow?.sold??(simple?0:null),payout=r.payouts[key]??0;
  const identity=a.webOwner??key,row=groups.get(identity)??{name:rooms.displayName(key),invested:0,sold:0,payout:0,known:true};
  row.known&&=known;row.invested+=invested??0;row.sold+=sold??0;row.payout+=payout;groups.set(identity,row);
 }
 return {closing:'本局落幕，感谢各位仙友参与。马币已结算，期待下场再会。',rows:[...groups.values()].map(r=>({...r,invested:r.known?r.invested:null,sold:r.known?r.sold:null,net:r.known?r.payout+r.sold-r.invested:null}))};
}
