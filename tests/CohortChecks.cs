using System;
using System.Collections.Generic;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void CohortChecks()
    {
        Check("two simultaneous seventh/eighth eliminations pay either rank fully and sixth nothing before final ranks", delegate
        {
            foreach(int player in new[]{6,7}) foreach(int predicted in new[]{6,7,8}) foreach(bool duplicate in new[]{false,true})
            {
                var s=Snapshot(4);s.EliminationRounds=new int[8];var b=TradeBook(s);Equal(Buy(b,s,player,predicted,100),null);
                var m=b.Find(s.Id);long claim=m.Positions[player].Claim;
                s.Round=5;s.TradingOpen=false;s.RoundResultsComplete=true;s.EliminationRounds[6]=s.EliminationRounds[7]=5;
                s.States[6]=new PlayerState(-1,2,3,duplicate?7:0);s.States[7]=new PlayerState(-99,2,3,duplicate?7:0);
                b.Observe(s,null);True(!m.Settled&&m.Positions[player].Resolved);Equal(m.RankMinimum[player],7);Equal(m.RankMaximum[player],8);
                Equal(b.Balance,900L+(predicted==6?0:claim));b=Reload(b);b.Observe(s,null);Equal(b.Balance,900L+(predicted==6?0:claim));
                s.Ended=true;s.Ranks=new[]{1,2,3,4,5,6,8,7};b.Observe(s,null);True(b.Find(s.Id).Settled);Equal(b.Balance,900L+(predicted==6?0:claim));
                b=Reload(b);b.Observe(s,null);Equal(b.Balance,900L+(predicted==6?0:claim));
            }
        });
        Check("three simultaneous eliminations include the whole sixth-through-eighth interval but exclude fifth", delegate
        {
            foreach(int rank in new[]{5,6,7,8})
            {
                var s=Snapshot(4);s.EliminationRounds=new int[8];var b=TradeBook(s);Buy(b,s,5,rank,101);var m=b.Find(s.Id);long claim=m.Positions[5].Claim;
                s.Round=5;s.RoundResultsComplete=true;
                for(int i=5;i<8;i++){s.States[i]=new PlayerState(0,2,3,0);s.EliminationRounds[i]=5;}
                b.Observe(s,null);Equal(b.Balance,899L+(rank==5?0:claim));True(m.Positions[5].Resolved);b=Reload(b);Equal(b.Find(s.Id).RankMinimum[5],6);
            }
        });
        Check("different elimination rounds in one late snapshot remain single payouts with adjacent compensation", delegate
        {
            var s=Snapshot(4);s.EliminationRounds=new int[8];var b=TradeBook(s);Buy(b,s,7,7,101);Buy(b,s,6,8,101);var m=b.Find(s.Id);
            long expected=798L+m.Positions[7].Claim/4+m.Positions[6].Claim/4;
            s.Round=7;s.States[7]=new PlayerState(-1,2,3,8);s.EliminationRounds[7]=5;s.States[6]=new PlayerState(-1,3,3,7);s.EliminationRounds[6]=6;
            b.Observe(s,null);Equal(b.Balance,expected);Equal(m.RankMinimum[7],8);Equal(m.RankMaximum[6],7);b=Reload(b);Equal(b.Balance,expected);
        });
        Check("a later cohort occupies sixth/seventh without including an earlier eighth-place exit", delegate
        {
            var s=Snapshot(1);s.EliminationRounds=new int[8];var b=TradeBook(s);Buy(b,s,6,6,100);Buy(b,s,5,8,100);var m=b.Find(s.Id);long claim=m.Positions[6].Claim;
            s.Round=2;s.States[7]=new PlayerState(0,0,2,8);s.EliminationRounds[7]=2;b.Observe(s,null);
            s.Round=4;s.States[5]=s.States[6]=new PlayerState(0,2,2,0);s.EliminationRounds[5]=s.EliminationRounds[6]=4;
            Array.Reverse(s.Players);Array.Reverse(s.States);Array.Reverse(s.EliminationRounds);b.Observe(s,null);
            Equal(m.RankMinimum[6],6);Equal(m.RankMaximum[6],7);Equal(b.Balance,800L+claim);Equal(m.Positions[5].FinalPayout,0L);
        });
        Check("partial battle deliveries cannot pay singleton adjacency before the full simultaneous result", delegate
        {
            var s=Snapshot(4);s.EliminationRounds=new int[8];var b=TradeBook(s);Buy(b,s,7,6,100);var m=b.Find(s.Id);
            s.Round=5;s.TradingOpen=false;s.States[7]=new PlayerState(0,2,3,7);s.EliminationRounds[7]=5;b.Observe(s,null);
            Equal(b.Balance,900L);True(!m.Positions[7].Resolved);
            s.States[6]=new PlayerState(0,2,3,0);s.EliminationRounds[6]=5;s.RoundResultsComplete=true;b.Observe(s,null);
            True(m.Positions[7].Resolved);Equal(m.Positions[7].FinalPayout,0L);Equal(b.Balance,900L);
        });
        Check("single elimination still pays one quarter and grouped paid positions cannot be enlarged or resurrected", delegate
        {
            var s=Snapshot(4);s.EliminationRounds=new int[8];var b=TradeBook(s);Buy(b,s,7,7,101);var m=b.Find(s.Id);long expected=899L+m.Positions[7].Claim/4;
            s.Round=5;s.States[7]=new PlayerState(0,2,3,0);s.EliminationRounds[7]=5;b.Observe(s,null);Equal(b.Balance,expected);
            s.States[6]=new PlayerState(0,2,3,0);s.EliminationRounds[6]=5;b.Observe(s,null);Equal(b.Balance,expected);True(!m.TradingWindowOpen);
        });
        Check("upgrading a previously paid legacy pair does not block new cohort settlements", delegate
        {
            var s=Snapshot(1);var b=TradeBook(s);Buy(b,s,5,5,100);var m=b.Find(s.Id);long claim=m.Positions[5].Claim;
            s.Round=2;s.States[6]=new PlayerState(0,0,2,7);s.States[7]=new PlayerState(0,0,2,8);b.Observe(s,null);b=Reload(b);
            s.EliminationRounds=new[]{0,0,0,0,0,0,2,2};b.Observe(s,null);True(b.Find(s.Id).TradingWindowOpen);
            s.Round=4;s.States[4]=s.States[5]=new PlayerState(0,2,2,0);s.EliminationRounds[4]=s.EliminationRounds[5]=4;b.Observe(s,null);
            Equal(b.Balance,900L+claim);True(b.Find(s.Id).Positions[5].Resolved);b=Reload(b);Equal(b.Balance,900L+claim);
        });
        Check("old saves without cohort fields keep their recorded payouts", delegate
        {
            var s=Snapshot(1);var b=TradeBook(s);Buy(b,s,7,7,100);s.Round=2;s.States[7]=new PlayerState(0,0,2,8);b.Observe(s,null);
            var data=BookCodec.Write(b);var row=TradingRow(data);row.Remove("rankMinimum");row.Remove("rankMaximum");row.Remove("eliminationRounds");
            long balance=b.Balance;b=BookCodec.Read(data);b.Observe(s,null);Equal(b.Balance,balance);
        });
    }
}
