using System.Collections.Generic;
using Yx.ModSdk.Testing;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void ReliefChecks()
    {
        Check("bankruptcy relief adds fifty below ten and repeated checks do not grant twice", delegate
        {
            foreach (long balance in new long[] { 0, 1, 9, 10, 11, 1000 })
            {
                var book = new PredictionBook(balance);
                Equal(book.GrantBankruptcyRelief(), balance < 10);
                Equal(book.Balance, balance < 10 ? balance + 50 : balance);
                int revision = book.Revision;
                True(!book.GrantBankruptcyRelief()); Equal(book.Revision, revision);
                book = Reload(book); True(!book.GrantBankruptcyRelief());
            }
        });
        Check("saved bankrupt wallet receives relief on load and persists it across repeated reloads", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                var data = new Dictionary<string, object> { { PredictionMod.SaveKey, BookCodec.Write(new PredictionBook(9)) } };
                var mod = host.Load<PredictionMod>(Id, "0.7.8", data: data); Equal(mod.Book.Balance, 59L);
                Equal(mod.ReliefNotices.PendingAmount, 50L); True(!mod.Message.Contains("救济"));
                for (int i = 0; i < 3; i++)
                {
                    data[PredictionMod.SaveKey] = Json.ParseObject(Json.Serialize(BookCodec.Write(mod.Book)));
                    mod = host.Reload<PredictionMod>(Id, "0.7.8", data: data); Equal(mod.Book.Balance, 59L);
                    mod.OnUpdate(); Equal(mod.Book.Balance, 59L); Equal(mod.ReliefNotices.PendingAmount, 0L);
                }
            }
        });
        Check("all-in purchase cannot fund another wager through relief or reload", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                var mod = host.Load<PredictionMod>(Id, "0.7.8"); var s = Snapshot(1); mod.AcceptSnapshot(s, Ratings(false));
                string message = mod.Trade(0, "player0", 1, 1000, mod.Current.TradeVersion);
                Equal(mod.Book.Balance, 0L); Equal(mod.Current.Positions[0].Invested, 1000L); True(!message.Contains("救济金")); Equal(mod.ReliefNotices.PendingAmount, 0L);
                long oldClaim = mod.Current.Positions[0].Claim;
                mod.Trade(0, "player0", 1, 50, mod.Current.TradeVersion);
                Equal(mod.Book.Balance, 0L); Equal(mod.Current.Positions[0].Claim, oldClaim);
                for (int i = 0; i < 3; i++)
                {
                    mod.OnUpdate(); Equal(mod.Book.Balance, 0L); True(!mod.Book.CanGrantBankruptcyRelief);
                    var data = new Dictionary<string, object> { { PredictionMod.SaveKey, BookCodec.Write(mod.Book) } };
                    mod = host.Reload<PredictionMod>(Id, "0.7.8", data: data);
                    Equal(mod.Book.Balance, 0L); Equal(mod.Book.Find(s.Id).Positions[0].Claim, oldClaim);
                }
            }
        });
        Check("ten is not bankrupt and spending to nine with a pending wager grants nothing", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                var data = new Dictionary<string, object> { { PredictionMod.SaveKey, BookCodec.Write(new PredictionBook(10)) } };
                var mod = host.Load<PredictionMod>(Id, "0.7.8", data: data); Equal(mod.Book.Balance, 10L);
                var s = Snapshot(1); mod.AcceptSnapshot(s, Ratings(false));
                mod.Trade(0, "player0", 1, 11, mod.Current.TradeVersion); Equal(mod.Book.Balance, 10L);
                mod.Trade(0, "player0", 1, 1, mod.Current.TradeVersion); Equal(mod.Book.Balance, 9L);
                long claim = mod.Current.Positions[0].Claim;
                mod.Trade(0, "player0", 1, 1000, mod.Current.TradeVersion); Equal(mod.Book.Balance, 9L); Equal(mod.Current.Positions[0].Claim, claim);
                mod.OnUpdate(); Equal(mod.Book.Balance, 9L);
            }
        });
        Check("pending wagers in another game block relief even when the current game has none", delegate
        {
            var first = Snapshot(1); var book = TradeBook(first); Equal(Buy(book, first, 0, 1, 1000), null);
            var other = Snapshot(1); other.Id = "another-game"; book.Observe(other, Ratings(false));
            book = Reload(book); int revision = book.Revision;
            True(!book.GrantBankruptcyRelief()); Equal(book.Balance, 0L); Equal(book.Revision, revision);
            first.Ended = true; book.Observe(first, null);
            True(book.Find(first.Id).Locked && !book.Find(first.Id).Settled);
            True(!book.GrantBankruptcyRelief()); Equal(book.Balance, 0L);
        });
        Check("partial settlement blocks relief until the last owned wager resolves", delegate
        {
            var s = Snapshot(1); var book = TradeBook(s);
            Equal(Buy(book, s, 0, 1, 500), null); Equal(Buy(book, s, 1, 1, 500), null);
            s.Round = 2; s.States[0] = new PlayerState(0, 0, 1, 8); book.Observe(s, null);
            True(book.Find(s.Id).Positions[0].Resolved); True(!book.GrantBankruptcyRelief()); Equal(book.Balance, 0L);
            book = Reload(book); True(!book.GrantBankruptcyRelief());
            s.Round = 3; s.States[1] = new PlayerState(0, 0, 2, 7); book.Observe(s, null);
            True(!book.Find(s.Id).Settled); True(book.Find(s.Id).Positions[1].Resolved);
            True(book.GrantBankruptcyRelief()); Equal(book.Balance, 50L); Equal(book.Find(s.Id).TotalPayout, 0L);
            book = Reload(book); True(!book.GrantBankruptcyRelief()); Equal(book.Balance, 50L);
        });
        Check("clearing the final zero-value position unlocks relief without erasing history", delegate
        {
            var s = Snapshot(5); var book = TradeBook(s); Equal(Buy(book, s, 0, 8, 1000), null);
            s.Round = 8; s.States[7] = new PlayerState(0, 0, 9, 8); book.Observe(s, null);
            s.Round = 9; s.States[6] = new PlayerState(0, 0, 10, 7); book.Observe(s, null);
            Equal(TradingOdds.Sale(book.Find(s.Id), 0, false), 0L); True(!book.GrantBankruptcyRelief());
            Equal(Sell(book, s, 0, false), null); True(book.GrantBankruptcyRelief()); Equal(book.Balance, 50L);
            Equal(book.Find(s.Id).Positions[0].Invested, 1000L); Equal(book.Find(s.Id).Positions[0].NetResult, -1000L);
            True(!book.GrantBankruptcyRelief()); book = Reload(book); True(!book.GrantBankruptcyRelief());
        });
        Check("legacy fixed tickets block relief until final settlement", delegate
        {
            foreach (int rules in new int[] { 1, 2 })
            {
                var s = Snapshot(1); var book = FixedBook(s, Ratings(false), rules);
                Equal(book.Bet(s, "player0", 1, 1000), null); True(!book.GrantBankruptcyRelief());
                book = Reload(book); s.Round = 6; s.Ended = true; book.Observe(s, null);
                True(!book.GrantBankruptcyRelief()); Equal(book.Balance, 0L);
                s.Ranks = new int[] { 8, 2, 3, 4, 5, 6, 7, 1 }; book.Observe(s, null);
                True(book.Find(s.Id).Settled); True(book.GrantBankruptcyRelief()); Equal(book.Balance, 50L);
                book = Reload(book); True(!book.GrantBankruptcyRelief());
            }
        });
        Check("a settled losing wager grants relief once and a new all-in wager blocks it again", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                var mod = host.Load<PredictionMod>(Id, "0.7.8"); var s = Snapshot(1); mod.AcceptSnapshot(s, Ratings(false));
                mod.Trade(0, "player0", 1, 1000, mod.Current.TradeVersion); Equal(mod.Book.Balance, 0L);
                s.Ended = true; s.Ranks = new int[] { 8, 2, 3, 4, 5, 6, 7, 1 }; mod.AcceptSnapshot(s, null);
                Equal(mod.Book.Balance, 50L); Equal(mod.Current.TotalPayout, 0L);
                mod.AcceptSnapshot(s, null); mod.OnUpdate(); Equal(mod.Book.Balance, 50L);
                s = Snapshot(1); s.Id = "next-losing-game"; mod.AcceptSnapshot(s, Ratings(false));
                mod.Trade(0, "player0", 1, 50, mod.Current.TradeVersion); Equal(mod.Book.Balance, 0L);
                s.Ended = true; s.Ranks = new int[] { 8, 2, 3, 4, 5, 6, 7, 1 }; mod.AcceptSnapshot(s, null);
                Equal(mod.Book.Balance, 50L); mod.OnUpdate(); Equal(mod.Book.Balance, 50L);
            }
        });
    }
}
