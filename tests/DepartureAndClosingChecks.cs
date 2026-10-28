using System;
using System.Collections.Generic;
using Yx.ModSdk.Testing;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void DepartureAndClosingChecks()
    {
        Check("confirmed departure forfeits all-in wagers, grants relief once and never rewards later results", delegate
        {
            using (var host = TestHost.Start())
            {
                var mod = host.Load<PredictionMod>(Id,"0.7.11"); var s = Snapshot(1);
                mod.AcceptSnapshot(s,Ratings(false)); mod.Trade(0,"player0",1,1000,mod.Current.TradeVersion);
                mod.AcceptSnapshot(null,null); mod.OnUpdate(); Equal(mod.Book.Balance,0L); True(!mod.Book.Find(s.Id).Abandoned);
                mod.ObserveLocation(s.Id); Equal(mod.Book.Balance,0L);
                mod.ObserveLocation(null); Equal(mod.Book.Balance,50L); True(mod.Book.Find(s.Id).Abandoned);
                Equal(mod.ReliefNotices.PendingAmount,50L); mod.ObserveLocation(null); Equal(mod.Book.Balance,50L);
                var data = new Dictionary<string,object>{{PredictionMod.SaveKey,BookCodec.Write(mod.Book)}};
                mod=host.Reload<PredictionMod>(Id,"0.7.11",data:data);
                s.Ended=true; s.Ranks=new int[]{1,2,3,4,5,6,7,8}; mod.AcceptSnapshot(s,null);
                Equal(mod.Book.Balance,50L); True(!mod.Current.Settled && mod.Current.Abandoned);
                True(mod.Trade(0,"player0",1,10,mod.Current.TradeVersion).Contains("放弃")); Equal(mod.Book.Balance,50L);
                Equal(mod.Current.Positions[0].Invested,1000L); Equal(mod.Current.TotalPayout,0L);
            }
        });
        Check("departure preserves paid results and forfeits only the unresolved remainder", delegate
        {
            var s=Snapshot(1); var b=TradeBook(s); Buy(b,s,7,8,100); Buy(b,s,0,1,900);
            s.Round=2;s.States[7]=new PlayerState(-19,0,1,8);b.Observe(s,null);
            long paid=b.Find(s.Id).TotalPayout, balance=b.Balance;True(paid>0);
            Equal(b.AbandonExcept(null),1);Equal(b.Balance,balance);True(!PredictionBook.HasPendingBets(b.Find(s.Id)));
            s.Ended=true;s.Ranks=new int[]{1,2,3,4,5,6,7,8};b.Observe(s,null);
            Equal(b.Balance,balance);Equal(b.Find(s.Id).Positions[7].FinalPayout,paid);b=Reload(b);Equal(b.Find(s.Id).TotalPayout,paid);
        });
        Check("switching to a confirmed new match clears old bets but preserves current pending wagers", delegate
        {
            var s=Snapshot(1);var b=TradeBook(s);Buy(b,s,0,1,500);
            var next=Snapshot(1);next.Id="next-game";b.Observe(next,Ratings(false));Buy(b,next,1,1,500);
            Equal(b.AbandonExcept(next.Id),1);True(!b.GrantBankruptcyRelief());True(!b.Find(next.Id).Abandoned);
            Equal(b.AbandonExcept(null),1);True(b.GrantBankruptcyRelief());Equal(b.Balance,50L);Equal(b.AbandonExcept(null),0);
        });
        Check("legacy unresolved tickets can be abandoned without fabricated final ranks or refunds", delegate
        {
            foreach(int rules in new[]{1,2})
            {
                var s=Snapshot(1);var b=FixedBook(s,Ratings(false),rules);b.Bet(s,"player0",1,1000);
                Equal(b.AbandonExcept(null),1);b=Reload(b);True(b.Find(s.Id).Abandoned&&!b.Find(s.Id).Settled);
                True(b.GrantBankruptcyRelief());Equal(b.Balance,50L);s.Ended=true;s.Ranks=new[]{1,2,3,4,5,6,7,8};b.Observe(s,null);Equal(b.Balance,50L);
            }
        });
        Check("round ten remains open until its result, then every trading action stays closed across reload and rewind", delegate
        {
            foreach(bool nextRound in new[]{false,true})
            {
                var s=Snapshot(10);var b=TradeBook(s);Equal(Buy(b,s,0,1,100),null);
                if(nextRound)s.Round=11;else s.ResultsThroughRound=10;
                b.Observe(s,null);True(b.Find(s.Id).Locked&&!b.Find(s.Id).TradingWindowOpen);
                True(Buy(b,s,0,1,10)!=null);True(Sell(b,s,0,true)!=null);True(Sell(b,s,0,false)!=null);True(Switch(b,s,0,2,10)!=null);Equal(b.Balance,900L);
                b=Reload(b);s.Round=10;s.ResultsThroughRound=0;b.Observe(s,null);True(!b.Find(s.Id).TradingWindowOpen);True(Buy(b,s,1,2,10)!=null);
                long claim=b.Find(s.Id).Positions[0].Claim;s.Round=20;s.Ended=true;s.Ranks=new[]{1,2,3,4,5,6,7,8};b.Observe(s,null);
                Equal(b.Balance,900L+claim);True(b.Find(s.Id).Settled);b.Observe(s,null);Equal(b.Balance,900L+claim);
            }
        });
        Check("late joins after ten cannot purchase but may still record results", delegate
        {
            var s=Snapshot(11);var b=TradeBook(s);True(b.Find(s.Id).Locked);True(Buy(b,s,0,1,10)!=null);Equal(b.Balance,1000L);
        });
        Check("simultaneous elimination waits for the aligned tail then pays exact adjacent and losses once by UID", delegate
        {
            var s=Snapshot(5);var b=TradeBook(s);Buy(b,s,7,8,100);Buy(b,s,6,6,100);Buy(b,s,5,1,100);
            var m=b.Find(s.Id);long expected=700L+m.Positions[7].Claim+m.Positions[6].Claim/4;
            s.Round=6;s.States[6]=new PlayerState(-1,0,1,7);b.Observe(s,null);Equal(b.Balance,700L);True(!m.Positions[6].Resolved);
            s.States[7]=new PlayerState(-99,0,1,8);s.States[5]=new PlayerState(-50,0,1,6);
            Array.Reverse(s.Players);Array.Reverse(s.States);b.Observe(s,null);Equal(b.Balance,expected);
            True(m.Positions[6].Resolved&&m.Positions[7].Resolved&&m.Positions[5].Resolved);Equal(m.Positions[5].FinalPayout,0L);
            b=Reload(b);b.Observe(s,null);Equal(b.Balance,expected);s.Round=12;s.Ended=true;s.Ranks=new[]{8,7,6,5,4,3,2,1};b.Observe(s,null);Equal(b.Balance,expected);
        });
        Check("departure queue persists operation identity and requires an explicit matching acknowledgement", delegate
        {
            var q=new RoomDepartureSync();True(q.Capture("https://example.test","token","123456","game"));
            string operation=q.At(0).Operation;True(!q.Capture("https://example.test","token","123456","game"));
            q=RoomDepartureSync.Read(Json.ParseObject(Json.Serialize(q.Write())));Equal(q.At(0).Operation,operation);
            True(!q.Confirm(q.At(0),"123456","other",true));True(!q.Confirm(q.At(0),"123456","game",false));Equal(q.Count,1);
            True(q.Confirm(q.At(0),"123456","game",true));Equal(q.Count,0);
            True(!q.Capture("https://example.test","token","123456","game",""));
        });
    }
}
