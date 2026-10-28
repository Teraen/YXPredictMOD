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
            public string Suffix;
            public string[] Targets;
            public UnityWebRequest Request;
            public EloShardScan Scan;
            public bool Fallback;
        }
        public EloClient(ModContext ctx) { _ctx = ctx; }
        bool TryCached(string uid, out Cached cached)
        {
            if (!_profiles.TryGetValue(uid, out cached)) return false;
            if (!cached.Failed || Time.unscaledTime < cached.RetryAt) return true;
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
            Summary = completed < 8 ? "Elo查询中，已处理 " + PredictionMod.N(completed) + "/8（并行请求）"
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
                profiles[i] = !players[i].IsAi && TryCached(players[i].Uid, out cached) ? cached.Profile : new HorseProfile(Rating.Unknown());
            }
            return profiles;
        }
        void Remember(string uid, HorseProfile profile, bool failed)
        {
            if (!_profiles.ContainsKey(uid)) _order.Add(uid);
            _profiles[uid] = new Cached { Profile = profile, Failed = failed, RetryAt = Time.unscaledTime + 30f };
            if (_order.Count > 256) { _profiles.Remove(_order[0]); _order.RemoveAt(0); }
        }
        bool Running(string suffix)
        {
            for (int i = 0; i < _jobs.Length; i++) if (_jobs[i] != null && _jobs[i].Suffix == suffix) return true;
            return false;
        }
        void StartPending()
        {
            for (int i = 0; i < _wanted.Count; i++)
            {
                Cached cached; string uid = _wanted[i];
                if (TryCached(uid, out cached)) continue;
                string suffix = uid.Substring(22);
                if (Running(suffix)) continue;
                int slot = -1;
                for (int j = 0; j < _jobs.Length; j++) if (_jobs[j] == null) { slot = j; break; }
                if (slot < 0) return;
                var targets = new List<string>();
                for (int j = 0; j < _wanted.Count; j++)
                    if (_wanted[j].Substring(22) == suffix && !TryCached(_wanted[j], out cached)) targets.Add(_wanted[j]);
                var job = new Job { Suffix = suffix, Targets = targets.ToArray() };
                _jobs[slot] = job;
                try
                {
                    job.Request = UnityWebRequest.Get(EloData.Url(uid, false)); job.Request.timeout = 8;
                    job.Request.SendWebRequest();
                }
                catch (Exception ex) { Fail(slot, ex.Message); }
            }
        }
        void Release(int slot)
        {
            Job job = _jobs[slot]; _jobs[slot] = null;
            if (job != null && job.Request != null) { job.Request.Abort(); job.Request.Dispose(); }
        }
        void Fail(int slot, string reason)
        {
            Job job = _jobs[slot];
            if (!job.Fallback)
            {
                if (job.Request != null) { job.Request.Abort(); job.Request.Dispose(); }
                job.Request = null; job.Scan = null; job.Fallback = true;
                _ctx.Log.Info("Elo主地址未完成查询，回退原站：" + reason);
                try
                {
                    job.Request = UnityWebRequest.Get(EloData.Url(job.Targets[0], true)); job.Request.timeout = 8;
                    job.Request.SendWebRequest(); return;
                }
                catch (Exception ex) { reason = ex.Message; }
            }
            for (int i = 0; i < job.Targets.Length; i++) Remember(job.Targets[i], new HorseProfile(Rating.Unknown()), true);
            _ctx.Log.Warn("Elo分片查询失败，30秒后可重试：" + reason);
            Release(slot); Revision++;
        }
        void Finish(int slot)
        {
            Job job = _jobs[slot];
            var retry = new List<string>();
            for (int i = 0; i < job.Targets.Length; i++)
            {
                string uid = job.Targets[i];
                try
                {
                    HorseProfile profile = HorseProfile.Read(job.Scan.Rows, uid);
                    if (!job.Fallback && !profile.Rating.Found) retry.Add(uid);
                    else Remember(uid, profile, false);
                }
                catch (Exception ex)
                {
                    if (!job.Fallback) retry.Add(uid);
                    else Remember(uid, new HorseProfile(Rating.Unknown()), true);
                    _ctx.Log.Warn("Elo玩家资料无效：" + ex.Message);
                }
            }
            if (retry.Count > 0) { job.Targets = retry.ToArray(); Fail(slot, "主站缺少玩家或资料无效"); Revision++; return; }
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
                            job.Scan = new EloShardScan(job.Request.downloadHandler.text, job.Targets);
                            job.Request.Dispose(); job.Request = null;
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
