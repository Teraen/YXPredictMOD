// Mirrors Core/EliminationPlan.cs. Final ordering inside a cohort does not affect payouts.
export function eliminationPlan(incoming,observed,dead,previous,previousMin,previousMax,previousRounds) {
 const p={ranks:Array(8).fill(0),minimum:Array(8).fill(0),maximum:Array(8).fill(0),rounds:Array(8).fill(0)},alive=dead.filter(x=>!x).length;
 for(let i=0;i<8;i++){
  if(!dead[i]&&(incoming[i]>0||previous[i]>0||observed[i]>0))throw Error('存活状态与出局记录冲突');
  if(previousRounds[i]>0&&observed[i]>0&&previousRounds[i]!==observed[i])throw Error('出局轮次冲突');
  p.rounds[i]=previous[i]>0&&previousRounds[i]===0?0:previousRounds[i]>0?previousRounds[i]:observed[i];
  if(dead[i]&&!p.rounds[i]&&incoming[i]>0)p.minimum[i]=p.maximum[i]=incoming[i];
  if(previous[i]>0){p.minimum[i]=previousMin[i]||previous[i];p.maximum[i]=previousMax[i]||previous[i];if(incoming[i]>0&&(incoming[i]<p.minimum[i]||incoming[i]>p.maximum[i]))throw Error('已结算名次区间冲突');}
 }
 for(let i=0;i<8;i++){
  const round=p.rounds[i];if(!dead[i]||!round||p.rounds.slice(0,i).includes(round))continue;
  let count=0,earlier=0,later=0;for(let j=0;j<8;j++)if(dead[j]){if(p.rounds[j]===round)count++;else if(p.rounds[j]>round)later++;else if(p.rounds[j]>0)earlier++;}
  let chosen=0,choices=0;
  for(let low=alive+1+later;low+count-1<=8-earlier;low++){
   const high=low+count-1;let valid=true;
   for(let j=0;j<8;j++)if(dead[j]){
    if(p.rounds[j]===round){if(incoming[j]>0&&(incoming[j]<low||incoming[j]>high))valid=false;if(previous[j]>0&&(p.minimum[j]!==low||p.maximum[j]!==high))valid=false;}
    else{if(incoming[j]>=low&&incoming[j]<=high)valid=false;if(p.rounds[j]>0&&incoming[j]>0&&(p.rounds[j]<round?incoming[j]<=high:incoming[j]>=low))valid=false;if(previous[j]>0&&p.minimum[j]<=high&&p.maximum[j]>=low)valid=false;}
   }
   if(valid){chosen=low;choices++;}
  }
  if(choices!==1)throw Error('等待完整同轮出局名单');
  for(let j=0;j<8;j++)if(p.rounds[j]===round){p.minimum[j]=chosen;p.maximum[j]=chosen+count-1;}
 }
 const used=new Set();for(let i=0;i<8;i++)if(previous[i]>0){p.ranks[i]=previous[i];used.add(previous[i]);}
 for(let i=0;i<8;i++)if(!p.ranks[i]&&p.minimum[i]>0){let rank=incoming[i];if(rank<p.minimum[i]||rank>p.maximum[i]||used.has(rank)){rank=p.minimum[i];while(rank<=p.maximum[i]&&used.has(rank))rank++;}if(rank>p.maximum[i])throw Error('出局名次区间冲突');p.ranks[i]=rank;used.add(rank);}
 const known=p.ranks.filter(Boolean).length;if(p.ranks.some(rank=>rank>0&&rank<=8-known))throw Error('出局名次尚未对齐');return p;
}
export function intervalReturn(claim,predicted,minimum,maximum){if(!predicted||!minimum)return 0;if(minimum!==maximum)return predicted>=minimum&&predicted<=maximum?claim:0;return predicted===minimum?claim:Math.abs(predicted-minimum)===1?Math.floor(claim/4):0;}

export function championReturn(claim,minimum,maximum){return minimum<1||maximum<minimum?0:minimum===1?claim:minimum===2?Math.floor(claim/4):minimum===3?Math.floor(claim/10):0;}
