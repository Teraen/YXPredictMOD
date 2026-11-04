using System;
using System.Collections.Generic;
using Yx.Shared;
using Yx.ModSdk;
using Yx.ModSdk.Testing;
using YxPrediction;
namespace UnityEngine { public static class Time { public static float unscaledTime; } }
namespace UnityEngine.Networking
{
    public sealed class DownloadHandlerBuffer { public string text; }
    public sealed class UnityWebRequest
    {
        public static readonly List<UnityWebRequest> Sent = new List<UnityWebRequest>();
        public string url, error; public int timeout;
        public bool isDone, isNetworkError, isHttpError, Disposed;
        public DownloadHandlerBuffer downloadHandler = new DownloadHandlerBuffer();
        public static UnityWebRequest Get(string url) { return new UnityWebRequest { url=url }; }
        public void SendWebRequest() { Sent.Add(this); }
        public void Abort() { } public void Dispose() { Disposed=true; }
    }
}
namespace YxPrediction
{
    public sealed class PredictionMod : YxMod
    {
        public EloClient Elo;
        public override void OnLoad(ModContext ctx) { Elo=new EloClient(ctx); }
        public override void OnDisable() { Elo.Destroy(); }
        public static string N(long value) { return value.ToString(); }
    }
}
internal static class Program
{
    static int _checks;
    static void Require(bool value,string message) { _checks++;if(!value)throw new Exception(message); }
    static Player[] Players(bool shared=false)
    {
        var p=new Player[8];for(int i=0;i<8;i++)p[i]=new Player(i.ToString("x22")+(shared?"aa":i.ToString("x2")),"player",false);return p;
    }
    static void Complete(Player[] players,bool missing=false,bool invalid=false)
    {
        foreach(var request in UnityEngine.Networking.UnityWebRequest.Sent)
        {
            if(request.isDone)continue;
            var rows=new Dictionary<string,object>();
            if(!missing)for(int i=0;i<players.Length;i++)
                if(players[i]!=null&&request.url.Contains("uid="+players[i].Uid))rows[players[i].Uid]=new Dictionary<string,object>{{"rating",invalid&&i==0?99999:4200},{"sigma",150},{"dx",12}};
            request.downloadHandler.text=Json.Serialize(rows);request.isDone=true;
        }
    }
    static PredictionMod Load(TestHost host)
    {
        UnityEngine.Networking.UnityWebRequest.Sent.Clear();UnityEngine.Time.unscaledTime=0;
        return host.Load<PredictionMod>("elo.checks","0.8.0");
    }
    static void Drain(PredictionMod mod) { for(int i=0;i<40;i++)mod.Elo.Update(); }
    static void Main()
    {
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();Require(mod.Elo.Get(p)==null,"Unexpected pre-request result");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Eight players must use one batch request");
            string url=UnityEngine.Networking.UnityWebRequest.Sent[0].url;
            Require(url.StartsWith(EloData.ApiUrl+"?uid="),"Batch endpoint not on same-server Elo host");
            foreach(var player in p)Require(url.Contains("uid="+player.Uid),"Batch dropped a UID");
            Complete(p);Drain(mod);Require(mod.Elo.Get(p)[7].Found,"Batch did not finish all eight");
            Require(mod.Elo.GetHorseProfiles(p)[7].DaoXinGames==12,"Horse metadata lost");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Cache re-requested batch");
            UnityEngine.Time.unscaledTime=301;Require(mod.Elo.Get(p)==null,"Successful cache never refreshes");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==2,"Expired cache did not re-batch");
            mod.Elo.Destroy();foreach(var req in UnityEngine.Networking.UnityWebRequest.Sent)Require(req.Disposed,"Request leaked");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players(true);mod.Elo.Get(p);Complete(p);Drain(mod);
            Require(mod.Elo.GetHorseProfiles(p)[7].Rating.Found,"Same suffix lost roster members");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Same suffix downloaded twice");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();mod.Elo.Get(p);
            var failed=UnityEngine.Networking.UnityWebRequest.Sent[0];failed.isNetworkError=true;failed.error="timeout";failed.isDone=true;Drain(mod);
            Require(mod.Elo.Get(p)!=null&&!mod.Elo.Get(p)[7].Found,"Batch failure blocked fallback");
            Require(mod.Elo.Summary.Contains("请求失败 8"),"Network failure mislabeled as missing");
            UnityEngine.Time.unscaledTime=31;Require(mod.Elo.Get(p)==null,"Failed request did not retry");Complete(p);Drain(mod);
            Require(mod.Elo.Get(p)[0].Found,"Retry did not recover");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();mod.Elo.Get(p);Complete(p,false,true);Drain(mod);
            Require(!mod.Elo.Get(p)[0].Found&&mod.Elo.Get(p)[7].Found,"Bad row blocked unrelated identities");
            Require(mod.Elo.Summary.Contains("请求失败 1"),"Bad profile not distinguished");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();mod.Elo.Get(p);Complete(p,true);Drain(mod);
            Require(mod.Elo.Get(p)!=null,"Missing profiles blocked result");
            Require(mod.Elo.Summary.Contains("未收录 8"),"Missing profiles reported as failures");
            mod.Elo.Get(p);Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Missing cache ignored");
            UnityEngine.Time.unscaledTime=31;Require(mod.Elo.Get(p)==null,"Missing UID never retries after source updates");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();for(int i=0;i<8;i++)p[i]=new Player("invalid","AI",i<4);
            Require(mod.Elo.Get(p)!=null&&UnityEngine.Networking.UnityWebRequest.Sent.Count==0,"AI/invalid UID started HTTP");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();
            for(int i=1;i<7;i++)p[i]=new Player("invalid","AI",true);
            p[7]=null;
            mod.Elo.Get(p);
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Single human must use one request");
            Require(UnityEngine.Networking.UnityWebRequest.Sent[0].url==EloData.Url(p[0].Uid),"Single UID queried unrelated players");
            Complete(p);Drain(mod);
            Require(mod.Elo.GetHorseProfiles(p)[0].Rating.Found&&!mod.Elo.GetHorseProfiles(p)[7].Rating.Found,"Null roster slot blocked an eligible player");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();for(int i=1;i<8;i++)p[i]=p[0];
            mod.Elo.Get(p);Require(UnityEngine.Networking.UnityWebRequest.Sent[0].url==EloData.Url(p[0].Uid),"Duplicate UID repeated in query");
            Complete(p);Drain(mod);Require(mod.Elo.Get(p)[7].Found,"Duplicate roster member lost result");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();mod.Elo.Get(p);
            UnityEngine.Time.unscaledTime=11;Drain(mod);
            Require(mod.Elo.Get(p)!=null&&mod.Elo.Summary.Contains("请求失败 8"),"Stalled native request never timed out");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Timeout fetched an old shard");
            Require(UnityEngine.Networking.UnityWebRequest.Sent[0].Disposed,"Stalled native request leaked");
            UnityEngine.Time.unscaledTime=42;mod.Elo.Get(p);Complete(p);Drain(mod);
            Require(mod.Elo.Get(p)[0].Found,"Deadline timeout cannot recover");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);var p=Players();mod.Elo.Get(p);
            var request=UnityEngine.Networking.UnityWebRequest.Sent[0];
            request.downloadHandler.text=new string(' ',EloClient.MaximumResponseCharacters+1);request.isDone=true;Drain(mod);
            Require(mod.Elo.Get(p)!=null&&mod.Elo.Summary.Contains("请求失败 8"),"Oversized response accepted");
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==1,"Oversized response fell back to full shards");
        }
        using(var host=TestHost.Start())
        {
            var mod=Load(host);
            for(int wave=0;wave<6;wave++){var p=Players();for(int i=0;i<8;i++)p[i]=new Player((wave*8+i).ToString("x24"),"player",false);mod.Elo.Get(p);}
            Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==4,"Concurrent focus changes exceeded four jobs");
            mod.Elo.Destroy();mod.Elo.Update();Require(UnityEngine.Networking.UnityWebRequest.Sent.Count==4,"Destroy restarted jobs");
            foreach(var req in UnityEngine.Networking.UnityWebRequest.Sent)Require(req.Disposed,"Destroy leaked pending HTTP");
        }
        Console.WriteLine("Elo batch pipeline checks passed: "+_checks+" (production client, offline network doubles)");
    }
}
