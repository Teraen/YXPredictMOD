using System;
using System.Collections.Generic;
using System.Globalization;
using Yx.ModSdk.Hosting;
using Yx.ModSdk.Testing;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static int _passed;
    static int _failed;
    const string Id = "local.yxp.predictionpoints";

    static int Main(string[] args)
    {
        if (args.Length > 1 && args[0] == "--rule-parity") { ExportRuleParity(args[1]); return 0; }
        if (args.Length > 0 && args[0] == "--demo") { Demo(); return 0; }
        Check("equal Elo gives uniform rank probabilities", delegate
        {
            double[] p = Odds.Probabilities(Ratings(false));
            int[] odds = Odds.Rates(Ratings(false));
            int[] legacy = Odds.Rates(Ratings(false), Odds.ExactOnlyRuleVersion);
            for (int i = 0; i < 8; i++) for (int r = 0; r < 8; r++)
            {
                Near(p[i * 8 + r], 0.125);
                Equal(odds[i * 8 + r], r == 0 || r == 7 ? 57600 : 48000);
                Equal(legacy[i * 8 + r], 72000);
                double weighted = 0.125 + (r == 0 || r == 7 ? 0.03125 : 0.0625);
                Near(weighted * odds[i * 8 + r] / 10000.0, 0.90);
            }
        });
        Check("each player and each rank has total probability one", delegate
        {
            double[] p = Odds.Probabilities(Ratings(true));
            for (int i = 0; i < 8; i++)
            {
                double row = 0, col = 0;
                for (int r = 0; r < 8; r++) { row += p[i * 8 + r]; col += p[r * 8 + i]; True(p[i * 8 + r] > 0); }
                Near(row, 1.0); Near(col, 1.0);
            }
            True(p[0] > p[56]); True(p[7] < p[63]);
        });
        Check("extreme Elo remains finite and odds are capped", delegate
        {
            Rating[] ratings = Ratings(false); ratings[0] = new Rating(10000, 400, true); ratings[7] = new Rating(0, 400, true);
            int[] rates = Odds.Rates(ratings);
            for (int i = 0; i < 8; i++) for (int r = 0; r < 8; r++) True(rates[i * 8 + r] >= 10100 && rates[i * 8 + r] <= 500000);
        });
        Check("first five rounds give 8/6/4/2/0 percent profit bonus", delegate
        {
            Equal(Odds.EffectiveRate(20000, 1), 20800); Equal(Odds.EffectiveRate(20000, 2), 20600);
            Equal(Odds.EffectiveRate(20000, 3), 20400); Equal(Odds.EffectiveRate(20000, 4), 20200);
            Equal(Odds.EffectiveRate(20000, 5), 20000); Equal(Odds.EffectiveRate(500000, 1), 500000);
        });
        Check("eight independent tickets can choose the same rank", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s);
            for (int i = 0; i < 8; i++) Equal(b.Bet(s, s.Players[i].Uid, 1, 10), null);
            Equal(b.Balance, 920L);
            True(b.Bet(s, s.Players[0].Uid, 2, 10) != null); Equal(b.Balance, 920L);
        });
        Check("invalid stake, rank, player and insufficient balance do not debit", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s);
            foreach (long stake in new long[] { 0, -1, 10001, long.MaxValue, 1001 }) True(b.Bet(s, s.Players[0].Uid, 1, stake) != null);
            True(b.Bet(s, s.Players[0].Uid, 0, 10) != null); True(b.Bet(s, s.Players[0].Uid, 9, 10) != null);
            True(b.Bet(s, "foreign", 1, 10) != null); Equal(b.Balance, 1000L);
        });
        Check("round five accepts bets until ended; cutoff survives rewind", delegate
        {
            MatchSnapshot s = Snapshot(5); PredictionBook b = Open(s);
            Equal(b.Bet(s, s.Players[0].Uid, 1, 10), null);
            s.FifthRoundEnded = true; b.Observe(s, null);
            True(b.Bet(s, s.Players[1].Uid, 2, 10) != null);
            s.FifthRoundEnded = false; s.Round = 1; b.Observe(s, null);
            True(b.Bet(s, s.Players[1].Uid, 2, 10) != null); Equal(b.Balance, 990L);
        });
        Check("round six and late join are locked immediately", delegate
        {
            MatchSnapshot s = Snapshot(6); PredictionBook b = Open(s);
            True(b.Find(s.Id).Locked); True(b.Bet(s, s.Players[0].Uid, 1, 1) != null);
            s.Round = 2; True(b.Bet(s, s.Players[0].Uid, 1, 1) != null);
        });
        Check("out of order status cannot restore a larger early bonus", delegate
        {
            MatchSnapshot s = Snapshot(4); PredictionBook b = Open(s);
            s.Round = 2; True(b.Bet(s, s.Players[0].Uid, 1, 10) != null); Equal(b.Balance, 1000L);
        });
        Check("non-observers never open or bet on a market", delegate
        {
            MatchSnapshot s = Snapshot(1); s.LiveObserver = false;
            var b = new PredictionBook(1000); Equal(b.Observe(s, Ratings(true)), null);
            True(b.Bet(s, s.Players[0].Uid, 1, 10) != null);
        });
        Check("only eight distinct players can open; roster cannot be replaced", delegate
        {
            MatchSnapshot s = Snapshot(1); s.Players[1] = s.Players[0];
            var b = new PredictionBook(1000); Equal(b.Observe(s, Ratings(true)), null);
            s = Snapshot(1); b.Observe(s, Ratings(true)); s.Players[1] = new Player("foreign", "Foreign", false);
            Equal(b.Observe(s, null), null); True(b.Bet(s, s.Players[0].Uid, 1, 10) != null);
        });
        Check("ticket odds and stake are frozen after later Elo changes", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s);
            b.Bet(s, s.Players[0].Uid, 1, 10); Ticket t = b.Find(s.Id).Tickets[0];
            int rate = t.RateBps; s.Round = 4; b.Observe(s, Ratings(false)); Equal(t.RateBps, rate); Equal(t.Round, 1);
            Equal(b.Balance, 990L);
        });
        Check("partial or duplicate ranks cannot settle; final payout is idempotent", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s);
            b.Bet(s, s.Players[0].Uid, 1, 10); b.Bet(s, s.Players[1].Uid, 8, 10);
            long expected = b.Find(s.Id).Tickets[0].Payout;
            s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null);
            True(!b.Find(s.Id).Settled); s.Ended = true; s.Ranks[7] = 7; b.Observe(s, null);
            True(!b.Find(s.Id).Settled); Equal(b.Balance, 980L);
            s.Ranks[7] = 8; b.Observe(s, null); True(b.Find(s.Id).Settled); Equal(b.Balance, 980L + expected);
            b.Observe(s, null); Equal(b.Balance, 980L + expected);
        });
        Check("final ranks follow UID when the server reorders players", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s); b.Bet(s, s.Players[0].Uid, 1, 10);
            long expected = b.Find(s.Id).Tickets[0].Payout;
            Array.Reverse(s.Players); s.Ranks = new int[] { 8, 7, 6, 5, 4, 3, 2, 1 }; s.Ended = true;
            b.Observe(s, null); Equal(b.Balance, 990L + expected); Equal(b.Find(s.Id).FinalRanks[0], 1);
        });
        Check("integer payouts round down", delegate { var t = new Ticket(0, 1, 1, 3, 12345); Equal(t.Payout, 3L); });
        Check("adjacent ranks pay a quarter without wrapping first and eighth", delegate
        {
            var first = new Ticket(0, 1, 5, 10, 50000);
            Equal(first.ReturnFor(1, 2), 50L); Equal(first.ReturnFor(2, 2), 12L); Equal(first.ReturnFor(8, 2), 0L);
            Equal(first.ReturnFor(2, 1), 0L);
            var last = new Ticket(0, 8, 5, 10, 50000);
            Equal(last.ReturnFor(7, 2), 12L); Equal(last.ReturnFor(1, 2), 0L);
            var middle = new Ticket(0, 4, 5, 10, 50000);
            Equal(middle.ReturnFor(3, 2), 12L); Equal(middle.ReturnFor(5, 2), 12L); Equal(middle.ReturnFor(2, 2), 0L); Equal(middle.ReturnFor(6, 2), 0L);
            Equal(new Ticket(0, 1, 5, 1, 10100).ReturnFor(2, 2), 0L);
            Throws(delegate { first.ReturnFor(0, 2); }); Throws(delegate { first.ReturnFor(1, 99); });
        });
        Check("exact adjacent and missed tickets settle once and survive reload", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = FixedBook(s, Ratings(false), 2);
            b.Bet(s, s.Players[0].Uid, 1, 10); b.Bet(s, s.Players[1].Uid, 3, 10); b.Bet(s, s.Players[2].Uid, 8, 10);
            b = Reload(b); Equal(b.Find(s.Id).RuleVersion, 2); Equal(b.Balance, 970L);
            s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null);
            Equal(b.Find(s.Id).TotalPayout, 73L); Equal(b.Balance, 1043L);
            b = Reload(b); b.Observe(s, null); Equal(b.Balance, 1043L);
        });
        Check("v1 pending markets retain exact-only rules and new markets use tolerance", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook old = LegacyBook(s); old.Bet(s, s.Players[0].Uid, 1, 10);
            PredictionBook b = BookCodec.Read(LegacyData(old)); Equal(b.Find(s.Id).RuleVersion, 1); Equal(b.Find(s.Id).Tickets[0].Payout, 76L);
            s.Ended = true; s.Ranks = new int[] { 2, 1, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null); Equal(b.Balance, 990L);
            MatchSnapshot fresh = Snapshot(1); fresh.Id = "new-rules"; b.Observe(fresh, Ratings(false)); Equal(b.Find(fresh.Id).RuleVersion, 3);
            b.Bet(fresh, fresh.Players[0].Uid, 1, 10); fresh.Ended = true; fresh.Ranks = s.Ranks; b.Observe(fresh, null);
            Equal(b.Balance, 995L); b = Reload(b); Equal(b.Find(s.Id).RuleVersion, 1); Equal(b.Find(fresh.Id).RuleVersion, 3);
        });
        Check("v1 settled records preserve credited amounts without retroactive awards", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook old = LegacyBook(s);
            old.Bet(s, s.Players[0].Uid, 1, 10); old.Bet(s, s.Players[1].Uid, 3, 10);
            s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; old.Observe(s, null); Equal(old.Balance, 1056L);
            PredictionBook b = BookCodec.Read(LegacyData(old)); Equal(b.Find(s.Id).TotalPayout, 76L);
            b.Observe(s, null); Equal(b.Balance, 1056L); b = Reload(b); Equal(b.Balance, 1056L);
        });
        Check("JSON round-trip preserves balance, cutoff and duplicate settlement guard", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s); b.Bet(s, s.Players[0].Uid, 1, 10);
            s.Round = 6; b.Observe(s, null); b = Reload(b); True(b.Find(s.Id).Locked);
            True(b.Bet(Snapshot(1), s.Players[1].Uid, 2, 10) != null); Equal(b.Balance, 990L);
            s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; b.Observe(s, null);
            long paid = b.Balance; b = Reload(b); b.Observe(s, null); Equal(b.Balance, paid);
        });
        Check("switching matches retains unresolved tickets without refund", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s); b.Bet(s, s.Players[0].Uid, 1, 20);
            var second = Snapshot(3); second.Id = "second"; b.Observe(second, Ratings(true));
            Equal(b.Balance, 980L); b.Observe(s, null); True(b.Find(s.Id).Tickets[0] != null);
        });
        Check("unfinished market limit does not discard debited bets", delegate
        {
            var b = new PredictionBook(1000);
            for (int i = 0; i < 12; i++) { MatchSnapshot s = Snapshot(1); s.Id = "match" + i; b.Observe(s, Ratings(true)); b.Bet(s, s.Players[0].Uid, 1, 1); }
            MatchSnapshot extra = Snapshot(1); extra.Id = "extra"; Equal(b.Observe(extra, Ratings(true)), null); Equal(b.Markets.Count, 12); Equal(b.Balance, 988L);
            True(Json.Serialize(BookCodec.Write(b)).Length < 200000);
        });
        Check("corrupted saves fail instead of granting a new balance", delegate
        {
            var data = BookCodec.Write(Open(Snapshot(1))); data["balance"] = -10.0;
            Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(Open(Snapshot(1))); data["version"] = 99;
            Throws(delegate { BookCodec.Read(data); });
            data = BookCodec.Write(Open(Snapshot(1)));
            var row = (Dictionary<string, object>)((List<object>)data["markets"])[0]; row["rules"] = 99;
            Throws(delegate { BookCodec.Read(data); }); row.Remove("rules"); Throws(delegate { BookCodec.Read(data); });
        });
        Check("Elo lookup uses UID and rating rather than conservative rank score", delegate
        {
            const string uid = "6418551449ce7dd2bc252b7b";
            var shard = Json.ParseObject("{\"6418551449ce7dd2bc252b7b\":{\"rating\":4733,\"sigma\":159,\"cons\":4416}}");
            Rating r = EloData.ReadPlayer(shard, uid); True(r.Found); Near(r.Score, 4733);
            Equal(EloData.Url(uid), EloData.BaseUrl + "7b.json"); True(!EloData.IsPublicUid("../../file"));
            True(!EloData.ReadPlayer(shard, "6418551449ce7dd2bc252b00").Found);
            Throws(delegate { EloData.ReadPlayer(Json.ParseObject("{\"x\":{\"rating\":-1,\"sigma\":4}}"), "x"); });
        });
        Check("SDK load, bet, persistence, reload and settlement form one complete flow", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.1.0"); True(mod != null);
                Equal(host.PressHotkey("F8"), 0);
                MatchSnapshot s = Snapshot(1);
                mod.AcceptSnapshot(s, null); Equal(mod.Current, null);
                mod.SetStatus("Elo查询中，已处理7/8");
                mod.AcceptSnapshot(s, Ratings(false)); True(mod.Current != null); True(!mod.Message.Contains("7/8"));
                mod.PlaceBet(s.Players[0].Uid, 1, 10);
                Equal(mod.Book.Balance, 990L);
                var data = new Dictionary<string, object>(); data[PredictionMod.SaveKey] = BookCodec.Write(mod.Book);
                mod = host.Reload<PredictionMod>(Id, "0.1.4", data: data);
                if (mod == null) throw new Exception(host.Find(Id).LastError);
                Equal(mod.Book.Balance, 990L);
                s.Round = 6; mod.AcceptSnapshot(s, null); True(!mod.Current.Locked && mod.Current.TradingWindowOpen);
                s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; mod.AcceptSnapshot(s, null);
                Equal(mod.Book.Balance, 1051L); True(mod.Current.Settled);
                mod.AcceptSnapshot(s, null); Equal(mod.Book.Balance, 1051L);
                True(host.Events("dataChanged").Length >= 5);
                host.SoftDisable(Id); Equal(host.PressHotkey("F8"), 0);
                foreach (var log in host.Logs()) True(log.Lvl != "error");
            }
        });
        Check("preparation errors are visible, deduplicated, and recover without debiting", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.1.2"); MatchSnapshot s = Snapshot(2);
                Rating[] invalid = Ratings(true); invalid[7] = null;
                mod.AcceptSnapshot(s, invalid); mod.AcceptSnapshot(s, invalid);
                Equal(mod.Current, null); Equal(mod.Book.Balance, 1000L);
                True(mod.PreparationError != null && mod.Message.Contains("盘口更新失败"));
                int errors = 0;
                foreach (var log in host.Logs()) if (log.Lvl == "error") errors++;
                Equal(errors, 1);
                mod.AcceptSnapshot(s, Ratings(true)); True(mod.Current != null);
                Equal(mod.PreparationError, null); Equal(mod.Book.Balance, 1000L);
            }
        });
        Check("disable stops new bets but still settles existing tickets", delegate
        {
            using (TestHost host = TestHost.Start())
            {
                PredictionMod mod = host.Load<PredictionMod>(Id, "0.1.0"); MatchSnapshot s = Snapshot(1);
                mod.AcceptSnapshot(s, Ratings(false)); mod.PlaceBet(s.Players[0].Uid, 1, 10);
                host.SetConfig(Id, new Dictionary<string, object> { ["prediction"] = new Dictionary<string, object> { ["enabled"] = false } });
                mod.PlaceBet(s.Players[1].Uid, 2, 10); Equal(mod.Book.Balance, 990L);
                s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; mod.AcceptSnapshot(s, null); Equal(mod.Book.Balance, 1051L);
            }
        });
        MarketCapacityChecks();
        TradingChecks();
        LifeChecks();
        LifeShareChecks();
        TrendChecks();
        RankSelectionChecks();
        GameRankChecks();
        HorseChecks();
        PanelLayoutChecks();
        ReliefChecks();
        DepartureAndClosingChecks();
        ReliefNoticeChecks();
        Check("room final snapshots persist, keep complete ranks and require matching settlement confirmation", RoomFixFixture.VerifyFinals);
        Check("room rank drafts share purchased updates by UID and keep bought players first", RoomFixFixture.VerifySelections);
        Console.WriteLine("Passed: " + _passed + "; Failed: " + _failed);
        return _failed == 0 ? 0 : 1;
    }

    static PredictionBook Open(MatchSnapshot s) { return FixedBook(s, Ratings(true), 2); }
    static PredictionBook FixedBook(MatchSnapshot s, Rating[] ratings, int rules)
    {
        var b = new PredictionBook(1000);
        b.Markets.Add(new Market(s.Id, s.Players, ratings, Odds.Rates(ratings, rules), rules)); b.Observe(s, null); return b;
    }
    static PredictionBook LegacyBook(MatchSnapshot s)
    {
        var b = new PredictionBook(1000); Rating[] ratings = Ratings(false);
        var m = new Market(s.Id, s.Players, ratings, Odds.Rates(ratings, 1), 1); m.HighestRound = s.Round;
        b.Markets.Add(m); return b;
    }
    static Dictionary<string, object> LegacyData(PredictionBook b)
    {
        var data = BookCodec.Write(b); data["version"] = 1;
        foreach (Dictionary<string, object> row in (List<object>)data["markets"]) row.Remove("rules");
        return Json.ParseObject(Json.Serialize(data));
    }
    static Rating[] Ratings(bool varied)
    {
        var ratings = new Rating[8];
        for (int i = 0; i < 8; i++) ratings[i] = new Rating(varied ? 4400 - i * 160 : 3000, 150, true);
        return ratings;
    }
    static MatchSnapshot Snapshot(int round)
    {
        var players = new Player[8];
        for (int i = 0; i < 8; i++) players[i] = new Player("player" + i, "玩家" + (i + 1), false);
        var states = new PlayerState[8];
        for (int i = 0; i < 8; i++) states[i] = new PlayerState(100, 0, 0, 0);
        return new MatchSnapshot { Id = "fixture", Round = round, LiveObserver = true, Players = players, States = states, TradingOpen = true };
    }
    static PredictionBook Reload(PredictionBook b) { return BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(b)))); }
    static void Check(string name, Action body)
    {
        try { body(); _passed++; Console.WriteLine("PASS " + name); }
        catch (Exception ex) { _failed++; Console.WriteLine("FAIL " + name + ": " + ex); }
    }
    static void True(bool value) { if (!value) throw new Exception("Expected true"); }
    static void Near(double actual, double expected) { if (Math.Abs(actual - expected) > 0.000000001) throw new Exception("Probability differs"); }
    static void Equal(object actual, object expected) { if (!object.Equals(actual, expected)) throw new Exception("Expected " + expected + ", actual " + actual); }
    static void Throws(Action body) { try { body(); } catch { return; } throw new Exception("Expected exception"); }
    static void Demo()
    {
        var s = Snapshot(1); PredictionBook book = TradeBook(s);
        Console.WriteLine("动态积分预测演示（模拟数据）：初始 " + book.Balance);
        Buy(book, s, 0, 1, 100); Console.WriteLine("首轮押玩家1夺冠100分；正中权益 " + book.Find(s.Id).Positions[0].Claim);
        s.Round = 6; s.States[0] = new PlayerState(160, 5, 0, 0); book.Observe(s, null);
        Console.WriteLine("第6轮仍可交易；参考清仓值 " + TradingOdds.Sale(book.Find(s.Id), 0, false));
        Sell(book, s, 0, true); Console.WriteLine("减半后余额 " + book.Balance + "；剩余正中权益 " + book.Find(s.Id).Positions[0].Claim);
        Switch(book, s, 0, 2, 50); Console.WriteLine("换押第2名50分；余额 " + book.Balance);
        s.ResultsThroughRound = 6; book.Observe(s, null); Console.WriteLine("收到本轮结果后暂停交易：" + !book.Find(s.Id).TradingWindowOpen);
        book = Reload(book); s.Round = 7; book.Observe(s, null); Console.WriteLine("存档恢复后下一轮继续：" + book.Find(s.Id).TradingWindowOpen);
        s.Ended = true; s.Ranks = new int[] { 1, 2, 3, 4, 5, 6, 7, 8 }; book.Observe(s, null);
        Console.WriteLine("玩家1最终第1名，差一名返还 " + book.Find(s.Id).Positions[0].FinalPayout + " 分；余额 " + book.Balance);
        book.Observe(s, null); Console.WriteLine("重复结果不重复派奖；余额 " + book.Balance);
    }
}
