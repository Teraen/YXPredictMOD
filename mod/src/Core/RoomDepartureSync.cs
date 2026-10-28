using System;
using System.Collections.Generic;
using Yx.Shared;

namespace YxPrediction
{
    public sealed class RoomDepartureSync
    {
        public const string SaveKey = "room.departures.v1";
        public sealed class Entry { public string Server, Token, Code, GameId, Operation; }
        readonly List<Entry> _entries = new List<Entry>();
        public int Count { get { return _entries.Count; } }
        public Entry At(int index) { return _entries[index]; }
        public bool Contains(string server, string token, string code, string gameId)
        {
            for (int i = 0; i < _entries.Count; i++) if (Same(_entries[i], server, token, code, gameId)) return true;
            return false;
        }
        static bool Same(Entry entry, string server, string token, string code, string gameId)
        { return entry.Server == server && entry.Token == token && entry.Code == code && entry.GameId == gameId; }
        public bool Capture(string server, string token, string code, string gameId, string operation = null)
        {
            if (string.IsNullOrEmpty(server) || string.IsNullOrEmpty(token) || string.IsNullOrEmpty(code) || string.IsNullOrEmpty(gameId)
                || Contains(server, token, code, gameId)) return false;
            if (operation != null)
            {
                if (operation.Length < 8 || operation.Length > 80) return false;
                for (int i = 0; i < operation.Length; i++)
                    if (!((operation[i] >= 'a' && operation[i] <= 'z') || (operation[i] >= 'A' && operation[i] <= 'Z') || (operation[i] >= '0' && operation[i] <= '9') || operation[i] == '-')) return false;
            }
            _entries.Add(new Entry { Server = server, Token = token, Code = code, GameId = gameId, Operation = operation ?? Guid.NewGuid().ToString("N") });
            return true;
        }
        public bool Confirm(Entry entry, string code, string gameId, bool confirmed)
        {
            if (!confirmed || entry.Code != code || entry.GameId != gameId) return false;
            for (int i = 0; i < _entries.Count; i++) if (Same(_entries[i], entry.Server, entry.Token, code, gameId)) { _entries.RemoveAt(i); return true; }
            return false;
        }
        public Dictionary<string, object> Write()
        {
            var jobs = new List<object>();
            for (int i = 0; i < _entries.Count; i++)
            {
                Entry e = _entries[i];
                jobs.Add(new Dictionary<string, object> { { "server", e.Server }, { "token", e.Token }, { "code", e.Code }, { "gameId", e.GameId }, { "operation", e.Operation } });
            }
            return Json.ParseObject(Json.Serialize(new Dictionary<string, object> { { "jobs", jobs } }));
        }
        public static RoomDepartureSync Read(Dictionary<string, object> data)
        {
            var result = new RoomDepartureSync(); if (data == null) return result;
            var jobs = Json.GetArray(data, "jobs"); if (jobs == null) throw new FormatException("离场待同步记录损坏");
            for (int i = 0; i < jobs.Count; i++)
            {
                var row = jobs[i] as Dictionary<string, object>;
                if (row == null || !result.Capture(Json.GetString(row,"server",""), Json.GetString(row,"token",""), Json.GetString(row,"code",""), Json.GetString(row,"gameId",""), Json.GetString(row,"operation","")))
                    throw new FormatException("离场待同步记录无效");
            }
            return result;
        }
    }
}
