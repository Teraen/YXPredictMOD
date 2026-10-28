using System;
using System.Collections.Generic;
using System.Globalization;
using Yx.Shared;

namespace YxPrediction
{
    // 保存房主已观察到的结束快照，直到服务端确认结算；与当前场景/连接房间无关。
    public sealed class RoomFinalSync
    {
        public const string SaveKey = "room.finalSync.v1";
        public sealed class Entry
        {
            public string Server, Token, Code, GameId;
            public Dictionary<string, object> Snapshot;
        }
        readonly List<Entry> _entries = new List<Entry>();
        public int Count { get { return _entries.Count; } }
        public Entry At(int index) { return _entries[index]; }
        static bool Same(Entry a, Entry b)
        { return a.Server == b.Server && a.Token == b.Token && a.Code == b.Code && a.GameId == b.GameId; }
        static int Known(Dictionary<string, object> snapshot)
        {
            var ranks = Json.GetArray(snapshot, "ranks"); int count = 0;
            if (ranks != null) for (int i = 0; i < ranks.Count; i++) if (Convert.ToInt32(ranks[i], CultureInfo.InvariantCulture) > 0) count++;
            return count;
        }
        public bool Capture(string server, string token, string code, Dictionary<string, object> snapshot)
        {
            if (string.IsNullOrEmpty(server) || string.IsNullOrEmpty(token) || string.IsNullOrEmpty(code)
                || snapshot == null || !Json.GetBool(snapshot, "ended", false)) return false;
            var next = new Entry { Server = server, Token = token, Code = code, GameId = Json.GetString(snapshot, "id", "") };
            if (next.GameId.Length == 0) return false;
            string wire = Json.Serialize(snapshot);
            next.Snapshot = Json.ParseObject(wire);
            wire = Json.Serialize(next.Snapshot); // SDK解析后的数值类型归一后再比较，避免每帧重复落盘。
            for (int i = 0; i < _entries.Count; i++) if (Same(_entries[i], next))
            {
                var old = _entries[i].Snapshot;
                if (Json.GetNumber(next.Snapshot, "round", 0) < Json.GetNumber(old, "round", 0)
                    || Known(next.Snapshot) < Known(old) || Json.Serialize(old) == wire) return false;
                _entries[i] = next; return true;
            }
            _entries.Add(next); return true;
        }
        public bool HasComplete(string server, string token, string code, string gameId)
        {
            for (int i = 0; i < _entries.Count; i++)
            {
                Entry entry = _entries[i];
                if (entry.Server != server || entry.Token != token || entry.Code != code || entry.GameId != gameId) continue;
                var ranks = Json.GetArray(entry.Snapshot, "ranks"); if (ranks == null || ranks.Count != 8) continue;
                var seen = new bool[9]; bool complete = true;
                for (int n = 0; n < 8; n++)
                {
                    int rank = Convert.ToInt32(ranks[n], CultureInfo.InvariantCulture);
                    if (rank < 1 || rank > 8 || seen[rank]) { complete = false; break; }
                    seen[rank] = true;
                }
                if (complete) return true;
            }
            return false;
        }
        public bool Confirm(Entry entry, string code, string gameId, bool settled)
        {
            if (!settled || entry.Code != code || entry.GameId != gameId) return false;
            for (int i = 0; i < _entries.Count; i++) if (Same(_entries[i], entry)) { _entries.RemoveAt(i); return true; }
            return false;
        }
        public Dictionary<string, object> Write()
        {
            var jobs = new List<object>();
            for (int i = 0; i < _entries.Count; i++)
            {
                Entry e = _entries[i];
                jobs.Add(new Dictionary<string, object> { { "server", e.Server }, { "token", e.Token }, { "code", e.Code }, { "snapshot", e.Snapshot } });
            }
            return Json.ParseObject(Json.Serialize(new Dictionary<string, object> { { "jobs", jobs } }));
        }
        public static RoomFinalSync Read(Dictionary<string, object> data)
        {
            var result = new RoomFinalSync(); if (data == null) return result;
            var jobs = Json.GetArray(data, "jobs"); if (jobs == null) throw new FormatException("最终结果待同步记录损坏");
            for (int i = 0; i < jobs.Count; i++)
            {
                var row = jobs[i] as Dictionary<string, object>;
                if (row == null || !result.Capture(Json.GetString(row, "server", ""), Json.GetString(row, "token", ""),
                    Json.GetString(row, "code", ""), row.ContainsKey("snapshot") ? row["snapshot"] as Dictionary<string, object> : null))
                    throw new FormatException("最终结果待同步记录无效");
            }
            return result;
        }
    }
}
