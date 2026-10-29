using System;
using System.Collections.Generic;
using Yx.ModSdk.Testing;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static MatchSnapshot CapacitySnapshot(int index)
    {
        MatchSnapshot s = Snapshot(1); s.Id = "capacity-" + index;
        return s;
    }

    static string SavedMarket(PredictionBook book, string id)
    {
        foreach (object item in Json.GetArray(BookCodec.Write(book), "markets"))
        {
            var row = (Dictionary<string, object>)item;
            if (Json.GetString(row, "id", "") == id) return Json.Serialize(row);
        }
        throw new Exception("Missing protected market");
    }

    static void MarketCapacityChecks()
    {
        Check("passive observation can open more than twelve matches without changing balance", delegate
        {
            var book = new PredictionBook(1000);
            for (int i = 0; i < 24; i++)
            {
                True(book.HasNewMarketCapacity);
                True(book.Observe(CapacitySnapshot(i), Ratings(true)) != null);
                True(book.Markets.Count <= 12); Equal(book.Balance, 1000L);
            }
            Equal(book.Markets.Count, 12); True(book.Find("capacity-23") != null);
        });
        Check("mixed full save reclaims empty markets and preserves funded accounting through reload", delegate
        {
            var book = new PredictionBook(1000);
            for (int i = 0; i < 12; i++)
            {
                MatchSnapshot s = CapacitySnapshot(i); book.Observe(s, Ratings(true));
                if (i == 4) Equal(Buy(book, s, 0, 1, 10), null);
                if (i == 5)
                {
                    Equal(Buy(book, s, 1, 1, 90), null);
                    Equal(Sell(book, s, 1, true), null);
                }
            }
            book = Reload(book);
            string first = SavedMarket(book, "capacity-4"), second = SavedMarket(book, "capacity-5");
            long balance = book.Balance;
            True(book.Observe(CapacitySnapshot(12), Ratings(true)) != null);
            Equal(book.Markets.Count, 12); Equal(book.Find("capacity-0"), null);
            book = Reload(book);
            Equal(book.Balance, balance); Equal(SavedMarket(book, "capacity-4"), first);
            Equal(SavedMarket(book, "capacity-5"), second); True(book.Find("capacity-12") != null);
        });
        Check("fully sold pending positions retain their financial history at capacity", delegate
        {
            var book = new PredictionBook(1000);
            for (int i = 0; i < 12; i++)
            {
                MatchSnapshot s = CapacitySnapshot(i); book.Observe(s, Ratings(true));
                Equal(Buy(book, s, 0, 1, 10), null); Equal(Sell(book, s, 0, false), null);
                Equal(book.Find(s.Id).Positions[0].Claim, 0L);
            }
            book = Reload(book); string before = Json.Serialize(BookCodec.Write(book));
            True(!book.HasNewMarketCapacity); Equal(book.Observe(CapacitySnapshot(12), Ratings(true)), null);
            Equal(Json.Serialize(BookCodec.Write(book)), before);
        });
        Check("partially paid pending markets survive empty market reclamation", delegate
        {
            MatchSnapshot s = CapacitySnapshot(0); var book = TradeBook(s);
            book.Observe(s, Ratings(true)); Equal(Buy(book, s, 7, 8, 10), null);
            s.Round = 2; s.States[7] = new PlayerState(0, 0, 1, 8); book.Observe(s, null);
            Market paid = book.Find(s.Id); True(paid.TotalPayout > 0); True(!paid.Settled);
            for (int i = 1; i < 12; i++) book.Observe(CapacitySnapshot(i), Ratings(true));
            string before = SavedMarket(book, s.Id); long balance = book.Balance;
            True(book.Observe(CapacitySnapshot(12), Ratings(true)) != null);
            book = Reload(book); Equal(SavedMarket(book, s.Id), before); Equal(book.Balance, balance);
            book.Observe(s, null); Equal(book.Balance, balance);
        });
        Check("settled records are reclaimed before empty pending records", delegate
        {
            var book = new PredictionBook(1000);
            for (int i = 0; i < 12; i++) book.Observe(CapacitySnapshot(i), Ratings(true));
            MatchSnapshot s = CapacitySnapshot(5); s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 };
            book.Observe(s, null); True(book.Find(s.Id).Settled);
            True(book.Observe(CapacitySnapshot(12), Ratings(true)) != null);
            Equal(book.Find(s.Id), null); True(book.Find("capacity-0") != null); Equal(book.Balance, 1000L);
        });
        Check("SDK exposes full funded capacity as a block and recovers after settlement", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.7.3");
                for (int i = 0; i < 12; i++)
                {
                    MatchSnapshot s = CapacitySnapshot(i); mod.AcceptSnapshot(s, Ratings(true));
                    Equal(mod.PlaceBet(s.Players[0].Uid, 1, 1), "下注成功，已扣除 1 马币");
                }
                string before = Json.Serialize(BookCodec.Write(mod.Book));
                mod.SetQueryStatus("Elo查询完成，命中8");
                mod.AcceptSnapshot(CapacitySnapshot(12), Ratings(true));
                Equal(mod.Current, null); True(mod.PreparationBlockedReason != null);
                True(mod.Message.Contains("已有投注记录")); Equal(mod.PreparationError, null);
                Equal(Json.Serialize(BookCodec.Write(mod.Book)), before);
                MatchSnapshot ended = CapacitySnapshot(0); ended.Ended = true; ended.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 };
                mod.AcceptSnapshot(ended, null); long balance = mod.Book.Balance;
                mod.AcceptSnapshot(CapacitySnapshot(12), Ratings(true));
                True(mod.Current != null); Equal(mod.PreparationBlockedReason, null); Equal(mod.Book.Balance, balance);
            }
        });
    }
}
