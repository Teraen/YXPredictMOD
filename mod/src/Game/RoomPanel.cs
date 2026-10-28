#if YX_GAME
using System;
using System.Globalization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using Yx.ModSdk;
using Yx.ModSdk.Unity;

namespace YxPrediction
{
    public sealed class RoomPanel
    {
        readonly PredictionMod _mod;
        readonly ModContext _ctx;
        readonly NativeTheme _theme;
        readonly UiKit _ui;
        GameObject _root, _menu, _joinForm, _menuChoices, _createForm;
        NativePanelButton _allowMatchButton, _confirmCreate;
        bool _allowMatch = true;
        string _createTarget;
        string _createError;
        TextMeshProUGUI _menuMessage, _menuTitle;
        NativePanelButton _menuMatch, _menuCreate, _menuJoin;
        float _nextDiscovery;
        readonly LobbyRoomEntry _entry;
        UiInput _code;
        TextMeshProUGUI _status, _message;
        readonly Row[] _rows = new Row[8];
        public readonly RoomSelections Selections = new RoomSelections();
        bool _visible, _connectionMenu;
        string _feedback;
        float _next;
        NativePredictionWindow _classic;
        bool _minimized, _detailed;
        NativePanelButton _minimizeButton;
        bool _showTrend; int _trendPlayer;
        GameObject _trendRoot, _loading;
        TextMeshProUGUI _loadingLabel;
        LifeChart _lifeChart,_shareChart;
        TextMeshProUGUI _trendName;
        public RoomPanel(PredictionMod mod, ModContext ctx, NativeTheme theme)
        { _mod = mod; _ctx = ctx; _theme = theme; _ui = new UiKit(ctx); ctx.Input.RegisterHotkey("onlineRoom", "Ctrl+Shift+P", Toggle); _entry = new LobbyRoomEntry(ctx, theme, Toggle); }
        public void Toggle()
        {
            if (_visible) { Close(); return; }
            if (!PredictionVisibility.CanShow() && !NativeRoomSpectate.IsLobby) return;
            _connectionMenu = false; _visible = true; ShowPresentation(); BackChoices(); if (NativeRoomSpectate.IsLobby) _mod.Online.DiscoverSelected();
        }
        public void Open() { _connectionMenu = false; _visible = true; ShowPresentation(); }
        void Close()
        {
            _visible = false;
            if (_root != null) _root.SetActive(false);
            if (_menu != null) _menu.SetActive(false);
        }
        bool HasCurrentRoom()
        {
            return _mod.Online.State != null && _mod.Snapshot != null && _mod.Online.State.GameId == _mod.Snapshot.Id && PredictionVisibility.CanShow();
        }
        void ShowPresentation()
        {
            bool connected = PredictionVisibility.CanShow() && !_connectionMenu;
            if (connected && _root == null) Build();
            if (!connected && _menu == null) BuildMenu();
            GameObject shown = connected ? _root : _menu;
            bool newlyOpened = shown != null && !shown.activeSelf;
            if (_root != null) _root.SetActive(_visible && connected);
            if (_menu != null) _menu.SetActive(_visible && !connected);
            if (shown != null && _visible && newlyOpened) shown.transform.SetAsLastSibling();
        }
        void BuildMenu()
        {
            _menu = _ui.Panel("PredictionRoomMenu", new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(580f, 230f), NativeTheme.LacquerBlack);
            if (_menu == null) return;
            _theme.ApplyWindowFrame(_menu.GetComponent<Image>());
            _theme.DecorateWindow(_menu, "名次预测");
            var title = _ui.Label(_menu.transform, "title", "名次预测", new Vector2(24f, -14f), new Vector2(400f, 36f), 24);
            _menuTitle = title;
            _theme.ApplyTextStyle(title, 24, true, TextAlignmentOptions.Left);
            _theme.CreateButtonTopLeft(_menu.transform, "closeMenu", "×", 518f, -12f, 42f, 38f, NativePanelButtonStyle.Close, Close, 24);
            _menuChoices = new GameObject("Choices", typeof(RectTransform));
            _menuChoices.transform.SetParent(_menu.transform, false);
            NativeTheme.SetTopLeft(_menuChoices.transform as RectTransform, 0f, -66f, 580f, 70f);
            _menuJoin = _theme.CreateButtonTopLeft(_menuChoices.transform, "menuJoin", "加入", 24f, 0f, 164f, 60f, NativePanelButtonStyle.Primary, JoinCurrent, 24);
            _menuCreate = _theme.CreateButtonTopLeft(_menuChoices.transform, "menuCreate", "创建", 208f, 0f, 164f, 60f, NativePanelButtonStyle.Primary, Create, 24);
            _menuMatch = _theme.CreateButtonTopLeft(_menuChoices.transform, "menuMatch", "匹配", 392f, 0f, 164f, 60f, NativePanelButtonStyle.Primary, RandomJoin, 24);
            _joinForm = new GameObject("JoinForm", typeof(RectTransform));
            _joinForm.transform.SetParent(_menu.transform, false);
            NativeTheme.SetTopLeft(_joinForm.transform as RectTransform, 0f, -66f, 580f, 74f);
            _code = _ui.NumberInput(_joinForm.transform, "roomCode", new Vector2(24f, 0f), new Vector2(204f, 54f), 24, Ignore);
            _theme.CreateButtonTopLeft(_joinForm.transform, "joinCode", "加入房间", 248f, 0f, 164f, 54f, NativePanelButtonStyle.Primary, Join, 22);
            _theme.CreateButtonTopLeft(_joinForm.transform, "backChoices", "返回", 432f, 0f, 124f, 54f, NativePanelButtonStyle.Secondary, BackChoices, 22);
            _joinForm.SetActive(false);
            _createForm = new GameObject("CreateSettings", typeof(RectTransform));
            _createForm.transform.SetParent(_menu.transform, false);
            NativeTheme.SetTopLeft(_createForm.transform as RectTransform, 0f, -66f, 580f, 74f);
            _allowMatchButton = _theme.CreateButtonTopLeft(_createForm.transform, "allowMatch", "匹配：开启", 24f, 0f, 176f, 54f, NativePanelButtonStyle.Secondary, ToggleMatching, 22);
            _confirmCreate = _theme.CreateButtonTopLeft(_createForm.transform, "confirmCreate", "创建并观战", 216f, 0f, 188f, 54f, NativePanelButtonStyle.Primary, ConfirmCreate, 22);
            _theme.CreateButtonTopLeft(_createForm.transform, "backCreate", "返回", 420f, 0f, 136f, 54f, NativePanelButtonStyle.Secondary, BackChoices, 22);
            _createForm.SetActive(false);
            _menuMessage = _ui.Label(_menu.transform, "menuMessage", "", new Vector2(24f, -150f), new Vector2(532f, 62f), 18);
            _theme.ApplyTextStyle(_menuMessage, 18, false, TextAlignmentOptions.Left); _menuMessage.enableWordWrapping = true;
        }
        void ShowConnectionMenu() { if (_menu == null) BuildMenu(); _connectionMenu = true; if (_root != null) _root.SetActive(false); ShowJoin(); if (_menu != null) _menu.SetActive(true); }
        void JoinCurrent() { if (NativeRoomSpectate.IsLobby) _mod.Online.JoinSelected(); else ShowJoin(); }
        void ShowJoin() { if (_menuTitle != null) _menuTitle.text = "加入房间"; if (_joinForm != null) _joinForm.SetActive(true); if (_createForm != null) _createForm.SetActive(false); if (_menuChoices != null) _menuChoices.SetActive(false); }
        void BackChoices() { _connectionMenu = false; if (_menuTitle != null) _menuTitle.text = "名次预测"; if (_joinForm != null) _joinForm.SetActive(false); if (_createForm != null) _createForm.SetActive(false); if (_menuChoices != null) _menuChoices.SetActive(true); }
        void Build()
        {
            _classic=new NativePredictionWindow(_ctx,_theme,"名次预测总览");
            _root=_classic.Root; if(_root==null)return;
            _status=_classic.Status;_message=_classic.Footer;
            Transform banner=_classic.Banner.transform;
            _theme.CreateButtonTopLeft(banner,"details","走势图",496f,-11f,82f,32f,NativePanelButtonStyle.Secondary,ToggleTrend,16);
            _theme.CreateButtonTopLeft(banner,"horses","顶栏马牌",590f,-11f,104f,32f,NativePanelButtonStyle.Secondary,ToggleHorses,16);
            _minimizeButton=_theme.CreateButtonTopLeft(banner,"minimize","折起",700f,-11f,66f,32f,NativePanelButtonStyle.Secondary,ToggleMinimize,16);
            _theme.CreateButtonTopLeft(banner,"roomOptions","房间",772f,-11f,90f,32f,NativePanelButtonStyle.Secondary,ShowConnectionMenu,16);
            _theme.CreateButtonTopLeft(banner,"leave","离开",868f,-11f,66f,32f,NativePanelButtonStyle.Secondary,Leave,16);
            _theme.CreateButtonTopLeft(banner,"close","×",940f,-11f,54f,32f,NativePanelButtonStyle.Close,Close,22);
            for(int i=0;i<8;i++)_rows[i]=new Row(this,i);
            _trendRoot=_ui.Row(_classic.Body.transform,"TrendTab",Vector2.zero,new Vector2(1116f,510f),Color.clear);_trendRoot.GetComponent<Image>().raycastTarget=false;
            _theme.CreateButtonTopLeft(_trendRoot.transform,"prevPlayer","上一人",14f,-4f,110f,34f,NativePanelButtonStyle.Secondary,PrevTrend,18);
            _trendName=_ui.Label(_trendRoot.transform,"trendPlayer","",new Vector2(140f,-4f),new Vector2(300f,34f),20);
            _theme.CreateButtonTopLeft(_trendRoot.transform,"nextPlayer","下一人",450f,-4f,110f,34f,NativePanelButtonStyle.Secondary,NextTrend,18);
            _lifeChart=new LifeChart(_ui,_trendRoot.transform,TrendChartData.LifeMetric,10f,-50f,538f,440f,_theme);
            _shareChart=new LifeChart(_ui,_trendRoot.transform,TrendChartData.ShareMetric,568f,-50f,538f,440f,_theme);
            _trendRoot.SetActive(false);
            _loading=_ui.Row(_classic.Body.transform,"LoadingNotice",new Vector2(12f,-48f),new Vector2(1092f,420f),new Color(0.06f,0.08f,0.10f,0.99f));
            _loading.GetComponent<Image>().raycastTarget=false;
            _loadingLabel=_ui.Label(_loading.transform,"LoadingText","数据加载中…",new Vector2(40f,-110f),new Vector2(1012f,180f),24);
            _theme.ApplyTextStyle(_loadingLabel,24,false,TextAlignmentOptions.Center);_loadingLabel.enableWordWrapping=true;
            _loading.SetActive(false);
        }
        void ToggleTrend(){_showTrend=!_showTrend;_classic.Table.SetActive(!_showTrend);_trendRoot.SetActive(_showTrend);}
        void PrevTrend(){_trendPlayer=(_trendPlayer+7)%8;}
        void NextTrend(){_trendPlayer=(_trendPlayer+1)%8;}
        void ToggleDetails(){_detailed=!_detailed;}
        void ToggleHorses(){_mod.Horses.Toggle();}
        void ToggleMinimize(){_minimized=!_minimized;_classic.SetMinimized(_minimized);_minimizeButton.SetText(_minimized?"展开":"折起");}
        TextMeshProUGUI Label(string name, string value, float x, float y, float w, float h, int size)
        {
            var label = _ui.Label(_root.transform, name, value, new Vector2(x,y), new Vector2(w,h), size);
            _theme.ApplyTextStyle(label,size,false,TextAlignmentOptions.Left); if (name.StartsWith("header")) label.color=NativeTheme.AntiqueGold; label.text = value; label.raycastTarget = false; return label;
        }
        static void Ignore(string value) { }
        void Create()
        {
            _createError = null;
            _menuTitle.text = "创建房间设置";
            _createTarget = null;
            if (NativeRoomSpectate.IsLobby) LobbyRoomEntry.SelectedButton(out _createTarget);
            if (_joinForm != null) _joinForm.SetActive(false);
            _menuChoices.SetActive(false); _createForm.SetActive(true);
            _confirmCreate.SetText(NativeRoomSpectate.IsLobby ? "创建并观战" : "创建房间");
        }
        void ToggleMatching() { _createError = null; _allowMatch = !_allowMatch; _allowMatchButton.SetText(_allowMatch ? "匹配：开启" : "匹配：关闭"); }
        void ConfirmCreate() { if (_mod.Online.Create(_allowMatch, _createTarget)) Close(); else _createError = _mod.Online.Message; }
        void Join() { _mod.Online.Connect(_code.Text, false); }
        void RandomJoin() { if (_mod.Online.Matching) _mod.Online.CancelMatch(); else _mod.Online.RandomJoin(); }
        void CancelMatch() { _mod.Online.CancelMatch(); }
        void Leave() { _mod.Online.Leave(); }
        public void Update()
        {
            bool lobby = NativeRoomSpectate.IsLobby;
            _entry.Update();
            if ((!PredictionVisibility.CanShow() && !lobby) || (!lobby && GameBridge.IsPlayingBattle()) || (lobby && !_entry.Visible)) { Close(); return; }
            if (!_visible) return;
            ShowPresentation();
            bool connected = PredictionVisibility.CanShow() && !_connectionMenu;
            GameObject shown = connected ? _root : _menu;
            if (shown == null) return;
            var rect = shown.transform as RectTransform; var parent = rect.parent as RectTransform;
            float scale = Mathf.Max(0.1f, Mathf.Min(1.2f, Mathf.Min((parent.rect.width - 32f) / rect.rect.width, (parent.rect.height - 180f) / rect.rect.height)));
            rect.localScale = new Vector3(scale,scale,1);
            rect.anchoredPosition = Vector2.zero;
            if (!connected)
            {
                if (lobby && Time.unscaledTime >= _nextDiscovery && !_mod.Online.Busy) { _nextDiscovery=Time.unscaledTime+3f; _mod.Online.DiscoverSelected(); }
                string native; LobbyRoomEntry.SelectedButton(out native);
                bool known = !lobby || (_mod.Online.DiscoveryReady && _mod.Online.DiscoveredNative == native);
                bool exists = lobby && known && !string.IsNullOrEmpty(_mod.Online.DiscoveredCode);
                if (_menuCreate != null) { _menuCreate.SetActive(!exists); _menuCreate.SetInteractable(known && !_mod.Online.Busy); }
                if (_menuJoin != null) _menuJoin.SetInteractable(known && (!lobby || (exists && _mod.Online.DiscoveredAvailable)) && !_mod.Online.Busy);
                bool settings = _createForm != null && _createForm.activeSelf;
                if (_confirmCreate != null) _confirmCreate.SetInteractable(known && !exists && !_mod.Online.Busy && (!lobby || native == _createTarget));
                if (_menuMessage != null) _menuMessage.text = settings
                    ? (_createError ?? (lobby && native != _createTarget ? "所选对局已变更，请返回后重新创建" : exists ? "本局已有房间，请返回并加入" : _allowMatch ? "允许其他观众随机匹配进入；确认后直接观战。" : "仅通过本局加入或房间号进入，不参与随机匹配。"))
                    : !known ? "查询所选对局…" : exists ? "本局已有预测房间，点击加入即可观战" : _mod.Online.Message;
                if (_menuMatch != null) _menuMatch.SetText(_mod.Online.Matching ? "取消" : "匹配");
                return;
            }
            if (Time.unscaledTime < _next) return; _next = Time.unscaledTime + 0.2f;
            RoomState r = CurrentView();
            bool loading=r==null;
            string blocked=_mod.PreparationError??_mod.PreparationBlockedReason;
            if(_loading!=null){_loading.SetActive(loading&&!_minimized);if(loading){_loading.transform.SetAsLastSibling();_loadingLabel.text=(blocked==null?"数据加载中…":"暂时无法开盘")+((char)10).ToString()+(blocked??_mod.QueryStatus??_mod.Message??"等待八人观战数据");}}
            _status.text = r == null ? (blocked==null?"Elo / 对局数据加载中…":"开盘受阻，请查看下方原因")
                : "房间 " + r.Code + " · " + PredictionMod.N(r.Members) + " 人 · 第 " + PredictionMod.N(r.Round) + " 轮 · "
                + (r.Forfeited ? "离场已放弃" : r.Settled ? "已结算" : r.TradingClosed ? "已封盘" : r.Open ? "交易开放" : "交易暂停") + " · 余额 " + PredictionMod.N(r.Balance) + " 分" + (r.Host ? " · 你是房主" : "");
            if (HasCurrentRoom())
            {
                string members = "成员：";
                RoomState room = _mod.Online.State;
                for (int i=0;i<room.MemberNames.Length;i++) members += (i>0?"、":"") + room.MemberNames[i] + "（" + (string.IsNullOrEmpty(room.MemberUids[i]) ? room.MemberIds[i] : room.MemberUids[i]) + "）";
                _message.text = _feedback ?? _mod.Online.JoinNotice ?? ((room.AllowMatch ? "匹配开 · " : "匹配关 · ") + (room.Rules==2?"基础倍率×投注系数（下轮生效），同出区间全中，单出差一名返25% · "+members:"旧资金池房间 · "+members));
            }
            else _message.text = _feedback ?? blocked ?? (loading ? (_mod.QueryStatus ?? _mod.Message ?? "加载中…") : "");
            for (int i = 0; i < 8; i++) _rows[i].Refresh(r);
            if (r != null)
            {
                int[] order = RoomSelections.DisplayOrder(r);
                for (int i = 0; i < 8; i++) _rows[order[i]].SetSlot(i);
            }
            if(_showTrend && _mod.Current==null){_trendName.text=blocked==null?"数据加载中…":"开盘受阻";_lifeChart.ShowWaiting("加载中…");_shareChart.ShowWaiting("加载中…");}
            if(_showTrend && _mod.Current!=null){_trendName.text=_mod.Current.Players[_trendPlayer].Name;_lifeChart.Refresh(_mod.Current,_trendPlayer);_shareChart.Refresh(_mod.Current,_trendPlayer);}
        }
        public void SetFeedback(string message) { _feedback = message; }
        public RoomState CurrentView()
        {
            if (HasCurrentRoom()) { Selections.Observe(_mod.Online.State); return _mod.Online.State; }
            Market m = _mod.Current; if (m == null) { Selections.Observe(null); return null; }
            var r = new RoomState(); r.Rules = 2; r.Forfeited = m.Abandoned; r.TradingClosed = m.Locked; r.Code = "单人"; r.GameId = m.Id; r.Round = m.HighestRound;
            r.BaseRates=m.BaseRates;r.QuoteRates=m.QuoteRates;for(int j=0;j<64;j++)r.Factors[j]=10000;
            r.Open = m.TradingWindowOpen; r.Settled = m.Settled; r.Balance = _mod.Book.Balance; r.Members = 1;
            for (int i = 0; i < 8; i++) { r.Uids[i] = m.Players[i].Uid; r.Names[i] = m.Players[i].Name; r.Ranks[i] = m.KnownRanks[i]; r.RankMinimum[i] = m.RankMinimum[i]; r.RankMaximum[i] = m.RankMaximum[i]; r.MyRanks[i] = m.Positions[i].Rank; r.Stakes[i] = m.Positions[i].Claim;r.Claims[i]=m.Positions[i].Claim;r.FinalPayouts[i]=m.Positions[i].FinalPayout; }
            Selections.Observe(r); return r;
        }
        public void Submit(int player, int rank, long amount, int action)
        {
            RoomState r = CurrentView(); if (r == null) return; _feedback = null;
            if (HasCurrentRoom())
            {
                string kind = action == 1 ? "half" : action == 2 ? "sell" : r.Stakes[player] > 0 && r.MyRanks[player] != rank ? "switch" : "buy";
                _mod.Online.Trade(kind, player, rank, amount);
            }
            else
            {
                Market m = _mod.Current;
                int kind = action == 0 && m.Positions[player].Claim > 0 && m.Positions[player].Rank != rank ? 3 : action;
                _feedback = _mod.Trade(kind, m.Players[player].Uid, rank, amount, m.TradeVersion, null, m.Id);
            }
        }
        sealed class Row
        {
            readonly RoomPanel _panel;
            readonly NativePredictionRow _nativeRow;
            readonly int _index;
            readonly TextMeshProUGUI _rank, _playerName, _playerLife, _horseTitle, _oddsLabel, _holdingLabel, _resultLabel;
            readonly GameObject _rowGo;
            readonly RectTransform _rowRect;
            readonly Image _selfFlag, _horseIcon, _dividerLine;
            readonly NativePanelButton _btnMinus, _btnPlus;
            readonly UiInput _stake;
            readonly NativePanelButton _buy, _half, _sell;
            int _chosen;
            string _identity;
            public Row(RoomPanel panel, int index)
            {
                _panel=panel;_index=index;
                var row=new NativePredictionRow(panel._ctx,panel._theme,panel._classic.Table.transform,index,Minus,Plus,Buy,Half,Sell);
                _nativeRow = row;
                _rowGo=row.Root;_rowRect=row.Rect;_selfFlag=row.Highlight;_horseIcon=row.Badge;_dividerLine=row.Divider;
                _playerName=row.PlayerName;_playerLife=row.PlayerDetail;_horseTitle=row.BadgeText;_rank=row.Rank;_oddsLabel=row.Rate;_holdingLabel=row.Holding;_resultLabel=row.Result;
                _btnMinus=row.Minus;_btnPlus=row.Plus;_stake=row.Stake;_buy=row.Buy;_half=row.Half;_sell=row.Sell;
            }
            public void SetSlot(int slot) { _nativeRow.SetSlot(slot); }
            bool Valid(RoomState r) { return r != null && _identity == r.Code + ":" + r.GameId + ":" + r.Uids[_index]; }
            void Step(bool forward)
            {
                RoomState r = _panel.CurrentView(); if (!Valid(r)) return;
                _panel.Selections.Step(r.Uids[_index], forward); _chosen = _panel.Selections.Selected(r.Uids[_index]);
            }
            void Minus() { Step(false); }
            void Plus() { Step(true); }
            void Buy()
            {
                RoomState r = _panel.CurrentView(); if (r == null || _identity != r.Code + ":" + r.GameId + ":" + r.Uids[_index]) return;
                _chosen = _panel.Selections.Selected(r.Uids[_index]);
                if (_chosen < 1 || _chosen > 8) return;
                long amount;
                if (!long.TryParse(_stake.Text, NumberStyles.None, CultureInfo.InvariantCulture, out amount) || amount < 1 || amount > 10000) { _panel._feedback = "投入须为1至10000整数"; return; }
                string kind = r.Stakes[_index] > 0 && r.MyRanks[_index] != _chosen ? "switch" : "buy";
                _panel.Submit(_index,_chosen,amount,0);
            }
            void Half() { if (Valid(_panel.CurrentView())) _panel.Submit(_index,0,0,1); }
            void Sell() { if (Valid(_panel.CurrentView())) _panel.Submit(_index,0,0,2); }
            public void Refresh(RoomState r)
            {
                string identity = r == null ? null : r.Code + ":" + r.GameId + ":" + r.Uids[_index];
                if (_identity != identity) { _identity = identity; _stake.SetText("10"); }
                _chosen = r == null ? 0 : _panel.Selections.Selected(r.Uids[_index]);
                _rank.text = _chosen > 0 ? "第" + PredictionMod.N(_chosen) + "名" : "—";
                bool valid = r != null && _panel._mod.Snapshot != null && r.GameId == _panel._mod.Snapshot.Id;
                bool open = valid && r.Open && !r.Settled && (!_panel.HasCurrentRoom() || !_panel._mod.Online.Busy) && r.Ranks[_index] == 0;
                _buy.SetInteractable(open && _chosen > 0); _half.SetInteractable(open && r.Stakes[_index] > 0); _sell.SetInteractable(open && r.Stakes[_index] > 0);
                _playerName.text = r == null ? "—" : r.Names[_index];
                if (r != null)
                {
                    MatchSnapshot snapshot=_panel._mod.Snapshot; PlayerState state=null;
                    if(snapshot!=null) for(int i=0;i<snapshot.Players.Length;i++) if(snapshot.Players[i].Uid==r.Uids[_index] && snapshot.States!=null) state=snapshot.States[i];
                    _playerLife.text=state==null?"":"命元 "+PredictionMod.N(state.Life)+" · "+PredictionMod.N(state.Wins)+"胜"+PredictionMod.N(state.Losses)+"负";
                    _selfFlag.gameObject.SetActive(snapshot!=null&&FocusSelection.Uid(snapshot)==r.Uids[_index]);
                    HorseMember horse=_panel._mod.Horses.FindMember(r.Uids[_index]);
                    _horseTitle.text=horse==null?"":horse.Caption;
                    if(_panel._detailed && horse!=null && horse.Profile!=null && horse.Profile.Rating.Found) { _horseTitle.enableWordWrapping=true; _horseTitle.text += ((char)10).ToString()+"Elo "+PredictionMod.N((long)horse.Profile.Rating.Score); } else _horseTitle.enableWordWrapping=false;
                    if(horse!=null) _horseTitle.color=TianJiFeature.ColorOf(horse.Title);
                    _horseIcon.sprite=horse==null?null:_panel._mod.Horses.GetSprite(horse.IconTitle);
                    _horseIcon.gameObject.SetActive(_horseIcon.sprite!=null);
                }
                if (r == null) { _holdingLabel.text = "未连接"; return; }
                long total = 0; for (int j = 0; j < 8; j++) total += r.Pools[_index * 8 + j];
                long selected = _chosen > 0 ? r.Pools[_index * 8 + _chosen - 1] : 0;
                int quoteAt=_index*8+Math.Max(1,_chosen)-1;
                string rate=_chosen==0?"—":!_panel.HasCurrentRoom()||r.Rules==2?PredictionMod.Rate(r.QuoteRates[quoteAt]):selected>0?(total/(double)selected).ToString("0.00",CultureInfo.InvariantCulture)+"x":"暂无投入";
                _oddsLabel.text=rate=="暂无投入"?"—":rate;
                _holdingLabel.text=r.Forfeited && r.Ranks[_index]==0 ? "离场已放弃" : r.Stakes[_index]>0?"猜"+PredictionMod.N(r.MyRanks[_index])+"名 · 权益 "+PredictionMod.N(_panel.HasCurrentRoom()&&r.Rules==2?r.Claims[_index]:r.Stakes[_index])+"分":"未持仓";
                _resultLabel.text=r.Forfeited && r.Ranks[_index]==0 ? "不退本金，不再返奖" : r.Ranks[_index]>0?r.ResultPlace(_index)+" · 返还 "+PredictionMod.N(r.FinalPayouts[_index])+"分":_panel.HasCurrentRoom()&&r.Rules==2&&_chosen>0?"基础 "+PredictionMod.Rate(r.BaseRates[quoteAt])+" × "+(r.Factors[quoteAt]/10000.0).ToString("0.00",CultureInfo.InvariantCulture):"";
                _half.SetActive(r.Stakes[_index]>0);_sell.SetActive(r.Stakes[_index]>0);
                _buy.SetText(r.Stakes[_index] > 0 ? r.MyRanks[_index] == _chosen ? "增持" : "换预测" : "投入");
            }
        }
        public void KeepBarAbove(Transform bar) { if (_visible && _root != null && _root.activeInHierarchy && bar != null && _root.transform.GetSiblingIndex() == bar.parent.childCount - 1) bar.SetAsLastSibling(); }
        public void Destroy() { _entry.Destroy(); if(_classic!=null)_classic.Destroy(); _ui.DestroyAll(); _root = null; _menu = null; }
    }
}
#endif
