using System.Collections.Generic;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void ProtocolState(MatchSnapshot s, int[] life, int[] rawRanks)
    {
        s.Ranks = new int[8];
        for (int i = 0; i < 8; i++)
        {
            s.Ranks[i] = GameRanks.FromProtocol(rawRanks[i]);
            s.States[i] = GameRanks.ReadState(life[i], 0, 0, rawRanks[i]);
        }
    }

    static void GameRankChecks()
    {
        Check("protocol rank zero through seven maps to first through eighth without clamping invalid ranks", delegate
        {
            for (int i = 0; i < 8; i++) Equal(GameRanks.FromProtocol(i), i + 1);
            foreach (int rank in new int[] { -1, 8, 9, int.MinValue, int.MaxValue }) Equal(GameRanks.FromProtocol(rank), 0);
        });
        Check("living players' display ranks are not mistaken for confirmed final places", delegate
        {
            for (int rank = 0; rank < 8; rank++)
            {
                Equal(GameRanks.ReadState(100, 2, 3, rank).FinalRank, 0);
                Equal(GameRanks.ReadState(0, 2, 3, rank).FinalRank, rank + 1);
                Equal(GameRanks.ReadState(-19, 2, 3, rank).FinalRank, rank + 1);
            }
            Equal(GameRanks.ReadState(-19, 0, 0, 8).FinalRank, 0);
        });
        Check("reported eighth-place holding settles all 388 locked points with four eliminated players", delegate
        {
            MatchSnapshot s = Snapshot(9); PredictionBook b = TradeBook(s); Buy(b, s, 6, 8, 40);
            // 反馈截图中的已保存持仓：成本40，分次买入后锁定正中返还388，不使用当前10分预览重算。
            Dictionary<string, object> data = BookCodec.Write(b);
            var p = (Dictionary<string, object>)Json.GetArray(TradingRow(data), "positions")[6]; p["claim"] = 388;
            b = BookCodec.Read(data); b.Observe(s, null);
            s.Round = 15;
            ProtocolState(s, new int[] { -18, 48, 0, 29, -12, 74, -19, 66 }, new int[] { 4, 2, 5, 3, 6, 0, 7, 1 });
            b.Observe(s, null); Market m = b.Find(s.Id);
            Equal(m.KnownRanks[6], 8); True(m.Positions[6].Resolved); Equal(m.Positions[6].FinalPayout, 388L);
            Equal(b.Balance, 1348L); True(!m.TradingWindowOpen && m.Locked);
            Equal(m.KnownRanks[0], 5); Equal(m.KnownRanks[2], 6); Equal(m.KnownRanks[4], 7);
            True(!m.Positions[1].Resolved && !m.Settled);
            b.Observe(s, null); b = Reload(b); b.Observe(s, null); Equal(b.Balance, 1348L);
        });
        Check("an old blocked pending save recovers on fresh normalized status without duplicate awards", delegate
        {
            MatchSnapshot s = Snapshot(9); PredictionBook b = TradeBook(s); Buy(b, s, 6, 8, 40); Buy(b, s, 4, 6, 10);
            Market m = b.Find(s.Id); long exact = m.Positions[6].Claim, adjacent = m.Positions[4].Claim / 4;
            int[] life = new int[] { -18, 48, 0, 29, -12, 74, -19, 66 };
            int[] raw = new int[] { 4, 2, 5, 3, 6, 0, 7, 1 }; s.Round = 15;
            // 旧桥接把原始0起始名次直接传入；第5名被当作第4名，触发整批暂停。
            for (int i = 0; i < 8; i++) s.States[i] = new PlayerState(life[i], 0, 0, life[i] <= 0 && raw[i] >= 1 ? raw[i] : 0);
            b.Observe(s, null); Equal(b.Balance, 950L); True(!m.Positions[6].Resolved && !m.TradingWindowOpen);
            Equal(m.TradingWaitReason, "确定名次与存活人数尚未对齐");
            b = Reload(b); ProtocolState(s, life, raw); b.Observe(s, null);
            Equal(b.Balance, 950L + exact + adjacent); Equal(b.Find(s.Id).KnownRanks[6], 8);
            b = Reload(b); b.Observe(s, null); Equal(b.Balance, 950L + exact + adjacent);
        });
        Check("first elimination with raw rank seven pays the exact eighth and quarter seventh predictions", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook exact = TradeBook(s), near = TradeBook(s);
            Buy(exact, s, 7, 8, 10); Buy(near, s, 7, 7, 10);
            long exactClaim = exact.Find(s.Id).Positions[7].Claim, nearClaim = near.Find(s.Id).Positions[7].Claim / 4;
            s.Round = 8; ProtocolState(s, new int[] { 100, 99, 98, 97, 96, 95, 94, -19 }, new int[] { 0, 1, 2, 3, 4, 5, 6, 7 });
            exact.Observe(s, null); near.Observe(s, null);
            Equal(exact.Balance, 990L + exactClaim); Equal(near.Balance, 990L + nearClaim);
            Equal(exact.Find(s.Id).KnownRanks[7], 8); True(exact.Find(s.Id).TradingWindowOpen);
        });
        Check("zero-based complete results settle a winner with raw rank zero and survive UID reordering", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s);
            Buy(b, s, 0, 1, 10); Buy(b, s, 7, 8, 10);
            long expected = 980L + b.Find(s.Id).Positions[0].Claim + b.Find(s.Id).Positions[7].Claim;
            s.Ended = true; s.Round = 20;
            ProtocolState(s, new int[] { 20, -1, -2, -3, -4, -5, -6, -7 }, new int[] { 0, 1, 2, 3, 4, 5, 6, 7 });
            System.Array.Reverse(s.Players); System.Array.Reverse(s.States); System.Array.Reverse(s.Ranks);
            b.Observe(s, null); Market m = b.Find(s.Id); True(m.Settled); Equal(b.Balance, expected);
            Equal(m.FinalRanks[0], 1); Equal(m.FinalRanks[7], 8); b = Reload(b); b.Observe(s, null); Equal(b.Balance, expected);
        });
        Check("invalid or duplicated protocol ranks cannot settle or reopen the affected market", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = TradeBook(s); Buy(b, s, 7, 8, 10);
            s.Round = 10;
            ProtocolState(s, new int[] { 100, 99, 98, 97, 96, 95, -1, -2 }, new int[] { 0, 1, 2, 3, 4, 5, 7, 7 });
            b.Observe(s, null); True(!b.Find(s.Id).TradingWindowOpen); Equal(b.Balance, 990L);
            s.Ended = true; s.Ranks[7] = GameRanks.FromProtocol(8); b.Observe(s, null);
            True(!b.Find(s.Id).Settled); Equal(b.Balance, 990L);
        });
        Check("legacy fixed tickets also settle normalized zero-based final results", delegate
        {
            MatchSnapshot s = Snapshot(1); PredictionBook b = Open(s); b.Bet(s, "player0", 1, 10); b.Bet(s, "player7", 8, 10);
            long expected = 980L + b.Find(s.Id).Tickets[0].Payout + b.Find(s.Id).Tickets[7].Payout;
            s.Ended = true; ProtocolState(s, new int[] { 10, -1, -2, -3, -4, -5, -6, -7 }, new int[] { 0, 1, 2, 3, 4, 5, 6, 7 });
            b.Observe(s, null); True(b.Find(s.Id).Settled); Equal(b.Balance, expected);
        });
    }
}
