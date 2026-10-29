using System;
using System.Collections.Generic;
using Yx.Shared;
using Yx.ModSdk.Testing;
using YxPrediction;

internal static partial class Program
{
    static PredictionBook TradeBook(MatchSnapshot s, long balance = 1000)
    { return FixedBook(s, Ratings(false), Odds.TradingRuleVersion, balance); }
    static string Buy(PredictionBook b, MatchSnapshot s, int player, int rank, long stake)
    { return b.Buy(s, "player" + player, rank, stake, b.Find(s.Id).TradeVersion); }
    static string Sell(PredictionBook b, MatchSnapshot s, int player, bool half)
    { return b.Sell(s, "player" + player, half, b.Find(s.Id).TradeVersion); }
    static string Switch(PredictionBook b, MatchSnapshot s, int player, int rank, long stake)
    { return b.Switch(s, "player" + player, rank, stake, b.Find(s.Id).TradeVersion); }
    static Dictionary<string, object> TradingRow(Dictionary<string, object> data)
    { return Json.GetObject((Dictionary<string, object>)Json.GetArray(data, "markets")[0], "trading"); }

    static void TradingChecks()
    {
        Check("new markets trade in round six and late joins can open", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Market m = b.Find(s.Id);
            Equal(m.RuleVersion, 3); True(!m.Locked && m.TradingWindowOpen); Equal(Buy(b, s, 0, 1, 10), null);
            Equal(m.Positions[0].Claim, 57L); Equal(b.Balance, 990L);
        });
        Check("live probabilities normalize and fix eliminated ranks", delegate
        {
            MatchSnapshot s = Snapshot(8); s.States[6] = new PlayerState(0, 0, 7, 7); s.States[7] = new PlayerState(-10, 0, 7, 8);
            double[] p = TradingOdds.Probabilities(Ratings(true), s.States);
            for (int i = 0; i < 8; i++)
            {
                double row = 0, column = 0;
                for (int r = 0; r < 8; r++) { row += p[i * 8 + r]; column += p[r * 8 + i]; }
                Near(row, 1); Near(column, 1);
            }
            Near(p[6 * 8 + 6], 1); Near(p[7 * 8 + 7], 1); Near(p[6], 0); Near(p[7], 0);
        });
        Check("life and recent wins move quotes without rewriting existing rights", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Market m = b.Find(s.Id);
            Equal(Buy(b, s, 0, 1, 100), null); Equal(m.Positions[0].Claim, 614L);
            int before = m.QuoteRates[0]; s.Round = 6;
            s.States[0] = new PlayerState(180, 5, 0, 0);
            for (int i = 1; i < 8; i++) s.States[i] = new PlayerState(30, 0, 5, 0);
            b.Observe(s, null); True(m.QuoteRates[0] < before); Equal(m.Positions[0].Claim, 614L);
            long added = 50L * m.QuoteRates[0] / 10000;
            Equal(Buy(b, s, 0, 1, 50), null); Equal(m.Positions[0].Claim, 614L + added);
            Equal(m.Positions[0].Invested, 150L); Equal(b.Balance, 850L); True(TradingOdds.Sale(m, 0, false) > 150);
        });
        Check("half and full sales release proportional rights and cost", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Market m = b.Find(s.Id);
            Buy(b, s, 0, 1, 100); Equal(TradingOdds.Sale(m, 0, false), 96L); Equal(TradingOdds.Sale(m, 0, true), 48L);
            Equal(Sell(b, s, 0, true), null); Equal(b.Balance, 948L); Equal(m.Positions[0].Claim, 307L); Equal(m.Positions[0].Cost, 50L);
            Equal(Sell(b, s, 0, false), null); Equal(b.Balance, 996L); Equal(m.Positions[0].Claim, 0L); Equal(m.Positions[0].Rank, 0);
            Equal(m.Positions[0].NetResult, -4L); b = Reload(b); Equal(b.Balance, 996L);
            True(Sell(b, s, 0, false) != null); Equal(Buy(b, s, 0, 2, 10), null);
        });
        Check("same quote buy and sell cannot manufacture points", delegate
        {
            MatchSnapshot s = Snapshot(5); PredictionBook b = TradeBook(s);
            for (int i = 0; i < 20; i++) { Equal(Buy(b, s, 0, 1, 10), null); Equal(Sell(b, s, 0, false), null); }
            True(b.Balance < 1000); Equal(b.Balance, 980L);
        });
        Check("stale quotes and repeated action versions never debit or sell", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Market m = b.Find(s.Id); int old = m.TradeVersion;
            Equal(b.Buy(s, "player0", 1, 100, old), null);
            True(b.Sell(s, "player0", false, old) != null); Equal(b.Balance, 900L); Equal(m.Positions[0].Claim, 614L);
            old = m.TradeVersion; s.States[0] = new PlayerState(150, 0, 0, 0);
            True(b.Buy(s, "player0", 1, 100, old) != null); True(m.TradeVersion != old); Equal(b.Balance, 900L);
            True(b.Switch(s, "player0", 2, 10, old) != null); Equal(m.Positions[0].Rank, 1);
        });
        Check("animation and placement gates stop all trading actions", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            s.TradingOpen = false; b.Observe(s, null);
            True(Buy(b, s, 0, 1, 10) != null); True(Sell(b, s, 0, false) != null); True(Switch(b, s, 0, 2, 10) != null);
            Equal(b.Balance, 900L); s.TradingOpen = true; b.Observe(s, null); Equal(Sell(b, s, 0, true), null);
        });
        Check("result arrival latches a round closed through reload and rewind", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            s.ResultsThroughRound = 6; b.Observe(s, null); True(!b.Find(s.Id).TradingWindowOpen);
            s.ResultsThroughRound = 0; True(Sell(b, s, 0, false) != null);
            b = Reload(b); True(!b.Find(s.Id).TradingWindowOpen); True(Buy(b, s, 0, 1, 10) != null);
            s.Round = 7; b.Observe(s, null); True(b.Find(s.Id).TradingWindowOpen);
            s.Round = 6; True(Buy(b, s, 0, 1, 10) != null); Equal(b.Find(s.Id).HighestRound, 7);
            s.Round = 7; b.Observe(s, null); Equal(Buy(b, s, 0, 1, 10), null);
        });
        Check("missing public states and incomplete elimination ranks pause safely", delegate
        {
            MatchSnapshot s = Snapshot(6); s.States = null; PredictionBook b = TradeBook(s);
            True(!b.Find(s.Id).TradingWindowOpen); True(Buy(b, s, 0, 1, 10) != null); b = Reload(b);
            s = Snapshot(6); b.Observe(s, null); Buy(b, s, 0, 1, 10);
            s.States[7] = new PlayerState(0, 0, 0, 0); b.Observe(s, null);
            True(!b.Find(s.Id).TradingWindowOpen); True(Sell(b, s, 0, false) != null); Equal(b.Balance, 990L);
        });
        Check("eliminated player settles a quarter once before the match ends", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Buy(b, s, 7, 7, 100);
            Market m = b.Find(s.Id); long expected = m.Positions[7].Claim / 4;
            s.Round = 9; s.States[7] = new PlayerState(0, 0, 8, 8); b.Observe(s, null);
            True(m.Positions[7].Resolved && !m.Settled); Equal(m.TotalPayout, expected); Equal(b.Balance, 900L + expected);
            True(Buy(b, s, 7, 7, 10) != null); True(Sell(b, s, 7, false) != null); True(!TradingOdds.CanBuy(m, 0, 8));
            b = Reload(b); b.Observe(s, null); Equal(b.Balance, 900L + expected);
            s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null); b.Observe(s, null);
            True(b.Find(s.Id).Settled); Equal(b.Balance, 900L + expected); b = Reload(b); Equal(b.Balance, 900L + expected);
        });
        Check("unreachable prediction retains adjacent value then can expire to zero", delegate
        {
            MatchSnapshot s = Snapshot(5); PredictionBook b = TradeBook(s); Buy(b, s, 0, 8, 100);
            s.Round = 8; s.States[7] = new PlayerState(0, 0, 9, 8); b.Observe(s, null);
            True(!TradingOdds.CanBuy(b.Find(s.Id), 0, 8)); True(TradingOdds.Sale(b.Find(s.Id), 0, false) > 0);
            s.Round = 9; s.States[6] = new PlayerState(0, 0, 10, 7); b.Observe(s, null);
            Equal(TradingOdds.Sale(b.Find(s.Id), 0, false), 0L); Equal(Sell(b, s, 0, false), null); Equal(b.Balance, 900L);
        });
        Check("contradictory eliminated ranks cannot credit or reopen trading", delegate
        {
            MatchSnapshot s = Snapshot(5); PredictionBook b = TradeBook(s); Buy(b, s, 7, 8, 100);
            s.Round = 8; s.States[7] = new PlayerState(0, 0, 7, 8); b.Observe(s, null); long balance = b.Balance;
            s.States[7] = new PlayerState(0, 0, 7, 7); b.Observe(s, null);
            True(!b.Find(s.Id).TradingWindowOpen); Equal(b.Balance, balance); Equal(b.Find(s.Id).KnownRanks[7], 8);
            s.States[7] = new PlayerState(100, 0, 0, 0); b.Observe(s, null); True(!b.Find(s.Id).TradingWindowOpen);
        });
        Check("switch is atomic and can use sale proceeds as its budget", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 1000);
            Market m = b.Find(s.Id); long sale = TradingOdds.Sale(m, 0, false); long claim = m.Positions[0].Claim;
            True(Switch(b, s, 0, 2, 1000) != null); Equal(m.Positions[0].Claim, claim); Equal(m.Positions[0].CashReturned, 0L); Equal(b.Balance, 0L);
            Equal(Switch(b, s, 0, 2, 500), null); Equal(b.Balance, sale - 500); Equal(m.Positions[0].Rank, 2);
            Equal(m.Positions[0].Claim, 500L * m.QuoteRates[1] / 10000); Equal(m.Positions[0].Invested, 1500L);
            Equal(m.Positions[0].CashReturned, sale); b = Reload(b); Equal(b.Balance, sale - 500);
        });
        Check("impossible partial rank information cannot pay or poison a saved quote", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            s.States[0] = new PlayerState(0, 0, 0, 1); b.Observe(s, null);
            Equal(b.Balance, 900L); True(!b.Find(s.Id).Positions[0].Resolved && !b.Find(s.Id).TradingWindowOpen);
            b = Reload(b); s.States[0] = new PlayerState(100, 0, 0, 1); b.Observe(s, null);
            True(!b.Find(s.Id).TradingWindowOpen); b = Reload(b); Equal(b.Balance, 900L);
        });
        Check("invalid amounts ranks foreign users and non observers never trade", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s);
            foreach (long stake in new long[] { -1, 0, 1001, 10001, long.MaxValue }) True(Buy(b, s, 0, 1, stake) != null);
            True(Buy(b, s, 0, 0, 10) != null); True(Buy(b, s, 0, 9, 10) != null); True(Buy(b, s, 99, 1, 10) != null);
            Buy(b, s, 0, 1, 100); True(Buy(b, s, 0, 2, 100) != null); Equal(b.Balance, 900L);
            s.LiveObserver = false; True(Sell(b, s, 0, false) != null); s.LiveObserver = true;
            s.Players[7] = new Player("outsider", "x", false); True(Buy(b, s, 0, 1, 10) != null); Equal(b.Balance, 900L);
        });
        Check("UID reordering preserves live quotes positions and settlement", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            Array.Reverse(s.Players); Array.Reverse(s.States); s.States[7] = new PlayerState(150, 1, 0, 0);
            b.Observe(s, null); Equal(Buy(b, s, 0, 1, 10), null); Equal(b.Find(s.Id).QuoteStates[0].Life, 150);
            long claim = b.Find(s.Id).Positions[0].Claim; s.Ended = true; s.Ranks = new int[] { 8, 7, 6, 5, 4, 3, 2, 1 };
            b.Observe(s, null); Equal(b.Balance, 890L + claim); Equal(b.Find(s.Id).KnownRanks[0], 1); b = Reload(b);
        });
        Check("partial invalid final results lock until complete and settle once", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 10); long claim = b.Find(s.Id).Positions[0].Claim;
            s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 7 }; b.Observe(s, null);
            True(b.Find(s.Id).Locked && !b.Find(s.Id).Settled); Equal(b.Balance, 990L);
            s.Ended = false; b.Observe(s, null); True(!b.Find(s.Id).TradingWindowOpen);
            s.Ended = true; s.Ranks[7] = 8; b.Observe(s, null); Equal(b.Balance, 990L + claim);
            b = Reload(b); b.Observe(s, null); Equal(b.Balance, 990L + claim);
        });
        Check("reload requires fresh state and preserves changed quotes and partial sales", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            s.Round = 7; s.States[0] = new PlayerState(160, 5, 1, 0); b.Observe(s, null); Sell(b, s, 0, true);
            long balance = b.Balance, rights = b.Find(s.Id).Positions[0].Claim; int quote = b.Find(s.Id).QuoteRates[0];
            b = Reload(b); Market m = b.Find(s.Id); True(!m.TradingWindowOpen); Equal(m.QuoteRates[0], quote); Equal(m.Positions[0].Claim, rights);
            b.Observe(s, null); True(m.TradingWindowOpen); Equal(b.Balance, balance); Equal(Sell(b, s, 0, false), null);
        });
        Check("v2 pending markets retain their original cutoff and quarter reward", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = FixedBook(s, Ratings(false), 2); b.Bet(s, "player0", 1, 10);
            var data = BookCodec.Write(b); data["version"] = 2; b = BookCodec.Read(Json.ParseObject(Json.Serialize(data)));
            s.Round = 6; b.Observe(s, null); True(b.Find(s.Id).Locked); True(Buy(b, s, 0, 1, 10) != null);
            s.Ended = true; s.Ranks = new int[] { 2, 1, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null); Equal(b.Balance, 1005L);
        });
        Check("corrupted trading rights quotes ranks and credited totals are rejected", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 100);
            var data = BookCodec.Write(b); var row = (Dictionary<string, object>)Json.GetArray(TradingRow(data), "positions")[0]; row["claim"] = long.MaxValue;
            Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(b); Json.GetArray(TradingRow(data), "rates")[0] = 99999; Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(b); Json.GetArray(TradingRow(data), "known")[0] = 8; Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(b); ((Dictionary<string, object>)Json.GetArray(data, "markets")[0])["payout"] = 10; Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(b); data["version"] = 2; Throws(delegate { BookCodec.Read(data); });
        });
        Check("tiny positions floor sales and adjacent returns without negatives", delegate
        {
            MatchSnapshot s = Snapshot(5); PredictionBook b = TradeBook(s); Buy(b, s, 0, 1, 1);
            Equal(b.Find(s.Id).Positions[0].Claim, 5L); Equal(Sell(b, s, 0, true), null); Equal(b.Find(s.Id).Positions[0].Claim, 3L);
            s.Ended = true; s.Ranks = new int[] { 2, 1, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null); Equal(b.Find(s.Id).Positions[0].FinalPayout, 0L); b = Reload(b);
        });
        Check("position limits bound arithmetic and allow final settlement", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s, 1000000000);
            for (int i = 0; i < Position.MaximumActions; i++) Equal(Buy(b, s, 0, 8, 10000), null);
            True(Buy(b, s, 0, 8, 1) != null); True(Sell(b, s, 0, false) != null); b = Reload(b);
            long claim = b.Find(s.Id).Positions[0].Claim; True(claim <= Position.MaximumClaim);
            s.Ended = true; s.Ranks = new int[] { 8, 1, 2, 3, 4, 5, 6, 7 }; long before = b.Balance;
            b.Observe(s, null); Equal(b.Balance, before + claim); b = Reload(b);
        });
        Check("disabled new predictions still permit exits and automatic settlement", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.2.0"); MatchSnapshot s = Snapshot(6); mod.AcceptSnapshot(s, Ratings(false));
                mod.Trade(0, "player0", 1, 100, mod.Current.TradeVersion);
                host.SetConfig(Id, new Dictionary<string, object> { ["prediction"] = new Dictionary<string, object> { ["enabled"] = false } });
                mod.Trade(0, "player1", 1, 100, mod.Current.TradeVersion); Equal(mod.Book.Balance, 900L);
                mod.Trade(1, "player0", 1, 0, mod.Current.TradeVersion); True(mod.Book.Balance > 900);
                long before = mod.Book.Balance, claim = mod.Current.Positions[0].Claim;
                s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; mod.AcceptSnapshot(s, null); Equal(mod.Book.Balance, before + claim);
                foreach (var log in host.Logs()) True(log.Lvl != "error");
            }
        });
        Check("SDK trading reload preserves state and recovers over limit settlement", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.2.0"); MatchSnapshot s = Snapshot(6); mod.AcceptSnapshot(s, Ratings(false));
                mod.Trade(0, "player0", 1, 100, mod.Current.TradeVersion);
                var saved = new Dictionary<string, object>(); saved[PredictionMod.SaveKey] = BookCodec.Write(mod.Book);
                mod = host.Reload<PredictionMod>(Id, "0.2.0", data: saved); True(mod != null); mod.AcceptSnapshot(s, null);
                long claim = mod.Current.Positions[0].Claim; mod.Book.Balance = Odds.MaximumBalance;
                s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; mod.AcceptSnapshot(s, null);
                True(mod.PreparationError != null); True(!mod.Current.Positions[0].Resolved); Equal(mod.Book.Balance, Odds.MaximumBalance);
                mod.Book.Balance -= claim; mod.AcceptSnapshot(s, null); Equal(mod.Book.Balance, Odds.MaximumBalance); True(mod.Current.Settled);
            }
        });
        Check("random trading lifecycles conserve points across sales switches reloads and payouts", delegate
        {
            for (int seed = 0; seed < 20; seed++)
            {
                var random = new Random(seed); MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s, 100000);
                for (int round = 1; round <= 12; round++)
                {
                    s.Round = round; s.ResultsThroughRound = round - 1;
                    for (int i = 0; i < 8; i++) s.States[i] = new PlayerState(random.Next(1, 160), random.Next(0, round), random.Next(0, round), 0);
                    b.Observe(s, null);
                    for (int action = 0; action < 15; action++)
                    {
                        int player = random.Next(8), kind = random.Next(4);
                        if (kind == 0) Buy(b, s, player, random.Next(1, 9), random.Next(1, 101));
                        else if (kind == 1) Sell(b, s, player, true);
                        else if (kind == 2) Sell(b, s, player, false);
                        else Switch(b, s, player, random.Next(1, 9), random.Next(1, 101));
                        if (action % 5 == 0) { b = Reload(b); b.Observe(s, null); }
                        AssertTradingBalance(b, s, 100000);
                    }
                    s.ResultsThroughRound = round; b.Observe(s, null); True(!b.Find(s.Id).TradingWindowOpen);
                }
                s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null); AssertTradingBalance(b, s, 100000);
                long balance = b.Balance; b = Reload(b); b.Observe(s, null); Equal(b.Balance, balance);
            }
        });
    }
    static void AssertTradingBalance(PredictionBook b, MatchSnapshot s, long initial)
    {
        long expected = initial;
        foreach (Position p in b.Find(s.Id).Positions) expected += p.CashReturned + p.FinalPayout - p.Invested;
        Equal(b.Balance, expected);
    }
}
