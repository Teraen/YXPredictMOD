#if YX_GAME
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using Yx.ModSdk;
using Yx.Shared;

namespace YxPrediction
{
    // UnityWebRequest completion is polled on the Unity main thread. No async or CLR callback queues.
    public sealed class RoomClient
    {
        readonly PredictionMod _mod;
        readonly ModContext _ctx;
        readonly ConfigEntry<string> _url, _name;
        UnityWebRequest _request;
        Dictionary<string, object> _sent, _pending;
        string _endpoint, _token, _code, _afterRegister;
        readonly RoomFinalSync _finals;
        RoomDepartureSync _departures;
        RoomDepartureSync.Entry _departureRequest;
        int _departureCursor;
        float _departureNext;
        bool _locationKnown;
        string _activeGameId;
        RoomFinalSync.Entry _finalRequest;
        int _finalCursor;
        float _next, _finalNext;
        long _reliefSeen;
        RoomMatch _match;
        string _membersRoom;
        readonly List<string> _seenMembers = new List<string>();
        public string JoinNotice { get; private set; }
        float _noticeUntil;
        string _createNativeId, _lookupCode;
        float _createDeadline;
        bool _allowMatch = true;
        string _discoverNative;
        public string DiscoveredNative { get; private set; }
        public string DiscoveredCode { get; private set; }
        public bool DiscoveryReady { get; private set; }
        public bool DiscoveredAvailable { get; private set; }
        public void DiscoverSelected()
        {
            string native;
            if (LobbyRoomEntry.SelectedButton(out native) == null) return;
            if (DiscoveredNative != native) { DiscoveredNative = native; DiscoveryReady = false; DiscoveredCode = null; }
            if (Busy) return;
            _discoverNative = native; _afterRegister = "findGame";
            if (string.IsNullOrEmpty(_token)) { var register=Body("register"); register["name"]=_name.Value; Send(register); }
            else ConnectReady();
        }
        public void JoinSelected()
        {
            string native;
            if (LobbyRoomEntry.SelectedButton(out native) == null || native != DiscoveredNative || !DiscoveryReady || string.IsNullOrEmpty(DiscoveredCode)) { Message="等待当前对局房间状态"; DiscoverSelected(); return; }
            if (!DiscoveredAvailable) { Message="本局房间已满或房主离线"; return; }
            Connect(DiscoveredCode, false);
        }
        bool _joiningMatch;
        public bool Matching { get { return _match != null || _createNativeId != null; } }
        public RoomState State { get; private set; }
        public string Message { get; private set; }
        public bool Busy { get { return _request != null || _pending != null || _match != null || _createNativeId != null; } }
        public RoomClient(PredictionMod mod, ModContext ctx)
        {
            _mod = mod; _ctx = ctx;
            _url = ctx.Config.Bind("online", "server", "https://auth.kaigua.vip/prediction", "独立娱乐积分房间服务地址；外网使用HTTPS");
            _name = ctx.Config.Bind("online", "name", "观众", "房间昵称（首次注册时使用，1至24字）");
            ReadIdentity();
            _finals = RoomFinalSync.Read(ctx.Data.Get<Dictionary<string, object>>(RoomFinalSync.SaveKey, null));
            _departures = RoomDepartureSync.Read(ctx.Data.Get<Dictionary<string, object>>(RoomDepartureSync.SaveKey, null));
            Message = "选择加入、创建或匹配房间";
        }
        public void SetMessage(string message) { Message = message; }
        void ReadIdentity()
        {
            _endpoint = _url.Value.Trim().TrimEnd('/');
            _reliefSeen = 0;
            var saved = _ctx.Data.Get<Dictionary<string, object>>("room.identity.v1", null);
            if (saved != null && Json.GetString(saved, "server", "") == _endpoint)
            {
                _token = Json.GetString(saved, "token", ""); _code = Json.GetString(saved, "code", "");
                _reliefSeen = (long)Json.GetNumber(saved, "reliefSeen", 0);
                _pending = saved.ContainsKey("pending") ? saved["pending"] as Dictionary<string, object> : null;
            }
        }
        void SaveIdentity()
        {
            var saved = new Dictionary<string, object>(); saved["server"] = _endpoint; saved["token"] = _token ?? ""; saved["code"] = _code ?? "";
            saved["reliefSeen"] = (double)_reliefSeen;
            if (_pending != null) saved["pending"] = _pending;
            _ctx.Data.Set("room.identity.v1", saved);
        }
        void SaveFinals() { _ctx.Data.Set(RoomFinalSync.SaveKey, _finals.Write()); }
        void SaveDepartures() { _ctx.Data.Set(RoomDepartureSync.SaveKey, _departures.Write()); }
        void CaptureDeparture(RoomState state)
        {
            if (state == null || state.Settled || state.Forfeited) return;
            Market market = _mod.Book == null ? null : _mod.Book.Find(state.GameId);
            if ((market != null && market.Settled) || _finals.HasComplete(_endpoint, _token, state.Code, state.GameId)) return;
            bool inFlight = _pending != null && Json.GetString(_pending,"code","") == state.Code;
            if (!state.HasPendingBets && !inFlight) return;
            var backup = _departures.Write();
            try { if (_departures.Capture(_endpoint, _token, state.Code, state.GameId)) SaveDepartures(); }
            catch { _departures = RoomDepartureSync.Read(backup); throw; }
            state.Open = false;
        }
        public void ObserveLocation(string activeId)
        {
            _locationKnown = true; _activeGameId = activeId;
            if (State != null && State.GameId != activeId) CaptureDeparture(State);
        }
        void CompleteDepartureRequest()
        {
            try
            {
                if (_request.isNetworkError || _request.responseCode >= 400) throw new InvalidOperationException();
                string wire = _request.downloadHandler.text;
                if (wire == null || wire.Length > 262144) throw new FormatException();
                var root = Json.ParseObject(wire);
                if (!Json.GetBool(root,"ok",false)) throw new InvalidOperationException();
                var data = root["data"] as Dictionary<string, object>;
                RoomState state = RoomState.Read(data);
                var backup = _departures.Write();
                if (!_departures.Confirm(_departureRequest, state.Code, state.GameId, Json.GetBool(data,"abandonConfirmed",false))) throw new FormatException();
                try { SaveDepartures(); } catch { _departures = RoomDepartureSync.Read(backup); throw; }
                if (_endpoint == _departureRequest.Server && _token == _departureRequest.Token)
                {
                    if (_code == state.Code) State = state;
                    ObserveRelief(state);
                }
                Message = "离场未结算投注已放弃，不退本金、不再返奖";
            }
            catch { Message = "离场投注处理尚未确认，将按原房间自动重试；联机需要新版服务端"; }
            finally { DestroyRequest(); _departureRequest = null; _departureNext = Time.unscaledTime + 5f; }
        }
        void ObserveRelief(RoomState state)
        {
            if (state.ReliefCount <= _reliefSeen) return;
            long previous = _reliefSeen;
            _reliefSeen = state.ReliefCount;
            try { SaveIdentity(); }
            catch { _reliefSeen = previous; throw; }
            _mod.NotifyRelief((state.ReliefCount - previous) * PredictionBook.ReliefAmount);
        }
        public void CaptureFinalSnapshot(MatchSnapshot snapshot)
        {
            if (State == null || !State.Host || State.Settled || snapshot == null || !snapshot.Ended
                || snapshot.Id != State.GameId || !snapshot.IsEightPlayerMatch() || snapshot.Ranks == null || snapshot.Ranks.Length != 8) return;
            if (_finals.Capture(_endpoint, _token, _code, Snapshot(snapshot))) SaveFinals();
        }
        void RecoverFinalSnapshot()
        {
            CaptureFinalSnapshot(_mod.Snapshot);
            if (State == null || !State.Host || State.Settled || _mod.Book == null) return;
            Market market = _mod.Book.Find(State.GameId);
            if (market != null && market.Settled && market.FinalRanks != null)
                CaptureFinalSnapshot(new MatchSnapshot { Id = market.Id, Round = market.HighestRound, Players = market.Players,
                    Ranks = market.FinalRanks, Ended = true, ResultsThroughRound = market.ClosedThroughRound });
        }
        void CompleteFinalRequest()
        {
            try
            {
                if (_request.isNetworkError || _request.responseCode >= 400) throw new InvalidOperationException();
                string text = _request.downloadHandler.text;
                if (text == null || text.Length > 262144) throw new FormatException();
                var root = Json.ParseObject(text);
                if (!Json.GetBool(root, "ok", false)) throw new InvalidOperationException();
                var state = RoomState.Read(root["data"] as Dictionary<string, object>);
                if (state.Code != _finalRequest.Code || state.GameId != _finalRequest.GameId) throw new FormatException();
                if (_finals.Confirm(_finalRequest, state.Code, state.GameId, state.Settled)) SaveFinals();
                if (_endpoint == _finalRequest.Server && _token == _finalRequest.Token)
                {
                    if (_code == state.Code) State = state;
                    ObserveRelief(state);
                }
                Message = state.Settled ? "最终结果已确认，房间 " + state.Code + " 已结算" : "房间已封盘，等待完整最终名次";
            }
            catch { Message = "最终结果尚未确认，已保存并将自动补发"; }
            finally { DestroyRequest(); _finalRequest = null; _finalNext = Time.unscaledTime + 5f; }
        }
        public static Dictionary<string, object> Snapshot(MatchSnapshot s)
        {
            var d = new Dictionary<string, object>(); d["id"] = s.Id; d["round"] = s.Round;
            // 结束快照可从旧账本恢复；不能拿当前观战的原生房间ID标记旧对局。
            d["gameRoomId"] = s.Ended ? "" : NativeRoomSpectate.CurrentRoomId();
            d["closedThrough"] = s.ResultsThroughRound; d["open"] = s.TradingOpen && s.LiveObserver; d["ended"] = s.Ended;
            var players = new List<object>(); var ranks = new List<object>();
            for (int i = 0; i < 8; i++)
            {
                var p = new Dictionary<string, object>(); p["uid"] = s.Players[i].Uid; p["name"] = s.Players[i].Name; players.Add(p);
                int rank = s.Ended ? s.Ranks[i] : s.States != null && s.States[i] != null && s.States[i].Life <= 0 ? s.States[i].FinalRank : 0;
                ranks.Add(rank >= 1 && rank <= 8 ? rank : 0);
            }
            d["players"] = players; d["ranks"] = ranks; return d;
        }
        Dictionary<string, object> Body(string action) { var d = new Dictionary<string, object>(); d["action"] = action; if (!string.IsNullOrEmpty(_code)) d["code"] = _code; return d; }
        public bool Create(bool allowMatch, string expectedNative)
        {
            if (Busy) { Message = "等待上一操作确认"; return false; }
            if (NativeRoomSpectate.IsLobby)
            {
                string current;
                if (LobbyRoomEntry.SelectedButton(out current) == null || current != expectedNative)
                { Message = "所选对局已变更，请返回后重新创建"; return false; }
                if (current != DiscoveredNative || !DiscoveryReady || !string.IsNullOrEmpty(DiscoveredCode))
                { Message = "请等待本局房间查询完成；已有房间请直接加入"; return false; }
            }
            _allowMatch = allowMatch;
            Connect("", true);
            return _createNativeId != null || _request != null;
        }
        public void Connect(string code, bool create)
        {
            if (Busy) { Message = "等待上一操作确认"; return; }
            if (NativeRoomSpectate.IsLobby)
            {
                if (create)
                {
                    string native;
                    LobbyRoomEntry.SelectedButton(out native);
                    if (native != DiscoveredNative || !DiscoveryReady) { Message="正在查询本局房间，请稍后点击"; DiscoverSelected(); return; }
                    if (!string.IsNullOrEmpty(DiscoveredCode)) { JoinSelected(); return; }
                    string target, error;
                    if (!LobbyRoomEntry.SpectateSelected(out target, out error, true)) { Message = error; return; }
                    _createNativeId = target; _createDeadline = Time.unscaledTime + 90f;
                    Message = "正在进入所选观战；Elo就绪后自动创建房间";
                }
                else
                {
                    _lookupCode = code.Trim(); _afterRegister = "lookup";
                    if (string.IsNullOrEmpty(_token)) { var register = Body("register"); register["name"] = _name.Value; Send(register); }
                    else ConnectReady();
                }
                return;
            }
            MatchSnapshot s = _mod.Snapshot;
            if (!PredictionVisibility.CanShow() || s == null || !s.IsEightPlayerMatch()) { Message = "请先进入完整八人实时观战"; return; }
            State = null;
            _afterRegister = create ? "create" : "join"; _code = create ? null : code.Trim();
            if (string.IsNullOrEmpty(_token)) { var register = Body("register"); register["name"] = _name.Value; Send(register); }
            else ConnectReady();
        }
        Dictionary<string,object> RatedSnapshot(MatchSnapshot snapshot)
        {
            var data=Snapshot(snapshot);Market market=_mod.Current;
            if(market!=null&&market.QuoteRates!=null){var rates=new List<object>();for(int i=0;i<snapshot.Players.Length;i++){int at=market.FindPlayer(snapshot.Players[i].Uid);for(int rank=0;rank<8;rank++)rates.Add(market.QuoteRates[at*8+rank]);}data["baseRates"]=rates;data["open"]=snapshot.LiveObserver&&market.TradingWindowOpen;}
            return data;
        }
        void ConnectReady()
        {
            if (_afterRegister == "findGame") { _afterRegister=null; var find=Body("findGame"); find["nativeId"]=_discoverNative; Send(find); return; }
            if (_afterRegister == "lookup") { _afterRegister = null; var lookup = Body("lookup"); lookup["code"] = _lookupCode; Send(lookup); return; }
            if (_afterRegister == "random") { _afterRegister = null; var random = Body("random"); random["exclude"] = _code ?? ""; Send(random); return; }
            MatchSnapshot s = _mod.Snapshot;
            if (s == null || !s.LiveObserver) { Message = "观战已离开，请重新连接"; return; }
            var body = Body(_afterRegister); body["gameId"] = s.Id;
            if (_afterRegister == "create") {if(_mod.Current==null){Message="Elo基础倍率仍在准备，请稍后创建";return;}body["snapshot"] = RatedSnapshot(s);body["allowMatch"] = _allowMatch;}
            _afterRegister = null; Send(body);
        }
        public void RandomJoin()
        {
            if (Busy) { Message = "等待上一操作完成，或取消当前匹配"; return; }
            if (!NativeRoomSpectate.IsLobby) { Message = "请先通过游戏返回大厅，再随机加入其他对局"; return; }
            if (State != null && State.Host && !State.Settled && !State.Forfeited) { Message = "你仍是未结束房间的房主，请先完成对局或明确离开原房间"; return; }
            _afterRegister = "random";
            if (string.IsNullOrEmpty(_token)) { var register = Body("register"); register["name"] = _name.Value; Send(register); }
            else ConnectReady();
        }
        public void CancelMatch()
        {
            if (_match == null && _createNativeId == null) return;
            _createNativeId = null; _match = null;
            Message = "已取消匹配，不加入预测房间；原生观战确认框请按游戏自己的取消按钮关闭";
        }
        public void Leave()
        {
            if (Busy) { Message = "先等待在途操作确认后再离开"; return; }
            CaptureDeparture(State);
            _code = null; State = null; SaveIdentity(); Message = "已离开；未结算投注将自动放弃，不退本金、不再返奖";
        }
        public void Trade(string kind, int player, int rank, long stake)
        {
            MatchSnapshot s = _mod.Snapshot;
            if (Busy || State == null || !State.Open || State.Forfeited || State.TradingClosed || s == null || s.Round > PredictionBook.TradingClosingRound || s.ResultsThroughRound >= PredictionBook.TradingClosingRound || _departures.Contains(_endpoint, _token, State.Code, State.GameId) || !PredictionVisibility.CanShow() || s.Id != State.GameId || !s.TradingOpen || s.Ended || s.Round != State.Round || s.ResultsThroughRound >= s.Round) { Message = "当前不可交易，等待房间与观战状态同步"; return; }
            var d = Body("trade"); d["kind"] = kind; d["player"] = player; d["rank"] = rank; d["stake"] = stake;
            d["version"] = State.Version; d["operation"] = Guid.NewGuid().ToString("N");
            _pending = d; SaveIdentity(); Send(d);
        }
        void Send(Dictionary<string, object> body, string server = null, string credential = null)
        {
            if (server == null && !string.IsNullOrEmpty(_token) && !string.IsNullOrEmpty(GameClientUtil.uid))
            {
                var identity = new Dictionary<string, object>();
                string name = GameDataManager.username.Value;
                identity["name"] = string.IsNullOrEmpty(name) ? _name.Value : name; identity["uid"] = GameClientUtil.uid;
                body["identity"] = identity;
            }
            Uri uri;
            string endpoint = server ?? _endpoint, token = credential ?? _token;
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out uri) || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)))
            { Message = "服务器须使用HTTPS（本机测试允许HTTP）"; return; }
            try
            {
                _sent = body;
                _request = new UnityWebRequest();
                _request.url = endpoint + "/v1/room";
                _request.method = "POST";
                _request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(Json.Serialize(body)));
                _request.downloadHandler = new DownloadHandlerBuffer(); _request.timeout = 8;
                _request.SetRequestHeader("Content-Type", "application/json");
                if (!string.IsNullOrEmpty(token)) _request.SetRequestHeader("Authorization", "Bearer " + token);
                _request.SendWebRequest();
            }
            catch { DestroyRequest(); Message = "请求未完成，等待重连确认"; _next = Time.unscaledTime + 3f; }
        }
        void ObserveMembers(RoomState state)
        {
            bool first = _membersRoom != state.Code;
            if (first) { _seenMembers.Clear(); _membersRoom = state.Code; }
            string notice = "";
            for(int i=0;i<state.MemberIds.Length;i++)
            {
                if (_seenMembers.Contains(state.MemberIds[i])) continue;
                _seenMembers.Add(state.MemberIds[i]);
                string name = state.MemberNames[i] + "（ID " + (string.IsNullOrEmpty(state.MemberUids[i]) ? state.MemberIds[i] : state.MemberUids[i]) + "）";
                if (!first) notice += (notice.Length > 0 ? "、" : "") + name;
            }
            if (notice.Length > 0)
            {
                JoinNotice = notice + " 加入房间"; _noticeUntil = Time.unscaledTime + 8f;
                _ctx.Log.Info(JoinNotice);
                HintMessagePanel.Show(JoinNotice);
            }
        }
        public void Update()
        {
            RecoverFinalSnapshot();
            if (JoinNotice != null && Time.unscaledTime > _noticeUntil) JoinNotice = null;
            if (_endpoint != _url.Value.Trim().TrimEnd('/'))
            {
                // Never send a saved credential to a different server.
                if (Busy) { Message = "服务器地址已变更；先恢复旧地址完成在途操作"; return; }
                DestroyRequest(); _token = null; _code = null; State = null; ReadIdentity();
            }
            if (_request == null && _pending == null && _departures.Count > 0 && Time.unscaledTime >= _departureNext)
            {
                if (_departureCursor >= _departures.Count) _departureCursor = 0;
                _departureRequest = _departures.At(_departureCursor++);
                var body = new Dictionary<string, object> { { "action","abandon" }, { "code",_departureRequest.Code }, { "gameId",_departureRequest.GameId }, { "operation",_departureRequest.Operation } };
                _departureNext = Time.unscaledTime + 5f;
                Send(body, _departureRequest.Server, _departureRequest.Token);
                if (_request == null) _departureRequest = null;
                return;
            }
            if (_request == null && _finals.Count > 0 && Time.unscaledTime >= _finalNext)
            {
                if (_finalCursor >= _finals.Count) _finalCursor = 0;
                _finalRequest = _finals.At(_finalCursor++);
                var body = new Dictionary<string, object> { { "action", "sync" }, { "code", _finalRequest.Code }, { "snapshot", _finalRequest.Snapshot } };
                // 独立限速，旧房间暂不可达时仍允许当前房间轮询和交易。
                _finalNext = Time.unscaledTime + 5f;
                Send(body, _finalRequest.Server, _finalRequest.Token);
                if (_request == null) _finalRequest = null;
                return;
            }
            if (_createNativeId != null && _request == null)
            {
                MatchSnapshot ready = _mod.Snapshot;
                if (Time.unscaledTime >= _createDeadline) { _createNativeId = null; Message = "未进入所选观战，创建已取消"; }
                else if (_mod.Current != null && ready != null && ready.LiveObserver && !ready.Ended && ready.IsEightPlayerMatch() && NativeRoomSpectate.CurrentRoomId() == _createNativeId)
                { _createNativeId = null; Connect("", true); return; }
                else return;
            }
            if (_match != null && _request == null)
            {
                if (_match.Expired(Time.unscaledTime)) { _match = null; Message = "未在90秒内进入目标实时观战，匹配已取消；没有扣除积分"; }
                else if (_match.CanJoin(_mod.Snapshot, Time.unscaledTime))
                {
                    var join = Body("join"); join["code"] = _match.Code; join["gameId"] = _match.GameId;
                    _match = null; _joiningMatch = true; Send(join);
                }
                else return;
            }
            if (_request != null)
            {
                if (!_request.isDone) return;
                if (_departureRequest != null) { CompleteDepartureRequest(); return; }
                if (_finalRequest != null) { CompleteFinalRequest(); return; }
                bool connect = false;
                RoomMatch selected = null;
                try
                {
                    if (_request.isNetworkError || _request.responseCode >= 500) throw new InvalidOperationException("网络未确认");
                    string text = _request.downloadHandler.text;
                    if (text == null || text.Length > 262144) throw new FormatException("响应过大");
                    var root = Json.ParseObject(text);
                    if (!Json.GetBool(root, "ok", false))
                    {
                        _joiningMatch = false;
                        Message = Json.GetString(root, "error", "请求失败");
                        if (_pending != null) { _pending = null; SaveIdentity(); }
                    }
                    else
                    {
                        var data = root["data"] as Dictionary<string, object>;
                        if (Json.GetString(_sent, "action", "") == "register")
                        { _token = Json.GetString(data, "token", ""); _reliefSeen = 0; SaveIdentity(); connect = true; }
                        else if (Json.GetString(_sent,"action","") == "findGame")
                        {
                            string native=Json.GetString(data,"nativeId","");
                            if (native == DiscoveredNative) { DiscoveryReady=true; DiscoveredCode=Json.GetBool(data,"exists",false)?Json.GetString(data,"code",""):null; DiscoveredAvailable=Json.GetBool(data,"available",false); }
                        }
                        else if ((Json.GetString(_sent, "action", "") == "random" || Json.GetString(_sent, "action", "") == "lookup")) selected = new RoomMatch(data, Time.unscaledTime);
                        else
                        {
                            State = RoomState.Read(data); _code = State.Code; ObserveMembers(State);
                            if ((_joiningMatch && Json.GetString(_sent, "action", "") == "join") || Json.GetString(_sent, "action", "") == "create") { _joiningMatch = false; _mod.OnlinePanel.Open(); }
                            if (Json.GetString(_sent, "action", "") == "trade") _pending = null;
                            SaveIdentity(); ObserveRelief(State);
                            if (_locationKnown && State.GameId != _activeGameId) CaptureDeparture(State);
                            Message = State.Settled ? "整局已结算，返还 " + PredictionMod.N(State.Payout) + " 分" : State.Rules==2?"基础倍率 × 投注系数；本轮投入影响下一轮，差一名返权益25%":"旧房间沿用原资金池结算规则";
                        }
                    }
                }
                catch { Message = _pending != null ? "网络未确认：暂停新操作并用同一编号重试，避免重复扣分" : "房间连接失败，稍后自动重连"; }
                DestroyRequest(); _next = Time.unscaledTime + 1.5f;
                if (selected != null)
                {
                    string error;
                    string currentNative;
                    var nativeButton=LobbyRoomEntry.SelectedButton(out currentNative);
                    bool entered;
                    if (nativeButton != null && currentNative == selected.NativeRoomId) entered=LobbyRoomEntry.SpectateSelected(out currentNative,out error);
                    else entered=NativeRoomSpectate.Request(selected.NativeRoomId,out error);
                    if (entered)
                    {
                        _match = selected;
                        Message = "已匹配房间 " + selected.Code + "，请确认游戏原生观战提示；进入相同实时对局后自动加入，不会自动投入积分";
                    }
                    else Message = error;
                }
                if (connect) ConnectReady(); return;
            }
            if (Time.unscaledTime < _next) return;
            _next = Time.unscaledTime + 1.5f;
            if (_pending != null) { Send(_pending); return; }
            if (string.IsNullOrEmpty(_code) || string.IsNullOrEmpty(_token)) return;
            MatchSnapshot s = _mod.Snapshot;
            if (State != null && State.Host && s != null && s.Id == State.GameId && (s.LiveObserver || s.Ended))
            { var body = Body("sync"); body["snapshot"] = RatedSnapshot(s); Send(body); }
            else Send(Body("view"));
        }
        void DestroyRequest() { if (_request != null) { _request.Abort(); _request.Dispose(); _request = null; } }
        public void Destroy() { DestroyRequest(); }
    }
}
#endif
