export function wagerFactorBps(selected, total) {
  if (total <= 0) return 10000;
  return Math.max(7500, Math.min(12500, Math.round(10000 * (1 + 0.25 * (1 - 8 * selected / total)))));
}
export function quoteRates(base, totals, championOnly = false, bonusBps = 10000) {
  if(!Number.isSafeInteger(bonusBps)||bonusBps<10000||bonusBps>11500)throw new Error('Invalid event bonus');
  const factors=Array(64).fill(10000),rates=Array(64).fill(0);
  for(let i=0;i<8;i++){
    const total=championOnly?totals.reduce((sum,row)=>sum+row[0],0):totals[i].reduce((a,b)=>a+b,0);
    for(let rank=0;rank<8;rank++){const at=i*8+rank;factors[at]=wagerFactorBps(totals[i][rank],total);rates[at]=eventQuote(base[at],factors[at],bonusBps);}
  }
  return {factors,rates};
}

export function eventQuote(base,factor,bonusBps=10000){
  if(!Number.isSafeInteger(bonusBps)||bonusBps<10000||bonusBps>11500)throw new Error('Invalid event bonus');
  const normal=base<=0?0:Math.max(10100,Math.min(500000,Math.floor(base*factor/10000)));
  return Math.floor(normal*bonusBps/10000);
}

export function sale(claim, rate, half) {
  const removed=half?Math.floor(claim/2):claim;
  return rate<=0?0:Number(BigInt(removed)*10000n*97n/(BigInt(rate)*100n));
}
// Payout claims retain the public fill price. New liquidation units use prices
// excluding the owner's entire frozen book at both entry and exit.
export function cashout(position, removed, publicRate, personalRate) {
  const basis=position.saleBasis;
  if(!basis)return {returned:sale(removed,publicRate,false)};
  const legacyRemoved=Number(BigInt(basis.legacyClaim)*BigInt(removed)/BigInt(position.claim));
  const newClaim=position.claim-basis.legacyClaim,newRemoved=removed-legacyRemoved;
  const unitsRemoved=newClaim>0?Number(BigInt(basis.units)*BigInt(newRemoved)/BigInt(newClaim)):0;
  return {returned:sale(legacyRemoved,publicRate,false)+sale(unitsRemoved,personalRate,false),
    saleBasis:{legacyClaim:basis.legacyClaim-legacyRemoved,units:basis.units-unitsRemoved}};
}
export function returnFor(claim, predicted, finalRank, championOnly=false){return championOnly?(finalRank===1?claim:finalRank===2?Math.floor(claim/4):finalRank===3?Math.floor(claim/10):0):predicted===finalRank?claim:Math.abs(predicted-finalRank)===1?Math.floor(claim/4):0;}
