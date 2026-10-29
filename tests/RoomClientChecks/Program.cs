using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Mono.Cecil;
using Yx.Shared;
using Yx.ModSdk;
using Yx.ModSdk.Testing;
using YxPrediction;
namespace UnityEngine { public static class Time { public static float unscaledTime; } public static class GUIUtility { public static string systemCopyBuffer; } }
namespace UnityEngine.Networking
{
    public sealed class UploadHandlerRaw { public byte[] Data; public UploadHandlerRaw(byte[] data) { Data=data; } }
    public sealed class DownloadHandlerBuffer { public string text; }
    public sealed class UnityWebRequest
    {
        public static readonly List<UnityWebRequest> Sent=new List<UnityWebRequest>();
        public string url,method; public int timeout; public long responseCode=200; public bool isDone,isNetworkError;
        public UploadHandlerRaw uploadHandler; public DownloadHandlerBuffer downloadHandler; public Dictionary<string,object> Body;
        public readonly Dictionary<string,string> Headers=new Dictionary<string,string>();
        public void SetRequestHeader(string name,string value) { Headers[name]=value; }
        public void SendWebRequest() { Body=Json.ParseObject(Encoding.UTF8.GetString(uploadHandler.Data));Sent.Add(this); }
        public void Abort() { } public void Dispose() { }
    }
}
public static class GameClientUtil { public static string uid="game-uid"; }
public sealed class NameValue { public string Value="review"; }
public static class GameDataManager { public static NameValue username=new NameValue(); }
public static class HintMessagePanel { public static void Show(string text) { } }
namespace YxPrediction
{
    public sealed class RoomPanel { public void Open() { } }
    public static class PredictionVisibility { public static bool CanShow() { return true; } }
    public static class NativeRoomSpectate { public static bool IsLobby { get; set; } public static string CurrentRoomId() { return "native"; } public static bool Request(string id,out string error) { error=null;return false; } }
    public static class LobbyRoomEntry
    {
        public static string Selected = "native"; public static bool Confirmed;
        public static object SelectedButton(out string native) { native=Selected;return Selected; }
        public static bool SpectateSelected(out string native,out string error,bool confirmed=false) { native=Selected;error=null;Confirmed=confirmed;return Selected!=null; }
    }
    public sealed class PredictionMod : YxMod
    {
        public MatchSnapshot Snapshot; public Market Current; public RoomClient Client; public RoomPanel OnlinePanel=new RoomPanel();
        public PredictionBook Book=new PredictionBook(1000); public ModContext Ctx;
        public readonly ReliefNotice ReliefNotices=new ReliefNotice();
        public void NotifyRelief(long amount) { ReliefNotices.Notify(amount); }
        public void RefreshForTrade() { }
        public override void OnLoad(ModContext ctx) { Ctx=ctx;Client=new RoomClient(this,ctx); }
        public override void OnDisable() { if(Client!=null)Client.Destroy(); }
        public static string N(long n) { return n.ToString(); }
    }
}
internal static class Program
{
    const string Id="review.client", Server="https://duma.kaigua.vip";
    static void Require(bool ok,string error) { if(!ok)throw new Exception(error); }
    static void Set(object target,string field,object value) { target.GetType().GetField(field,BindingFlags.NonPublic|BindingFlags.Instance).SetValue(target,value); }
    static MatchSnapshot Snapshot(bool ended=false,int known=8)
    {
        var s=new MatchSnapshot {Id="game",Round=9,LiveObserver=true,TradingOpen=!ended,Ended=ended,Players=new Player[8],Ranks=new int[8]};
        for(int i=0;i<8;i++){s.Players[i]=new Player("uid"+i,"player"+i,false);s.Ranks[i]=ended&&i<known?i+1:0;}return s;
    }
    static Dictionary<string,object> View(bool settled=false)
    {
        var d=new Dictionary<string,object> {{"code","123456"},{"gameId","game"},{"host",true},{"members",1},{"round",9},{"version",0},{"open",!settled},{"settled",settled},{"balance",1000},{"payout",0}};
        var players=new List<object>();var ranks=new List<object>();var positions=new List<object>();var pools=new List<object>();
        for(int i=0;i<8;i++){players.Add(new Dictionary<string,object>{{"uid","uid"+i},{"name","player"+i}});ranks.Add(settled?i+1:0);positions.Add(null);var pool=new List<object>();for(int j=0;j<8;j++)pool.Add(0);pools.Add(pool);}
        d["players"]=players;d["ranks"]=ranks;d["positions"]=positions;d["totals"]=pools;return d;
    }
    static UnityEngine.Networking.UnityWebRequest Last { get { var all=UnityEngine.Networking.UnityWebRequest.Sent;return all[all.Count-1]; } }
    static void Complete(bool failed=false,bool settled=false,long reliefCount=0)
    {
        var data=View(settled); if(reliefCount>0)data["reliefCount"]=reliefCount;
        Last.isDone=true;Last.isNetworkError=failed;Last.downloadHandler.text=Json.Serialize(new Dictionary<string,object>{{"ok",true},{"data",data}});
    }
    static PredictionMod Setup(TestHost host)
    {
        UnityEngine.Networking.UnityWebRequest.Sent.Clear();UnityEngine.Time.unscaledTime=0;
        var mod=host.Load<PredictionMod>(Id,"0.7.4");mod.Snapshot=Snapshot();mod.Snapshot.States=new PlayerState[8];for(int i=0;i<8;i++)mod.Snapshot.States[i]=new PlayerState(100,0,0,0);
        Set(mod.Client,"_token",new string('a',48));Set(mod.Client,"_code","123456");Set(mod.Client,"<State>k__BackingField",RoomState.Read(Json.ParseObject(Json.Serialize(View()))));
        return mod;
    }
    static int Pending(PredictionMod mod) { return RoomFinalSync.Read(mod.Ctx.Data.Get<Dictionary<string,object>>(RoomFinalSync.SaveKey,null)).Count; }
    static void SentFinal()
    {
        Require((string)Last.Body["action"]=="sync"&&(bool)((Dictionary<string,object>)Last.Body["snapshot"])["ended"],"Final snapshot was not sent");
        Require((string)((Dictionary<string,object>)Last.Body["snapshot"])["gameRoomId"]=="","Old final inherited the current native room ID");
    }
    static void FinalDelivery(bool lose)
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);var client=mod.Client;
            client.Update();Complete();UnityEngine.Time.unscaledTime=0.1f;client.Update();
            mod.Snapshot=Snapshot(true);client.CaptureFinalSnapshot(mod.Snapshot);
            Require(Pending(mod)==1,"Final was not saved immediately");
            UnityEngine.Time.unscaledTime=lose?2f:0.2f;client.Update();
            if(lose){SentFinal();Complete(true);UnityEngine.Time.unscaledTime=2.1f;client.Update();Require(Pending(mod)==1,"Failure discarded final");}
            mod.Snapshot=null;UnityEngine.Time.unscaledTime=lose?8f:2f;client.Update();SentFinal();
            Complete(settled:true);UnityEngine.Time.unscaledTime+=0.1f;client.Update();Require(Pending(mod)==0,"Confirmed result was not cleared");
            mod.Snapshot=null;UnityEngine.Time.unscaledTime=16f;client.Update();Require((string)Last.Body["action"]=="view","Settled result kept resending");
        }
    }
    static void ReloadAndEndpointIsolation()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Client.CaptureFinalSnapshot(Snapshot(true));
            var data=new Dictionary<string,object> {{RoomFinalSync.SaveKey,mod.Ctx.Data.Get<Dictionary<string,object>>(RoomFinalSync.SaveKey,null)},
                {"room.identity.v1",new Dictionary<string,object>{{"server",Server},{"token",new string('a',48)},{"code","123456"}}}};
            mod=host.Reload<PredictionMod>(Id,"0.7.4",data:data);
            host.SetConfig(Id,new Dictionary<string,object>{{"online",new Dictionary<string,object>{{"server","https://new.example"}}}});
            UnityEngine.Time.unscaledTime=20;mod.Client.Update();SentFinal();
            Require(Last.url==Server+"/v1/room"&&Last.Headers["Authorization"]=="Bearer "+new string('a',48),"Final used another server or credential");
            Complete(settled:true);UnityEngine.Time.unscaledTime=20.1f;mod.Client.Update();
            Require(Pending(mod)==0&&mod.Client.State==null,"Old-room acknowledgement changed the new connection");
        }
    }
    static void PartialFinal()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Client.CaptureFinalSnapshot(Snapshot(true,3));mod.Snapshot=null;
            mod.Client.Update();SentFinal();Complete();UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();Require(Pending(mod)==1,"Partial final removed without settlement");
            mod.Client.CaptureFinalSnapshot(Snapshot(true));UnityEngine.Time.unscaledTime=6;mod.Client.Update();SentFinal();
            var ranks=(List<object>)((Dictionary<string,object>)Last.Body["snapshot"])["ranks"];
            Require(Convert.ToInt32(ranks[7])==8,"Complete final did not replace partial ranks");
            Complete(settled:true);UnityEngine.Time.unscaledTime=6.1f;mod.Client.Update();Require(Pending(mod)==0,"Final not confirmed");
        }
    }
    static void RetryDoesNotBlockCurrentRoom()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Client.CaptureFinalSnapshot(Snapshot(true));mod.Snapshot=null;
            mod.Client.Update();SentFinal();Complete(true);UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();
            UnityEngine.Time.unscaledTime=0.2f;mod.Client.Update();
            Require((string)Last.Body["action"]=="view","Old failed final blocked ordinary room polling");
            Complete();UnityEngine.Time.unscaledTime=0.3f;mod.Client.Update();
            UnityEngine.Time.unscaledTime=6f;mod.Client.Update();SentFinal();
            Require(Pending(mod)==1,"Ordinary view cleared an unconfirmed final");
        }
    }
    static void RecoverSettledBook()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);var ratings=new Rating[8];for(int i=0;i<8;i++)ratings[i]=Rating.Unknown();
            mod.Book.Observe(Snapshot(),ratings);mod.Book.Observe(Snapshot(true),null);
            Require(mod.Book.Find("game").Settled,"Local recovery fixture did not settle");
            mod.Book=BookCodec.Read(Json.ParseObject(Json.Serialize(BookCodec.Write(mod.Book))));mod.Snapshot=null;
            mod.Client.Update();SentFinal();Require(Pending(mod)==1,"Settled saved book was not recovered");
            Complete(settled:true);UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();Require(Pending(mod)==0,"Recovered book result was not confirmed");
        }
    }
    static int Departures(PredictionMod mod) { return RoomDepartureSync.Read(mod.Ctx.Data.Get<Dictionary<string,object>>(RoomDepartureSync.SaveKey,null)).Count; }
    static void Holding(PredictionMod mod)
    {
        var state=View();((List<object>)state["positions"])[0]=new Dictionary<string,object>{{"rank",1},{"stake",1000}};
        Set(mod.Client,"<State>k__BackingField",RoomState.Read(Json.ParseObject(Json.Serialize(state))));
    }
    static void CompleteDeparture(bool ack=true,long relief=1,string game="game")
    {
        var data=View();data["gameId"]=game;data["abandonConfirmed"]=ack;data["forfeited"]=true;data["open"]=false;data["balance"]=50;data["reliefCount"]=relief;
        Last.isDone=true;Last.downloadHandler.text=Json.Serialize(new Dictionary<string,object>{{"ok",true},{"data",data}});
    }
    static void DepartureDelivery()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);Holding(mod);
            mod.Client.ObserveLocation("game");Require(Departures(mod)==0,"Focus change forfeited same game");
            mod.Snapshot=null;mod.Client.ObserveLocation(null);Require(Departures(mod)==1,"Departure not persisted immediately");
            mod.Client.Update();Require((string)Last.Body["action"]=="abandon","Departure action not sent");
            string operation=(string)Last.Body["operation"];
            CompleteDeparture(false);UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();Require(Departures(mod)==1,"Legacy response confirmed unsupported forfeiture");
            UnityEngine.Time.unscaledTime=6;mod.Client.Update();Require((string)Last.Body["operation"]==operation,"Retry operation identity changed");
            CompleteDeparture(game:"other");UnityEngine.Time.unscaledTime=6.1f;mod.Client.Update();Require(Departures(mod)==1,"Mismatched game confirmed departure");
            UnityEngine.Time.unscaledTime=12;mod.Client.Update();CompleteDeparture();UnityEngine.Time.unscaledTime=12.1f;mod.Client.Update();
            Require(Departures(mod)==0&&mod.Client.State.Forfeited,"Valid acknowledgement not applied");
            Require(mod.ReliefNotices.PendingAmount==50,"Actual relief not notified");
        }
    }
    static void DepartureReloadIsolation()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);Holding(mod);mod.Client.ObserveLocation(null);
            var data=new Dictionary<string,object>{{RoomDepartureSync.SaveKey,mod.Ctx.Data.Get<Dictionary<string,object>>(RoomDepartureSync.SaveKey,null)}};
            mod=host.Reload<PredictionMod>(Id,"0.7.11",data:data);
            host.SetConfig(Id,new Dictionary<string,object>{{"online",new Dictionary<string,object>{{"server","https://other.example"}}}});
            mod.Client.Update();Require(Last.url==Server+"/v1/room"&&Last.Headers["Authorization"]=="Bearer "+new string('a',48),"Departure sent to another service/identity");
            CompleteDeparture();UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();Require(Departures(mod)==0,"Reloaded departure not confirmed");
            Require(mod.Client.State==null&&mod.ReliefNotices.PendingAmount==0,"Another identity received old departure credits");
        }
    }
    static void InFlightDeparture()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Client.Trade("buy",0,1,1000);
            Require((string)Last.Body["action"]=="trade","Fixture did not start purchase");
            mod.Snapshot=null;mod.Client.ObserveLocation(null);Require(Departures(mod)==1,"In-flight purchase was missed");
            var data=View();((List<object>)data["positions"])[0]=new Dictionary<string,object>{{"rank",1},{"stake",1000}};
            Last.isDone=true;Last.downloadHandler.text=Json.Serialize(new Dictionary<string,object>{{"ok",true},{"data",data}});
            UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();mod.Client.Update();Require((string)Last.Body["action"]=="abandon","Purchase not reconciled before abandonment");
            CompleteDeparture();UnityEngine.Time.unscaledTime=0.2f;mod.Client.Update();Require(Departures(mod)==0,"In-flight departure did not finish");
        }
    }
    static void CompletedResultsAndCutoff()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);Holding(mod);mod.Client.CaptureFinalSnapshot(Snapshot(true));mod.Client.ObserveLocation(null);
            Require(Departures(mod)==0&&Pending(mod)==1,"Complete final results were forfeited instead of retried");
        }
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);Holding(mod);mod.Client.CaptureFinalSnapshot(Snapshot(true,3));mod.Client.ObserveLocation(null);
            Require(Departures(mod)==1,"Partial final blocked departure forever");
        }
        foreach(bool nextRound in new[]{false,true})
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);if(nextRound)mod.Snapshot.Round=11;else mod.Snapshot.ResultsThroughRound=10;
            mod.Client.Trade("buy",0,1,10);Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==0,"Client allowed trading after ten using stale server state");
        }
    }
    static void CohortTransport()
    {
        var s=Snapshot();s.EliminationRounds=new[]{0,0,0,0,0,0,5,5};s.TradingOpen=false;
        var wire=Json.ParseObject(Json.Serialize(RoomClient.Snapshot(s)));
        Require(Json.GetArray(wire,"eliminationRounds").Count==8&&!Json.GetBool(wire,"roundComplete",true),"Partial battle transport lost evidence");
        s.RoundResultsComplete=true;wire=Json.ParseObject(Json.Serialize(RoomClient.Snapshot(s)));Require(Json.GetBool(wire,"roundComplete",false),"Complete result did not reach server");
        var q=new RoomFinalSync();s.Ended=true;s.Ranks=new[]{1,2,3,4,5,6,7,8};q.Capture(Server,"token","123456",RoomClient.Snapshot(s));
        q=RoomFinalSync.Read(Json.ParseObject(Json.Serialize(q.Write())));Require(Json.GetArray(q.At(0).Snapshot,"eliminationRounds").Count==8,"Durable final lost cohort evidence");
        var view=View();view["rankMinimum"]=new List<object>{0,0,0,0,0,0,7,7};view["rankMaximum"]=new List<object>{0,0,0,0,0,0,8,8};
        var state=RoomState.Read(Json.ParseObject(Json.Serialize(view)));Require(state.ResultPlace(6)=="第7–8名同出","UI shows provisional individual order instead of cohort interval");
    }
    static bool Calls(MethodDefinition method,string name)
    { foreach(var i in method.Body.Instructions){var call=i.Operand as MethodReference;if(call!=null&&call.Name==name)return true;}return false; }
    static void Bindings(string path)
    {
        using(var module=ModuleDefinition.ReadModule(path))
        {
            string[] types={"PredictionMod","CharacterBetBar","RoomPanel"};string[] methods={"AcceptSnapshot","Update","CurrentView"};string[] targets={"CaptureFinalSnapshot","CanTrade","Observe"};
            for(int n=0;n<types.Length;n++){bool found=false;foreach(var method in module.GetType("YxPrediction."+types[n]).Methods)if(method.Name==methods[n])found=Calls(method,targets[n]);Require(found,"Missing production binding "+types[n]);}
            foreach(var method in module.GetType("YxPrediction.GameBridge").Methods)
                if(method.Name=="Poll"||method.Name=="OnStatus")Require(Calls(method,"ObserveLocation"),"Confirmed location is not wired to departure handling");
            var popup=module.GetType("YxPrediction.ReliefPopup");Require(popup!=null,"Relief popup missing from game DLL");
            foreach(var method in module.GetType("YxPrediction.PredictionMod").Methods)
            {
                if(method.Name=="Save")Require(Calls(method,"NotifyRelief"),"Saved relief not wired to notice");
                if(method.Name=="OnUpdate")Require(Calls(method,"Update"),"Popup update missing");
            }
            bool confirm=false, dismiss=false;
            foreach(var method in popup.Methods)
            {
                if(method.Name=="Build")foreach(var instruction in method.Body.Instructions){var target=instruction.Operand as MethodReference;if(target!=null&&target.Name=="Dismiss")confirm=true;}
                if(method.Name=="Dismiss")dismiss=Calls(method,"Dismiss");
            }
            Require(confirm&&dismiss,"Popup confirmation is not wired to dismissal");
            var panel=module.GetType("YxPrediction.RoomPanel");foreach(var method in panel.Methods)if(method.Name=="Update")Require(Calls(method,"DisplayOrder")&&Calls(method,"SetSlot"),"Purchased-first order disconnected");
            foreach(var nested in panel.NestedTypes)if(nested.Name=="Row")foreach(var method in nested.Methods)if(method.Name=="Refresh")Require(Calls(method,"CanTrade"),"Overview does not enforce betting access");
        }
        Console.WriteLine("PASS production final-event capture, shared selection and purchased-first UI bindings");
    }
    static void Main(string[] args)
    {
        if(args.Length>0){Bindings(args[0]);return;}
        CohortTransport();Console.WriteLine("PASS cohort rounds and complete-result evidence survive host transport, retries and interval UI decoding");
        DepartureDelivery();Console.WriteLine("PASS departure requires matching acknowledgement, retries durably and notifies actual relief");
        DepartureReloadIsolation();Console.WriteLine("PASS departure queue survives reload without leaking credentials or notices to another service");
        InFlightDeparture();Console.WriteLine("PASS in-flight purchase completes before departure forfeiture");
        CompletedResultsAndCutoff();Console.WriteLine("PASS complete final rewards survive departure, incomplete wagers forfeit, tenth-round cutoff is enforced locally");
        FinalDelivery(false);Console.WriteLine("PASS final result persisted before leaving and delivered after scene is gone");
        FinalDelivery(true);Console.WriteLine("PASS lost final request retries after leaving, acknowledgement stops retries");
        ReloadAndEndpointIsolation();Console.WriteLine("PASS final queue survives reload and isolates server credentials/connections");
        PartialFinal();Console.WriteLine("PASS partial result remains queued until complete ranks are confirmed settled");
        RetryDoesNotBlockCurrentRoom();Console.WriteLine("PASS failed final retries leave time for ordinary room polling");
        RecoverSettledBook();Console.WriteLine("PASS settled local book recovers a final without the old game scene");
        CreateSettings();Console.WriteLine("PASS create settings preserve matching preference, selected room and immediate native confirmation");
        ReliefReceipts();Console.WriteLine("PASS actual relief receipts notify once across polling, reload and a later grant");
        ReliefOnFinalRetry();Console.WriteLine("PASS final retries preserve relief notices and isolate another server's grants");
        BrowserAndBinding();Console.WriteLine("PASS public listing, expiring binding code, protocol and cutoff/exited order guards");
        MigratedDeparture();Console.WriteLine("PASS original-domain departure receipts apply once to the migrated identity");
        DomainMigration();Console.WriteLine("PASS default domain migration retains room token, receipt and pending operation");
    }
    static void ReliefReceipts()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Snapshot=null;
            mod.Client.Update();Complete();UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==0,"Legacy response invented a relief grant");
            UnityEngine.Time.unscaledTime=2;mod.Client.Update();Complete(reliefCount:1);UnityEngine.Time.unscaledTime=2.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==50,"Actual grant did not notify");
            mod.ReliefNotices.ShowPending(2.1);mod.ReliefNotices.Dismiss();
            UnityEngine.Time.unscaledTime=4;mod.Client.Update();Complete(reliefCount:1);UnityEngine.Time.unscaledTime=4.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==0,"Polling repeated a dismissed grant");
            var identity=mod.Ctx.Data.Get<Dictionary<string,object>>("room.identity.v1",null);
            var data=new Dictionary<string,object>{{"room.identity.v1",identity}};
            mod=host.Reload<PredictionMod>(Id,"0.7.10",data:data);mod.Snapshot=null;
            UnityEngine.Time.unscaledTime=6;mod.Client.Update();Complete(reliefCount:1);UnityEngine.Time.unscaledTime=6.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==0,"Reload repeated an acknowledged grant");
            UnityEngine.Time.unscaledTime=8;mod.Client.Update();Complete(true,reliefCount:2);UnityEngine.Time.unscaledTime=8.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==0,"Failed reply notified before confirmation");
            UnityEngine.Time.unscaledTime=10;mod.Client.Update();Complete(reliefCount:2);UnityEngine.Time.unscaledTime=10.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==50,"Next real grant was lost after a failed response");
        }
    }
    static void ReliefOnFinalRetry()
    {
        foreach(bool otherServer in new bool[]{false,true})
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Client.CaptureFinalSnapshot(Snapshot(true));mod.Snapshot=null;
            if(otherServer)host.SetConfig(Id,new Dictionary<string,object>{{"online",new Dictionary<string,object>{{"server","https://other.example/prediction"}}}});
            mod.Client.Update();SentFinal();Complete(settled:true,reliefCount:1);UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();
            Require(mod.ReliefNotices.PendingAmount==(otherServer?0:50),"Final receipt crossed identity boundary or lost its actual grant");
        }
    }
    static void CreateSettings()
    {
        using (var host=TestHost.Start())
        {
            var mod=Setup(host);NativeRoomSpectate.IsLobby=true;LobbyRoomEntry.Selected="native";LobbyRoomEntry.Confirmed=false;
            Set(mod.Client,"<DiscoveredNative>k__BackingField","native");Set(mod.Client,"<DiscoveryReady>k__BackingField",true);
            Require(!mod.Client.Create(false,"stale")&&!LobbyRoomEntry.Confirmed,"Stale room settings entered another game");
            Require(mod.Client.Create(false,"native",false)&&LobbyRoomEntry.Confirmed,"Create settings did not confirm native entry");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==0,"Server room created before observing target");
            NativeRoomSpectate.IsLobby=false;
            var ratings=new Rating[8];for(int i=0;i<8;i++)ratings[i]=Rating.Unknown();
            mod.Current=mod.Book.Observe(mod.Snapshot,ratings);
            mod.Client.Update();
            Require((string)Last.Body["action"]=="create"&&!(bool)Last.Body["allowMatch"]&&!(bool)Last.Body["isPublic"],"Room privacy or matching preference lost during entry");
        }
        NativeRoomSpectate.IsLobby=false;
    }
    static void BrowserAndBinding()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);mod.Snapshot.Round=10;mod.Client.Trade("buy",0,1,10);Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==0,"Round ten sent an order");
            mod.Client.FetchRooms(1);Require((string)Last.Body["action"]=="list"&&Json.GetNumber(Last.Body,"page",0)==1&&Json.GetNumber(Last.Body,"protocol",0)==3,"List request missing protocol/page");
            Last.isDone=true;Last.downloadHandler.text="{\"ok\":true,\"data\":{\"page\":1,\"total\":7,\"rooms\":[{\"code\":\"654321\",\"hostName\":\"甲\",\"available\":true}]}}";
            mod.Client.Update();Require(mod.Client.Browser.Rooms[0].Code=="654321","List response not parsed");
            mod.Client.CreateWebCode();Require((string)Last.Body["action"]=="linkCode","Binding request missing");
            Last.isDone=true;Last.downloadHandler.text="{\"ok\":true,\"data\":{\"code\":\"TP-1234567890\"}}";mod.Client.Update();
            Require(UnityEngine.GUIUtility.systemCopyBuffer=="TP-1234567890","Code not copied");int count=UnityEngine.Networking.UnityWebRequest.Sent.Count;
            mod.Client.CreateWebCode();Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==count,"Fresh code was needlessly regenerated");
            UnityEngine.Time.unscaledTime=301;mod.Client.CreateWebCode();Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==count+1,"Expired code reused");
        }
    }
    static void MigratedDeparture()
    {
        using(var host=TestHost.Start())
        {
            var mod=Setup(host);Holding(mod);mod.Client.ObserveLocation(null);
            var queue=mod.Ctx.Data.Get<Dictionary<string,object>>(RoomDepartureSync.SaveKey,null);
            ((Dictionary<string,object>)Json.GetArray(queue,"jobs")[0])["server"]="https://auth.kaigua.vip/prediction";
            var data=new Dictionary<string,object>{{RoomDepartureSync.SaveKey,queue},{"room.identity.v1",new Dictionary<string,object>{{"server",Server},{"token",new string('a',48)},{"code","123456"}}}};
            mod=host.Reload<PredictionMod>(Id,"0.7.13",data:data);mod.Client.Update();Require(Last.url.StartsWith("https://auth.kaigua.vip/prediction/"),"Original endpoint was changed on retry");
            CompleteDeparture();UnityEngine.Time.unscaledTime=0.1f;mod.Client.Update();Require(mod.Client.State.Forfeited&&mod.ReliefNotices.PendingAmount==50&&Departures(mod)==0,"Migrated account lost its receipt or relief notification");
        }
    }
    static void DomainMigration()
    {
        using(var host=TestHost.Start())
        {
            UnityEngine.Networking.UnityWebRequest.Sent.Clear();UnityEngine.Time.unscaledTime=0;
            var pending=new Dictionary<string,object>{{"action","trade"},{"operation","migration-operation"},{"code","123456"}};
            var identity=new Dictionary<string,object>{{"server","https://auth.kaigua.vip/prediction"},{"token",new string('b',48)},{"code","123456"},{"pending",pending},{"reliefSeen",2.0}};
            var data=new Dictionary<string,object>{{"room.identity.v1",identity}};
            var config=new Dictionary<string,object>{{"online",new Dictionary<string,object>{{"server","https://auth.kaigua.vip/prediction/"}}}};
            var mod=host.Load<PredictionMod>(Id,"0.7.12",data:data,config:config);
            var saved=mod.Ctx.Data.Get<Dictionary<string,object>>("room.identity.v1",null);
            Require((string)saved["server"]==Server&&(string)saved["token"]==new string('b',48)&&Json.GetNumber(saved,"reliefSeen",0)==2,"Migration lost saved account identity: server="+(string)saved["server"]+" tokenMatches="+((string)saved["token"]==new string('b',48))+" relief="+Json.GetNumber(saved,"reliefSeen",0));
            mod.Client.Update();Require(Last.url==Server+"/v1/room"&&(string)Last.Body["operation"]=="migration-operation","Pending operation changed on migration");
        }
    }
}
