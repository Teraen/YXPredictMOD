using System;
using System.Collections.Generic;
using System.Globalization;
using Yx.ModSdk;

namespace YxPrediction
{
    public sealed class PredictionMod : YxMod
    {
        public const string SaveKey = "predictionBook.v1";
        public PredictionBook Book { get; private set; }
        public MatchSnapshot Snapshot { get; private set; }
        public string Message { get; private set; }
        public string QueryStatus { get; private set; }
        public string PreparationError { get; private set; }
        public string PreparationBlockedReason { get; private set; }
        public readonly RankSelection Drafts = new RankSelection();
        public readonly ReliefNotice ReliefNotices = new ReliefNotice();
        string _lastPreparationError;
        ConfigEntry<bool> _enabled;
#if YX_GAME
        public RoomClient Online { get; private set; }
        public RoomPanel OnlinePanel { get; private set; }
        GameBridge _bridge;
        NativeTheme _theme;
        ReliefPopup _reliefPopup;
        PanelLayout _layout;
        CharacterBetBar _betBar;
        TalentOrbit _talents;
        public TianJiFeature Horses { get; private set; }
#endif

        public Market Current { get { return Snapshot == null || Book == null ? null : Book.Find(Snapshot.Id); } }
        public bool Enabled { get { return _enabled != null && _enabled.Value; } }

        public override void OnLoad(ModContext ctx)
        {
            _enabled = ctx.Config.Bind("prediction", "enabled", true, "允许积分预测；关闭后仍会结算已有投注");
            var initial = ctx.Config.Bind("prediction", "startingPoints", 1000, "仅首次创建存档使用，之后不会重置余额");
            if (ctx.Data.Has(SaveKey)) Book = BookCodec.Read(ctx.Data.Get<Dictionary<string, object>>(SaveKey, null));
            else Book = new PredictionBook(Math.Max(0, Math.Min(1000000, initial.Value)));
            Save();
            Message = "进入八人观战后自动准备赔率；可在底部角色条下注或点击其中的「总览」";
#if YX_GAME
            _theme = new NativeTheme(ctx);
            _reliefPopup = new ReliefPopup(ctx, _theme, ReliefNotices);
            Online = new RoomClient(this, ctx);
            OnlinePanel = new RoomPanel(this, ctx, _theme);
            var savedWin = ctx.Data.Get<Dictionary<string, object>>(PanelLayout.WindowSaveKey, null);
            var savedBar = ctx.Data.Get<Dictionary<string, object>>(PanelLayout.BetBarSaveKey, null);
            _layout = new PanelLayout(savedWin, savedBar);

            _bridge = new GameBridge(this, ctx);
            Horses = new TianJiFeature(this, ctx, _bridge);
            _betBar = new CharacterBetBar(this, ctx, _theme);
            _talents = new TalentOrbit(ctx);

            ctx.Events.OnNetIn<Proto.GameStatus>(_bridge.OnStatus);
            ctx.Events.OnBattleEnded(_bridge.OnBattleEnded);
            ctx.Events.OnNetIn<Proto.BattleResult>(_bridge.OnBattleResult);
            ctx.Events.OnNetIn<Proto.AllBattleResults>(_bridge.OnAllBattleResults);
#endif
            ctx.Log.Info("观战预测已加载：本地积分模式，原生UI融合，认证时长接口未接入");
        }

        public override void OnUpdate()
        {
            if (Book != null && Book.CanGrantBankruptcyRelief) Save();
#if YX_GAME
            if (_bridge != null) _bridge.Update();
            _theme.RefreshSource();
            if (Online != null) Online.Update();
            if (OnlinePanel != null) OnlinePanel.Update();
            if (Horses != null) Horses.Update();
            if (_betBar != null) _betBar.Update();
            if (_talents != null) _talents.Update();
            if (_reliefPopup != null) _reliefPopup.Update();
#endif
        }

        public override void OnDisable()
        {
#if YX_GAME
            if (_bridge != null) _bridge.Destroy();
            if (Online != null) Online.Destroy();
            if (OnlinePanel != null) OnlinePanel.Destroy();
            if (_betBar != null) _betBar.Destroy();
            if (_talents != null) _talents.Destroy();
            if (Horses != null) Horses.Destroy();
            if (_reliefPopup != null) _reliefPopup.Destroy();
#endif
        }

        public void SetStatus(string message) { Message = message; }
        public void SetQueryStatus(string message) { QueryStatus = message; }
        public void SetFocusedUid(string uid) { if (Snapshot != null) Snapshot.FocusedUid = uid; }

        public void ObserveLocation(string activeId)
        {
            bool pending = false;
            for (int i = 0; i < Book.Markets.Count; i++)
                if (Book.Markets[i].Id != activeId && PredictionBook.HasPendingBets(Book.Markets[i])) pending = true;
            if (pending)
            {
                var backup = BookCodec.Write(Book);
                try { if (Book.AbandonExcept(activeId) > 0) Save(); }
                catch { Book = BookCodec.Read(backup); throw; }
            }
#if YX_GAME
            if (Online != null) Online.ObserveLocation(activeId);
#endif
        }

        public void AcceptSnapshot(MatchSnapshot snapshot, Rating[] ratings)
        {
            bool switched = Snapshot == null || snapshot == null || Snapshot.Id != snapshot.Id;
            Snapshot = snapshot;
#if YX_GAME
            if (Online != null) Online.CaptureFinalSnapshot(snapshot);
#endif
            PreparationBlockedReason = null;
            if (switched) { PreparationError = null; _lastPreparationError = null; }
            if (snapshot == null) return;
            var backup = BookCodec.Write(Book);
            int revision = Book.Revision;
            Market previous = Book.Find(snapshot.Id);
            bool wasOpen = previous != null && previous.TradingWindowOpen;
            string previousWait = previous == null ? null : previous.TradingWaitReason;
            try
            {
                Market m = Book.Observe(snapshot, ratings);
                Drafts.Observe(m);
                if (revision != Book.Revision) Save();
                if (m == null)
                {
                    if (snapshot.LiveObserver && snapshot.IsEightPlayerMatch() && ratings != null
                        && Book.Find(snapshot.Id) == null && !Book.HasNewMarketCapacity)
                    {
                        PreparationBlockedReason = "无法开盘：12局已有投注记录尚未结算，积分与持仓已保留";
                        Message = PreparationBlockedReason;
                    }
                    return;
                }
                PreparationError = null;
                _lastPreparationError = null;
                if (revision == Book.Revision && !switched && wasOpen == m.TradingWindowOpen && previousWait == m.TradingWaitReason) return;
                if (m.Settled) Message = "本局已结算，返还 " + N(m.TotalPayout) + " 积分（含中奖本金）";
                else if (m.IsTrading) Message = m.TradingWindowOpen ? "交易开放：可增持、减半、清仓或换预测；差1名返正中总额25%" : m.TradingWaitReason;
                else if (m.Locked) Message = "已封盘，等待整局结束及八人的最终名次";
                else Message = m.HasAdjacentReward ? "每人独立下注；差1名返正中总额25%；第5轮结束封盘" : "旧盘口仅正中返还；每人独立下注；第5轮结束封盘";
            }
            catch (Exception ex)
            {
                Book = BookCodec.Read(backup);
                PreparationError = "盘口更新失败：" + ex.Message;
                Message = PreparationError;
                if (_lastPreparationError != PreparationError)
                {
                    _lastPreparationError = PreparationError;
                    Context.Log.Error(PreparationError, ex);
                }
            }
        }

        public string PlaceBet(string uid, int rank, long stake, string expectedFocusUid = null, string expectedMarketId = null)
        {
#if YX_GAME
            if (_bridge != null) _bridge.Poll(); // 点击时重新检查游戏状态。
            if (!PredictionVisibility.CanShow()) return Report("仅限实时观战，参赛或回放时不可下注");
#endif
            if (expectedFocusUid != null && (expectedFocusUid != uid || FocusSelection.Uid(Snapshot) != expectedFocusUid)) return Report("观战对象已切换，请查看当前玩家后再操作");
            if (expectedMarketId != null && (Snapshot == null || Snapshot.Id != expectedMarketId)) return Report("观战对局已切换，请查看当前对局后再操作");
            if (!Enabled) return Report("积分预测已关闭");
            var backup = BookCodec.Write(Book);
            int revision = Book.Revision;
            try
            {
                string error = Book.Bet(Snapshot, uid, rank, stake);
                if (revision != Book.Revision) Save();
                return Report(error ?? "下注成功，已扣除 " + N(stake) + " 积分");
            }
            catch
            {
                Book = BookCodec.Read(backup);
                throw;
            }
        }

        // 0买入/增持，1减半，2清仓，3出售后换预测。版本绑定用户刚看到的报价和持仓。
        public string Trade(int action, string uid, int rank, long stake, int version, string expectedFocusUid = null, string expectedMarketId = null)
        {
#if YX_GAME
            if (_bridge != null) _bridge.Poll();
            if (!PredictionVisibility.CanShow()) return Report("仅限实时观战，参赛或回放时不可调仓");
#endif
            if (expectedFocusUid != null && (expectedFocusUid != uid || FocusSelection.Uid(Snapshot) != expectedFocusUid)) return Report("观战对象已切换，请查看当前玩家后再操作");
            if (expectedMarketId != null && (Snapshot == null || Snapshot.Id != expectedMarketId)) return Report("观战对局已切换，请查看当前对局后再操作");
            if (PreparationError != null) return Report(PreparationError);
            if ((action == 0 || action == 3) && !Enabled) return Report("积分预测已关闭，仍可减持或清仓已有持仓");
            var backup = BookCodec.Write(Book);
            int revision = Book.Revision;
            long before = Book.Balance;
            try
            {
                string error;
                if (action == 0) error = Book.Buy(Snapshot, uid, rank, stake, version);
                else if (action == 1 || action == 2) error = Book.Sell(Snapshot, uid, action == 1, version);
                else if (action == 3) error = Book.Switch(Snapshot, uid, rank, stake, version);
                else error = "未知交易操作";
                bool relief = revision != Book.Revision && Save();
                long delta = Book.Balance - before;
                if (relief) delta -= PredictionBook.ReliefAmount;
                return Report(error ?? "操作成功，余额变动 " + (delta >= 0 ? "+" : "") + N(delta) + " 分");
            }
            catch (Exception ex)
            {
                Book = BookCodec.Read(backup);
                Context.Log.Error("调仓失败，已恢复操作前存档", ex);
                return Report("调仓未完成：" + ex.Message);
            }
        }

        public void NotifyRelief(long amount) { ReliefNotices.Notify(amount); }
        string Report(string message) { Message = message; return message; }
        bool Save()
        {
            bool relief = Book.GrantBankruptcyRelief();
            Context.Data.Set(SaveKey, BookCodec.Write(Book));
            if (relief)
            {
                Context.Log.Info("无未结算投注且余额低于10分，自动发放50分救济金；当前余额 " + N(Book.Balance));
                NotifyRelief(PredictionBook.ReliefAmount);
            }
            return relief;
        }
        public static string N(long value) { return value.ToString(CultureInfo.InvariantCulture); }
        public static string Rate(int bps) { return (bps / 10000.0).ToString("0.00", CultureInfo.InvariantCulture) + "x"; }
        public static string Percent(double share) { return (share * 100).ToString("0.00", CultureInfo.InvariantCulture) + "%"; }
    }
}
