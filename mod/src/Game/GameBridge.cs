#if YX_GAME
using System;
using System.Globalization;
using System.Reflection;
using UnityEngine;
using Yx.ModSdk;
using Yx.ModSdk.Game;

namespace YxPrediction
{
    public sealed class GameBridge
    {
        readonly PredictionMod _mod;
        readonly EloClient _elo;
        readonly ModContext _ctx;
        string _lastDiagnostic;
        string _ratingMarketId;
        string _marketSummary;
        string _resultMatchId;
        int _resultsThroughRound, _completeResultsThroughRound;
        float _nextPoll;
        int _eloRevision;
        public GameBridge(PredictionMod mod, ModContext ctx) { _mod = mod; _ctx = ctx; _elo = new EloClient(ctx); }
        public HorseProfile[] HorseProfiles(Player[] players) { return _elo.GetHorseProfiles(players); }

        void Waiting(string message)
        {
            _mod.SetStatus(message);
            _mod.SetQueryStatus(message);
            if (message == _lastDiagnostic) return;
            _lastDiagnostic = message;
            _ctx.Log.Info("观战预测状态：" + message);
        }

        public static BattlePanel GetBattlePanel()
        {
            BattleManager manager = BattleManager.Instance;
            if (manager == null) return null;
            FieldInfo fi = manager.GetType().GetField("m_BattlePanel", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return fi == null ? null : fi.GetValue(manager) as BattlePanel;
        }

        public void Update()
        {
            BattleManager manager = BattleManager.Instance;
            _mod.SetFocusedUid(manager != null && SceneLoader.currentSceneName == "Battle" ? FocusUid(manager, manager.currentGameStatus) : null);
            _elo.Update();
            if (Time.unscaledTime < _nextPoll && _eloRevision == _elo.Revision) return;
            _eloRevision = _elo.Revision;
            _nextPoll = Time.unscaledTime + 0.5f;
            Poll();
        }

        public static string FocusUid(BattleManager manager, Proto.GameStatus status)
        {
            if (manager == null || status == null || status.battlePlayerDatas == null) return null;
            string uid = null;
            try
            {
                BattlePanel bp = GetBattlePanel();
                if (bp != null)
                {
                    OpponentInfoPanel opp = bp.FindILRSubPanel<OpponentInfoPanel>();
                    if (opp != null && opp.panel != null && opp.panel.isShow && opp.panel.gameObject.activeInHierarchy
                        && opp.bpInfoItem != null && opp.bpInfoItem.battlePlayerData != null)
                    {
                        uid = opp.bpInfoItem.battlePlayerData.uid;
                    }
                }
            }
            catch
            {
            }

            if (string.IsNullOrEmpty(uid))
            {
                uid = manager.focusBattlePlayerData == null ? manager.currentSpectateId : manager.focusBattlePlayerData.uid;
            }

            if (string.IsNullOrEmpty(uid)) return null;
            for (int i = 0; i < status.battlePlayerDatas.Count; i++)
                if (status.battlePlayerDatas[i] != null && status.battlePlayerDatas[i].uid == uid) return uid;
            return null;
        }

        public static void InspectBottomHandZone(out bool hasHandCards, out bool hasCenteredTalents)
        {
            hasHandCards = false;
            hasCenteredTalents = false;
            try
            {
                BattlePanel bp = GetBattlePanel();
                if (bp != null)
                {
                    CardPanel cp = bp.FindILRSubPanel<CardPanel>();
                    if (cp != null)
                    {
                        Transform handContainer = cp.GetHanCardContainer();
                        if (handContainer != null && handContainer.gameObject.activeInHierarchy)
                        {
                            for (int i = 0; i < handContainer.childCount; i++)
                            {
                                Transform child = handContainer.GetChild(i);
                                if (child != null && child.gameObject.activeInHierarchy)
                                {
                                    hasHandCards = true;
                                    break;
                                }
                            }
                        }
                    }

                    if (!hasHandCards)
                    {
                        var oppHand = GameObject.Find("YxOpponentLastHand");
                        if (oppHand != null && oppHand.activeInHierarchy)
                        {
                            hasHandCards = true;
                        }
                    }

                    TalentSelectionPanel tsp = bp.FindILRSubPanel<TalentSelectionPanel>();
                    if (tsp != null && tsp.panel != null && tsp.panel.isShow && tsp.panel.gameObject.activeInHierarchy)
                    {
                        hasCenteredTalents = true;
                    }
                }
            }
            catch
            {
            }
        }

        // Read world corners and convert to the same canvas coordinates as the bet bar.
        public static float BottomHandTop(RectTransform parent)
        {
            float top = 0f;
            BattlePanel bp = GetBattlePanel();
            if (bp == null || parent == null) return top;
            CardPanel cp = bp.FindILRSubPanel<CardPanel>();
            if (cp != null) top = HandTop(cp.GetHanCardContainer(), parent, top);
            GameObject opponent = GameObject.Find("YxOpponentLastHand");
            if (opponent != null) top = HandTop(opponent.transform, parent, top);
            return top;
        }

        static float HandTop(Transform hand, RectTransform parent, float top)
        {
            if (hand == null || !hand.gameObject.activeInHierarchy) return top;
            var corners = new Vector3[4];
            for (int i = 0; i < hand.childCount; i++)
            {
                var child = hand.GetChild(i) as RectTransform;
                if (child == null || !child.gameObject.activeInHierarchy) continue;
                child.GetWorldCorners(corners);
                for (int j = 0; j < 4; j++) top = Mathf.Max(top, parent.InverseTransformPoint(corners[j]).y - parent.rect.yMin);
            }
            return top;
        }

        public static bool IsPlayingBattle()
        {
            var result = BattleApi.IsBattling();
            if (result.Ok) return result.Value;
            BattleManager manager = BattleManager.Instance;
            return manager != null && (int)manager.currentScene == 1;
        }

        static int RemainingSwaps(Proto.GameStatus status, Proto.BattlePlayerData player)
        {
            // 私有数据只按完全一致的UID采用，不能使用游戏扩展方法的“找不到则回退自己”语义。
            if (status.playerPrivateDatas != null)
                for (int i = 0; i < status.playerPrivateDatas.Count; i++)
                {
                    Proto.BattlePlayerPrivateData data = status.playerPrivateDatas[i];
                    if (data != null && data.uid == player.uid && data.replaceCardChance >= 0 && data.replaceCardChance <= 100000) return data.replaceCardChance;
                }
            if (status.playerPrivateData != null && status.playerPrivateData.uid == player.uid
                && status.playerPrivateData.replaceCardChance >= 0 && status.playerPrivateData.replaceCardChance <= 100000) return status.playerPrivateData.replaceCardChance;
            return player.replaceCardChance >= 0 && player.replaceCardChance <= 100000 ? player.replaceCardChance : -1;
        }

        public void Poll()
        {
            BattleManager manager = BattleManager.Instance;
            if (manager == null || SceneLoader.currentSceneName != "Battle")
            {
                if (!string.IsNullOrEmpty(SceneLoader.currentSceneName) && SceneLoader.currentSceneName != "Battle") _mod.ObserveLocation(null);
                _mod.AcceptSnapshot(null, null);
                Waiting("等待观战场景（当前：" + SceneLoader.currentSceneName + "）");
                return;
            }
            OnStatus(manager.currentGameStatus);
        }

        public void OnBattleEnded() { Poll(); }

        public void OnBattleResult(Proto.BattleResult result)
        {
            BattleManager manager = BattleManager.Instance;
            if (manager == null || SceneLoader.currentSceneName != "Battle") return;
            string reason;
            MatchSnapshot snapshot = Read(manager.currentGameStatus, out reason);
            if (snapshot == null || !Matches(result, snapshot)) return;
            TrackMatch(snapshot.Id);
            _resultsThroughRound = Math.Max(_resultsThroughRound, result.round);
            snapshot.ResultsThroughRound = _resultsThroughRound;
            snapshot.TradingOpen = false;
            _mod.AcceptSnapshot(snapshot, null);
        }

        public void OnAllBattleResults(Proto.AllBattleResults results)
        {
            if (results == null || results.battleResults == null) return;
            for (int i = 0; i < results.battleResults.Count; i++) OnBattleResult(results.battleResults[i]);
            BattleManager manager = BattleManager.Instance;
            if (manager == null || SceneLoader.currentSceneName != "Battle") return;
            string reason; MatchSnapshot snapshot = Read(manager.currentGameStatus, out reason);
            if (snapshot == null) return;
            for (int i = 0; i < results.battleResults.Count; i++)
                if (Matches(results.battleResults[i], snapshot)) _completeResultsThroughRound = Math.Max(_completeResultsThroughRound, results.battleResults[i].round);
            OnStatus(manager.currentGameStatus);
        }

        void TrackMatch(string id)
        {
            if (_resultMatchId == id) return;
            _resultMatchId = id; _resultsThroughRound = 0; _completeResultsThroughRound = 0;
        }

        static bool Matches(Proto.BattleResult result, MatchSnapshot snapshot)
        {
            if (result == null || result.round < 1 || result.round > 100000 || result.p1 == null || result.p2 == null
                || result.p1.publicData == null || result.p2.publicData == null) return false;
            bool first = false, second = false;
            for (int i = 0; i < 8; i++)
            {
                if (snapshot.Players[i].Uid == result.p1.publicData.uid) first = true;
                if (snapshot.Players[i].Uid == result.p2.publicData.uid) second = true;
            }
            return first && second;
        }

        public void OnStatus(Proto.GameStatus status)
        {
            string reason;
            MatchSnapshot snapshot = Read(status, out reason);
            if (snapshot == null)
            {
                _mod.AcceptSnapshot(null, null);
                Waiting(reason);
                return;
            }
            _mod.ObserveLocation(snapshot.Id);
            TrackMatch(snapshot.Id);
            BattleManager currentManager = BattleManager.Instance;
            if (currentManager != null)
            {
                Proto.BattleResult one = BattleManager.currentBattleResult;
                if (Matches(one, snapshot) && one.round >= snapshot.Round) _resultsThroughRound = Math.Max(_resultsThroughRound, one.round);
                Proto.AllBattleResults all = currentManager.currentAllBattleResults;
                if (all != null && all.battleResults != null)
                    for (int i = 0; i < all.battleResults.Count; i++)
                        if (Matches(all.battleResults[i], snapshot) && all.battleResults[i].round >= snapshot.Round)
                            _resultsThroughRound = Math.Max(_resultsThroughRound, all.battleResults[i].round);
            }
            snapshot.ResultsThroughRound = _resultsThroughRound;
            snapshot.RoundResultsComplete = _completeResultsThroughRound >= snapshot.Round;
            if (!snapshot.LiveObserver)
            {
                _mod.AcceptSnapshot(snapshot, null); // 已有盘口的结束结果仍可结算。
                if (_mod.PreparationError == null) Waiting(reason);
                return;
            }
            Rating[] ratings = null;
            bool existing = _mod.Book.Find(snapshot.Id) != null;
            if (!existing)
            {
                ratings = _elo.Get(snapshot.Players);
                _mod.SetQueryStatus(_elo.Summary);
                if (ratings != null && _lastDiagnostic != _elo.Summary)
                {
                    _lastDiagnostic = _elo.Summary;
                    _ctx.Log.Info(_elo.Summary);
                }
                if (ratings != null) { _ratingMarketId = snapshot.Id; _marketSummary = _elo.Summary; }
            }
            else
            {
                _mod.SetQueryStatus(_ratingMarketId == snapshot.Id ? _marketSummary : "本局沿用已保存的Elo快照；动态盘口按公开局势更新报价");
            }
            _mod.AcceptSnapshot(snapshot, ratings);
            if (_mod.Current == null && _mod.PreparationError == null && _mod.PreparationBlockedReason == null) _mod.SetStatus(ratings == null ? _elo.Summary : "盘口尚未准备，请等待对局状态同步");
        }

        static MatchSnapshot Read(Proto.GameStatus status, out string reason)
        {
            reason = "等待游戏对局状态";
            if (status == null) return null;
            reason = "等待玩家名单";
            if (status.battlePlayerDatas == null) return null;
            if (status.battlePlayerDatas.Count != 8) { reason = "当前收到 " + PredictionMod.N(status.battlePlayerDatas.Count) + " 名玩家，需要完整八人名单"; return null; }
            if (status.round < 1) { reason = "等待第1轮开始"; return null; }
            var players = new Player[8];
            var ranks = new int[8];
            var states = new PlayerState[8];
            var swaps = new int[8]; var eliminationRounds = new int[8];
            for (int i = 0; i < 8; i++)
            {
                Proto.BattlePlayerData p = status.battlePlayerDatas[i];
                if (p == null) { reason = "玩家信息尚未完整"; return null; }
                if (string.IsNullOrEmpty(p.uid)) { reason = "玩家UID尚未提供，不能查询Elo"; return null; }
                for (int j = 0; j < i; j++) if (players[j].Uid == p.uid) { reason = "玩家UID重复，等待名单同步"; return null; }
                players[i] = new Player(p.uid, p.username, p.isAI);
                ranks[i] = GameRanks.FromProtocol(p.rank);
                // 存活玩家可能携带显示用名次，只把淘汰后的rank当作确定结果。
                states[i] = GameRanks.ReadState(p.life, p.winRoundCount, p.loseRoundCount, p.rank);
                swaps[i] = RemainingSwaps(status, p);
                int completed = p.winRoundCount + p.loseRoundCount;
                if (p.life <= 0 && completed > 0 && completed <= status.round) eliminationRounds[i] = completed;
            }
            string id;
            if (status.codeId > 0) id = "code:" + status.codeId.ToString(CultureInfo.InvariantCulture);
            else
            {
                if (status.beginTs <= 0) { reason = "等待整局ID或开局时间，尚未发起Elo查询"; return null; }
                var ids = new string[8];
                for (int i = 0; i < 8; i++) ids[i] = players[i].Uid;
                for (int i = 1; i < 8; i++)
                {
                    string item = ids[i]; int j = i - 1;
                    while (j >= 0 && string.CompareOrdinal(ids[j], item) > 0) { ids[j + 1] = ids[j]; j--; }
                    ids[j + 1] = item;
                }
                // 稳定的开局时间+完整UID集合；不使用观战目标作为整局ID。
                id = "start:" + status.beginTs.ToString(CultureInfo.InvariantCulture) + ":" + string.Join(",", ids);
            }
            BattleManager manager = BattleManager.Instance;
            bool observer = manager != null && !manager.replaying && status.gameMode != Proto.GameMode.ReviewMode
                && (manager.isSpectating || manager.isRealtimeSpectating || manager.isJudge)
                && !GameStatusExtension.SelfIsPlayer(status);
            reason = manager == null ? "等待观战管理器" : "游戏尚未确认观战状态";
            if (manager != null && (manager.replaying || status.gameMode == Proto.GameMode.ReviewMode)) reason = "当前为历史回放，不能下注";
            else if (GameStatusExtension.SelfIsPlayer(status)) reason = "当前账号在参赛名单中，不能下注";
            var battling = BattleApi.IsBattling();
            bool synchronized = manager != null && manager.currentGameStatus != null && manager.currentGameStatus.round == status.round
                && manager.currentGameStatus.codeId == status.codeId && manager.currentGameStatus.beginTs == status.beginTs;
            bool trading = observer && synchronized && !status.isEnded && (int)manager.currentScene == 0
                && status.timer > 0 && battling.Ok && !battling.Value;
            return new MatchSnapshot
            {
                Id = id, Round = status.round, LiveObserver = observer,
                Ended = status.isEnded, FifthRoundEnded = status.round >= 6,
                Players = players, Ranks = ranks, States = states, TradingOpen = trading, FocusedUid = FocusUid(manager, status), RemainingSwaps = swaps, EliminationRounds = eliminationRounds
            };
        }

        public void Destroy() { _elo.Destroy(); }
    }
}
#endif
