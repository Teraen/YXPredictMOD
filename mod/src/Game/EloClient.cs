#if YX_GAME
using System;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEngine;
using UnityEngine.Networking;
using Yx.ModSdk;

namespace YxPrediction
{
    // HTTP is concurrent; every completion and parse still runs on the Unity main thread.
    public sealed class EloClient
    {
        public const int MaximumRequests = 4;
        public const int MaximumResponseCharacters = 65536;
        readonly ModContext _ctx;
        readonly Job[] _jobs = new Job[MaximumRequests];
        readonly Dictionary<string, Cached> _profiles = new Dictionary<string, Cached>();
        readonly List<string> _order = new List<string>();
        readonly List<string> _wanted = new List<string>();
        int _cursor;
        public int Revision { get; private set; }
        public string Summary { get; private set; }
        sealed class Cached
        {
            public HorseProfile Profile;
            public bool Failed;
            public float RetryAt;
        }
        sealed class Job
        {
            public string[] Targets;
            public UnityWebRequest Request;
            public EloShardScan Scan;
            public float Deadline;
        }
        public EloClient(ModContext ctx) { _ctx = ctx; }
        bool TryCached(string uid, out Cached cached)
        {
            if (!_profiles.TryGetValue(uid, out cached)) return false;
            if (Time.unscaledTime < cached.RetryAt) return true;
            _profiles.Remove(uid); _order.Remove(uid); cached = null; return false;
        }
        public Rating[] Get(Player[] players)
        {
            if (players == null || players.Length != 8) return null;
            _wanted.Clear();
            for (int i = 0; i < 8; i++)
                if (players[i] != null && !players[i].IsAi && EloData.IsPublicUid(players[i].Uid) && !_wanted.Contains(players[i].Uid))
                    _wanted.Add(players[i].Uid);
            StartPending();
            var ratings = new Rating[8];
            int found = 0, missing = 0, failed = 0, invalid = 0, ai = 0, completed = 0;
            for (int i = 0; i < 8; i++)
            {
                Player player = players[i];
                if (player != null && player.IsAi) { ai++; completed++; ratings[i] = Rating.Unknown(); continue; }
                if (player == null || !EloData.IsPublicUid(player.Uid)) { invalid++; completed++; ratings[i] = Rating.Unknown(); continue; }
                Cached cached;
                if (!TryCached(player.Uid, out cached)) continue;
                completed++; ratings[i] = cached.Profile.Rating;
                if (cached.Failed) failed++; else if (ratings[i].Found) found++; else missing++;
            }
            Summary = completed < 8 ? "Elo查询中，已处理 " + PredictionMod.N(completed) + "/8（批量请求）"
                : "Elo：命中 " + PredictionMod.N(found) + " / 未收录 " + PredictionMod.N(missing) + " / 请求失败 " + PredictionMod.N(failed) + " / UID异常 " + PredictionMod.N(invalid) + " / AI " + PredictionMod.N(ai);
            return completed < 8 ? null : ratings;
        }
        public HorseProfile[] GetHorseProfiles(Player[] players)
        {
            if (Get(players) == null) return null;
            var profiles = new HorseProfile[8];
            for (int i = 0; i < 8; i++)
            {
                Cached cached;
                profiles[i] = players[i] != null && !players[i].IsAi && EloData.IsPublicUid(players[i].Uid) && TryCached(players[i].Uid, out cached) ? cached.Profile : new HorseProfile(Rating.Unknown());
            }
            return profiles;
        }
        void Remember(string uid, HorseProfile profile, bool failed)
        {
            if (!_profiles.ContainsKey(uid)) _order.Add(uid);
            _profiles[uid] = new Cached { Profile = profile, Failed = failed, RetryAt = Time.unscaledTime + (!failed && profile.Rating.Found ? 300f : 30f) };
            if (_order.Count > 256) { _profiles.Remove(_order[0]); _order.RemoveAt(0); }
        }
        bool Running(string uid)
        {
            for (int i = 0; i < _jobs.Length; i++)
                if (_jobs[i] != null)
                    for (int j = 0; j < _jobs[i].Targets.Length; j++) if (_jobs[i].Targets[j] == uid) return true;
            return false;
        }
        void StartPending()
        {
            int slot = -1;
            for (int j = 0; j < _jobs.Length; j++) if (_jobs[j] == null) { slot = j; break; }
            if (slot < 0) return;
            var targets = new List<string>();
            for (int i = 0; i < _wanted.Count; i++)
            {
                Cached cached; string uid = _wanted[i];
                if (!TryCached(uid, out cached) && !Running(uid)) targets.Add(uid);
            }
            if (targets.Count == 0) return;
            var job = new Job { Targets = targets.ToArray(), Deadline = Time.unscaledTime + 10f }; _jobs[slot] = job;
            try { job.Request = UnityWebRequest.Get(EloData.BatchUrl(job.Targets)); job.Request.timeout = 8; job.Request.SendWebRequest(); }
            catch (Exception ex) { Fail(slot, ex.Message); }
        }
        void Release(int slot)
        {
            Job job = _jobs[slot]; _jobs[slot] = null;
            if (job != null && job.Request != null) { job.Request.Abort(); job.Request.Dispose(); }
        }
        void Fail(int slot, string reason)
        {
            Job job = _jobs[slot];
            for (int i = 0; i < job.Targets.Length; i++) Remember(job.Targets[i], new HorseProfile(Rating.Unknown()), true);
            _ctx.Log.Warn("Elo批量查询失败，30秒后可重试：" + reason);
            Release(slot); Revision++;
        }
        void Finish(int slot)
        {
            Job job = _jobs[slot];
            for (int i = 0; i < job.Targets.Length; i++)
            {
                string uid = job.Targets[i];
                try { Remember(uid, HorseProfile.Read(job.Scan.Rows, uid), false); }
                catch (Exception ex) { Remember(uid, new HorseProfile(Rating.Unknown()), true); _ctx.Log.Warn("Elo玩家资料无效：" + ex.Message); }
            }
            Release(slot); Revision++;
        }
        public void Update()
        {
            bool active = false;
            for (int i = 0; i < _jobs.Length; i++) if (_jobs[i] != null) active = true;
            if (!active) return;
            var timer = Stopwatch.StartNew();
            bool decoded = false;
            int idle = 0, steps = 0;
            // One global budget shared by all four jobs, with round-robin fairness.
            do
            {
                int slot = _cursor; _cursor = (_cursor + 1) % _jobs.Length;
                Job job = _jobs[slot]; bool worked = false;
                if (job != null)
                {
                    try
                    {
                        if (job.Scan != null)
                        {
                            job.Scan.Step(1024); worked = true;
                            if (job.Scan.Done) Finish(slot);
                        }
                        else if (!decoded && job.Request != null && job.Request.isDone)
                        {
                            decoded = true; worked = true;
                            if (job.Request.isNetworkError || job.Request.isHttpError) throw new InvalidOperationException(job.Request.error);
                            string response = job.Request.downloadHandler.text;
                            if (response == null || response.Length > MaximumResponseCharacters) throw new FormatException("Elo查询响应过大或为空");
                            job.Scan = new EloShardScan(response, job.Targets);
                            job.Request.Dispose(); job.Request = null;
                        }
                        else if (job.Request != null && !job.Request.isDone && Time.unscaledTime >= job.Deadline)
                        {
                            Fail(slot, "请求超时"); worked = true;
                        }
                    }
                    catch (Exception ex) { Fail(slot, ex.Message); worked = true; }
                }
                idle = worked ? 0 : idle + 1;
                steps++;
            } while (idle < _jobs.Length && steps < 64 && timer.ElapsedMilliseconds < 2);
            if (timer.ElapsedMilliseconds >= 8) _ctx.Log.Warn("Elo本帧处理耗时 " + PredictionMod.N(timer.ElapsedMilliseconds) + "ms");
            StartPending();
        }
        public void Destroy()
        {
            _wanted.Clear();
            for (int i = 0; i < _jobs.Length; i++) Release(i);
        }
    }
}
#endif
