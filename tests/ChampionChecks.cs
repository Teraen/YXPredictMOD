using System;
using Yx.Shared;
using YxPrediction;

internal static partial class Program
{
    static void ChampionChecks()
    {
        Check("champion claims pay 100/25/10 percent, freeze rights and settle once after cutoff", delegate
        {
            for (int rank = 1; rank <= 8; rank++)
            {
                MatchSnapshot s = Snapshot(9); var b = new PredictionBook(1000); Market m = b.Observe(s, Ratings(false));
                True(m.ChampionOnly); Equal(Buy(b, s, 0, 1, 101), null); long claim = m.Positions[0].Claim;
                long balance = b.Balance; True(Buy(b, s, 1, 2, 10) != null); Equal(b.Balance, balance);
                s.Round = 10; b.Observe(s, null); True(!m.TradingWindowOpen); True(Sell(b, s, 0, false) != null);
                b = Reload(b); s.Round = 9; True(Buy(b, s, 1, 1, 10) != null); Equal(b.Balance, balance);
                s.Round = 15; s.Ended = true; s.Ranks = new int[8]; s.Ranks[0] = rank;
                int next = 1; for (int i = 1; i < 8; i++) { if (next == rank) next++; s.Ranks[i] = next++; }
                b.Observe(s, null); long payout = rank == 1 ? claim : rank == 2 ? claim / 4 : rank == 3 ? claim / 10 : 0;
                Equal(b.Balance, balance + payout); b = Reload(b); b.Observe(s, null); Equal(b.Balance, balance + payout);
            }
        });
        Check("exited player cannot receive bets before rank arrives or after UID reorder", delegate
        {
            MatchSnapshot s = Snapshot(4); var b = new PredictionBook(1000); b.Observe(s, Ratings(false));
            Array.Reverse(s.Players); Array.Reverse(s.States); s.States[7] = new PlayerState(0, 0, 0, 0);
            True(Buy(b, s, 0, 1, 10) != null); Equal(b.Balance, 1000L);
            var old = FixedBook(s, Ratings(false), 2); True(old.Bet(s, "player0", 1, 10) != null); Equal(old.Balance, 1000L);
        });
        Check("champion save rejects non-champion held ranks while historical positions retain their rules", delegate
        {
            MatchSnapshot s = Snapshot(4); var b = new PredictionBook(1000); b.Observe(s, Ratings(false)); Buy(b, s, 0, 1, 10);
            var data = BookCodec.Write(b); var row = (System.Collections.Generic.Dictionary<string, object>)Json.GetArray(TradingRow(data), "positions")[0];
            row["rank"] = 2; Throws(delegate { BookCodec.Read(data); });
            var old = TradeBook(s); Equal(Buy(old, s, 0, 3, 10), null); old = Reload(old);
            True(!old.Find(s.Id).ChampionOnly); Equal(old.Find(s.Id).Positions[0].ReturnFor(2), old.Find(s.Id).Positions[0].Claim / 4);
        });
        Check("public room list decoding and trade access follow current observed UID", delegate
        {
            var list = RoomBrowser.Read(Json.ParseObject("{\"page\":0,\"total\":1,\"rooms\":[{\"code\":\"123456\",\"hostName\":\"甲\",\"round\":9,\"members\":2,\"available\":true,\"open\":true}]}"));
            Equal(list.Rooms.Count, 1); Throws(delegate { RoomBrowser.Read(Json.ParseObject("{\"rooms\":[{\"code\":\"abc123\"}]}")); });
            MatchSnapshot s = Snapshot(9); var room = new RoomState { GameId = s.Id, Round = 9, Open = true };
            for (int i = 0; i < 8; i++) room.Uids[i] = s.Players[i].Uid;
            Array.Reverse(s.Players); Array.Reverse(s.States); True(BettingAccess.CanTrade(room, s, 0));
            s.States[7] = new PlayerState(0, 0, 0, 0); True(!BettingAccess.CanTrade(room, s, 0));
            s.Round = 10; True(!BettingAccess.CanTrade(room, s, 1));
        });
    }
}
