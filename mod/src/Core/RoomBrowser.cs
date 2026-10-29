using System;
using System.Collections.Generic;
using Yx.Shared;

namespace YxPrediction
{
    public sealed class PublicRoom
    {
        public string Code, HostName;
        public int Round, Members;
        public bool Available, Open;
    }
    public sealed class RoomBrowser
    {
        public int Page, Total;
        public readonly List<PublicRoom> Rooms = new List<PublicRoom>();
        public static RoomBrowser Read(Dictionary<string, object> data)
        {
            var browser = new RoomBrowser();
            browser.Page = (int)Json.GetNumber(data, "page", 0); browser.Total = (int)Json.GetNumber(data, "total", 0);
            var rows = Json.GetArray(data, "rooms");
            if (browser.Page < 0 || browser.Total < 0 || browser.Total > 1000 || rows == null || rows.Count > 6) throw new FormatException("房间列表无效");
            for (int i = 0; i < rows.Count; i++)
            {
                var row = rows[i] as Dictionary<string, object>;
                string code = Json.GetString(row, "code", "");
                if (code.Length != 6) throw new FormatException("房间号无效");
                for (int j = 0; j < code.Length; j++) if (code[j] < '0' || code[j] > '9') throw new FormatException("房间号无效");
                browser.Rooms.Add(new PublicRoom { Code = code, HostName = Json.GetString(row, "hostName", "观众"),
                    Round = (int)Json.GetNumber(row, "round", 0), Members = (int)Json.GetNumber(row, "members", 0),
                    Available = Json.GetBool(row, "available", false), Open = Json.GetBool(row, "open", false) });
            }
            return browser;
        }
    }
    public static class BettingAccess
    {
        public static bool CanTrade(RoomState room, MatchSnapshot snapshot, int player)
        {
            if (room == null || snapshot == null || player < 0 || player >= 8 || !room.Open || room.Settled || room.Forfeited || room.TradingClosed
                || room.Round >= PredictionBook.BettingCloseRound || snapshot.Round >= PredictionBook.BettingCloseRound
                || room.GameId != snapshot.Id || !room.Active[player] || room.Ranks[player] > 0 || snapshot.Players == null || snapshot.States == null) return false;
            for (int i = 0; i < snapshot.Players.Length; i++)
                if (snapshot.Players[i].Uid == room.Uids[player]) return i < snapshot.States.Length && snapshot.States[i] != null && snapshot.States[i].Life > 0;
            return false;
        }
    }
}
