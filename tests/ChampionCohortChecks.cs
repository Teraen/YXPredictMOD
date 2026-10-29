using System;
using YxPrediction;
internal static partial class Program
{
    static void ChampionCohortChecks()
    {
        Check("champion co-eliminations pay the highest percentage in the interval immediately and never twice", delegate
        {
            foreach(int minimum in new[]{2,3,4}) foreach(int player in new[]{minimum-1,minimum})
            {
                var s=Snapshot(1);s.EliminationRounds=new int[8];var b=new PredictionBook(1000);var m=b.Observe(s,Ratings(false));
                Equal(Buy(b,s,player,1,101),null);long claim=m.Positions[player].Claim;
                s.Round=9;s.TradingOpen=false;s.RoundResultsComplete=true;
                for(int i=1;i<8;i++){s.States[i]=new PlayerState(0,0,0,i+1);s.EliminationRounds[i]=10-i;}
                s.EliminationRounds[minimum]=s.EliminationRounds[minimum-1];
                s.States[minimum-1]=s.States[minimum]=new PlayerState(0,0,0,0);
                Array.Reverse(s.Players);Array.Reverse(s.States);Array.Reverse(s.EliminationRounds);b.Observe(s,null);
                long payout=minimum==2?claim/4:minimum==3?claim/10:0;
                Equal(m.Positions[player].FinalPayout,payout);True(m.Positions[player].Resolved&&!m.Settled);Equal(b.Balance,899L+payout);
                b=Reload(b);b.Observe(s,null);Equal(b.Balance,899L+payout);
                s.Ended=true;s.Round=15;s.Ranks=new[]{8,7,6,5,4,3,2,1};
                int a=7-(minimum-1),c=7-minimum;int temp=s.Ranks[a];s.Ranks[a]=s.Ranks[c];s.Ranks[c]=temp;
                b.Observe(s,null);True(b.Find(s.Id).Settled);Equal(b.Balance,899L+payout);b=Reload(b);b.Observe(s,null);Equal(b.Balance,899L+payout);
            }
        });
        Check("champion singleton third still pays ten percent with interval metadata and rejects all non-champion new bets", delegate
        {
            var s=Snapshot(1);s.EliminationRounds=new int[8];var b=new PredictionBook(1000);var m=b.Observe(s,Ratings(false));Buy(b,s,2,1,101);long claim=m.Positions[2].Claim;
            for(int rank=2;rank<=8;rank++)True(Buy(b,s,1,rank,10)!=null);
            s.Round=9;s.Ended=true;s.Ranks=new[]{1,2,3,4,5,6,7,8};b.Observe(s,null);
            Equal(m.Positions[2].FinalPayout,claim/10);Equal(b.Balance,899L+claim/10);b=Reload(b);Equal(b.Balance,899L+claim/10);
        });
    }
}
