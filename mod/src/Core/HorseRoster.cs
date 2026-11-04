using System;
using System.Collections.Generic;
using System.Globalization;
using Yx.Shared;

namespace YxPrediction
{
    // 称号玩法来源：用户提供的 HZ「田忌赛马」1.9.3；数据与状态逻辑重新实现。
    public sealed class HorseProfile
    {
        public readonly Rating Rating;
        public readonly int DaoXinGames, Games;
        public readonly bool Spinning;
        public HorseProfile(Rating rating, int daoXinGames = -1, int games = -1, bool spinning = false)
        { Rating = rating ?? YxPrediction.Rating.Unknown(); DaoXinGames = daoXinGames; Games = games; Spinning = spinning; }

        static bool Number(Dictionary<string, object> row, string key, double maximum, out double value)
        {
            object raw;
            value = double.NaN;
            if (row.TryGetValue(key, out raw))
            {
                if (raw is double) value = (double)raw;
                else if (raw is int) value = (int)raw;
                else if (raw is long) value = (long)raw;
            }
            return !double.IsNaN(value) && !double.IsInfinity(value) && value >= 0 && value <= maximum;
        }
        public static HorseProfile Read(Dictionary<string, object> shard, string uid)
        {
            Rating rating = EloData.ReadPlayer(shard, uid);
            var row = Json.GetObject(shard, uid);
            if (row == null || !rating.Found) return new HorseProfile(rating);
            double dx, games;
            int dxCount = Number(row, "dx", 100000000, out dx) ? (int)dx : -1;
            int gameCount = Number(row, "games", 100000000, out games) ? (int)games : -1;
            var seasons = Json.GetObject(row, "seasons");
            Dictionary<string, object> latest = null;
            int latestSeason = -1;
            if (seasons != null)
                foreach (var pair in seasons)
                {
                    int season;
                    if (int.TryParse(pair.Key, out season) && season >= 0 && season > latestSeason)
                    { latestSeason = season; latest = pair.Value as Dictionary<string, object>; }
                }
            double start, end, peak;
            bool spinning = latest != null && Number(latest, "start", 10000, out start)
                && Number(latest, "end", 10000, out end) && Number(latest, "peak", 10000, out peak)
                && peak >= Math.Max(start, end) && peak - start >= 150 && end <= start;
            return new HorseProfile(rating, dxCount, gameCount, spinning);
        }
    }

    public sealed class HorseMember
    {
        public readonly string Uid;
        public readonly bool IsAi;
        readonly string _aiTitle;
        public string Name, BaseTitle = "";
        public HorseProfile Profile;
        public bool DarkHorse;
        public bool AllocatedTier;
        public string RoomTitle;
        public int ConsecutiveWins { get; private set; }
        int _round, _wins, _losses, _lastResultRound;
        bool _baseline;
        public HorseMember(Player player, string matchId)
        {
            Uid = player.Uid; Name = player.Name; IsAi = player.IsAi;
            if (IsAi) _aiTitle = AiTitle(matchId, player.Uid);
        }
        // 有界的稳定伪随机：同局同UID不随刷新、排序、重载而改变，不参与赔率或真实难度识别。
        static string AiTitle(string matchId, string uid)
        {
            string seed = (matchId ?? "") + ":" + uid;
            int value = 17;
            for (int i = 0; i < seed.Length; i++) value = (value * 31 + seed[i]) % 1000003;
            switch (value % 5)
            {
                case 0: return "电子马·地狱";
                case 1: return "电子马·极难";
                case 2: return "电子马·困难";
                case 3: return "电子马·中等";
                default: return "电子马·简单";
            }
        }
        public string Title { get { return RoomTitle != null ? RoomTitle : IsAi ? _aiTitle : (AllocatedTier ? (BaseTitle.Length > 0 ? BaseTitle : "未定马") : DarkHorse ? "黑马" : BaseTitle); } }
        public string IconTitle { get { return IsAi ? "机械马" : Title; } }
        public string PlateCaption { get { return Title; } }
        public string Tags { get { string tag = AllocatedTier && DarkHorse ? "黑马" : ""; return !IsAi && Profile != null && Profile.Spinning ? (tag.Length > 0 ? tag + " · 旋转木马" : "旋转木马") : tag; } }
        public string Caption { get { return Title + (Tags.Length > 0 ? " · " + Tags : ""); } }
        public string Explanation
        {
            get
            {
                if (IsAi) return "AI随机装饰称号，同局保持不变；不代表实际难度，不参与Elo分档或赔率计算";
                if (AllocatedTier) return "本局随机换档后的马匹称号，基础倍率采用同一档位；实时命元和胜负仍取本人";
                if (DarkHorse) return "本局Elo后半，已观察到连续两胜";
                switch (BaseTitle)
                {
                    case "特等马": return "本局已查到的Elo最高";
                    case "上等马": return "本局已查到的Elo第二";
                    case "牛马": return "本局已查到的Elo最低";
                    case "海马": return "本局Elo最低，与上一档差距较大";
                    case "中等马": return "按本局已查到的Elo分档";
                    default: return "暂无公开Elo，不参与分档";
                }
            }
        }
        internal void Observe(int round, PlayerState state)
        {
            if (IsAi) return;
            if (state == null || round < 1 || (_baseline && (round < _round || state.Wins < _wins || state.Losses < _losses))) return;
            if (!_baseline)
            {
                _baseline = true; _round = _lastResultRound = round; _wins = state.Wins; _losses = state.Losses;
                return; // 中途观战的累计胜场不能推断为连胜。
            }
            int won = state.Wins - _wins, lost = state.Losses - _losses;
            if (won > 0 || lost > 0)
            {
                ConsecutiveWins = won == 1 && lost == 0 ? (round == _lastResultRound + 1 ? ConsecutiveWins + 1 : 1) : 0;
                _lastResultRound = round;
            }
            else if (round > _lastResultRound + 1) ConsecutiveWins = 0;
            _round = round; _wins = state.Wins; _losses = state.Losses;
        }
    }

    public sealed class HorseRoster
    {
        public string MatchId { get; private set; }
        public HorseMember[] Members { get; private set; }
        int[] _sources;
        bool _shuffle, _profilesLocked;
        public HorseMember Find(string uid)
        {
            if (Members != null && uid != null) for (int i = 0; i < Members.Length; i++) if (Members[i].Uid == uid) return Members[i];
            return null;
        }
        public void Clear() { MatchId = null; Members = null; _sources = null; _profilesLocked = false; }
        public void RoomTitles(string[] uids, string[] titles)
        {
            if (Members == null) return;
            for (int i = 0; i < Members.Length; i++) Members[i].RoomTitle = null;
            if (uids == null || titles == null || uids.Length != 8 || titles.Length != 8) return;
            for (int i = 0; i < 8; i++) { HorseMember member = Find(uids[i]); if (member != null) member.RoomTitle = titles[i]; }
        }
        public void Observe(MatchSnapshot snapshot, HorseProfile[] profiles)
        { Observe(snapshot, profiles, snapshot != null && snapshot.ShuffleHorses); }
        public void Observe(MatchSnapshot snapshot, HorseProfile[] profiles, bool shuffle)
        {
            if (snapshot == null || !snapshot.IsEightPlayerMatch() || (snapshot.States != null && snapshot.States.Length != 8)) { Clear(); return; }
            bool reset = MatchId != snapshot.Id || Members == null || _shuffle != shuffle;
            if (!reset) for (int i = 0; i < 8; i++) if (Find(snapshot.Players[i].Uid) == null) reset = true;
            if (reset)
            {
                MatchId = snapshot.Id; Members = new HorseMember[8];
                for (int i = 0; i < 8; i++) Members[i] = new HorseMember(snapshot.Players[i], snapshot.Id);
                _shuffle = shuffle; _sources = shuffle ? HorseShuffle.Sources(snapshot.Id, snapshot.Players) : null; _profilesLocked = false;
            }
            for (int i = 0; i < 8; i++)
            {
                HorseMember member = Find(snapshot.Players[i].Uid);
                member.Name = snapshot.Players[i].Name;
                member.AllocatedTier = _shuffle && !member.IsAi;
                if ((!_shuffle || !_profilesLocked) && profiles != null && profiles.Length == 8 && profiles[i] != null) member.Profile = profiles[i];
                member.Observe(snapshot.Round, snapshot.States == null ? null : snapshot.States[i]);
            }
            if (_shuffle && profiles != null && profiles.Length == 8)
            {
                bool complete = true; for (int i = 0; i < 8; i++) if (profiles[i] == null) complete = false;
                if (complete) _profilesLocked = true;
            }
            AssignTitles(snapshot);
        }
        HorseProfile ProfileAt(int index) { return Members[_shuffle ? _sources[index] : index].Profile; }
        void AssignTitles(MatchSnapshot snapshot)
        {
            int rated = 0;
            double minimum = 10001, maximum = -1, aboveMinimum = 10001;
            for (int i = 0; i < 8; i++)
            {
                HorseProfile p = ProfileAt(i);
                if (Members[i].IsAi || p == null || !p.Rating.Found) continue;
                double score = p.Rating.Score;
                rated++; minimum = Math.Min(minimum, score); maximum = Math.Max(maximum, score);
            }
            for (int i = 0; i < 8; i++)
            {
                HorseProfile p = ProfileAt(i);
                if (!Members[i].IsAi && p != null && p.Rating.Found && p.Rating.Score > minimum) aboveMinimum = Math.Min(aboveMinimum, p.Rating.Score);
            }
            for (int i = 0; i < 8; i++)
            {
                HorseMember member = Members[i];
                member.BaseTitle = ""; member.DarkHorse = false;
                HorseProfile profile = ProfileAt(i);
                if (member.IsAi || profile == null || !profile.Rating.Found) continue;
                double score = profile.Rating.Score;
                int higher = 0;
                for (int j = 0; j < 8; j++)
                    if (!Members[j].IsAi && ProfileAt(j) != null && ProfileAt(j).Rating.Found && ProfileAt(j).Rating.Score > score) higher++;
                member.BaseTitle = "中等马";
                if (rated >= 2 && maximum > minimum)
                {
                    member.BaseTitle = higher == 0 ? "特等马" : (higher == 1 ? "上等马" : "中等马");
                    if (score == minimum) member.BaseTitle = aboveMinimum - score >= 400 ? "海马" : "牛马";
                }
                bool alive = false;
                if (snapshot.States != null)
                    for (int j = 0; j < 8; j++) if (snapshot.Players[j].Uid == member.Uid && snapshot.States[j] != null) alive = snapshot.States[j].Life > 0;
                member.DarkHorse = rated >= 2 && higher >= (rated + 1) / 2 && member.ConsecutiveWins >= 2 && alive;
            }
        }
    }
}
