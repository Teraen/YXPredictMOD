using System;
using System.Collections.Generic;
using Yx.Shared;
using YxPrediction;
public static class EloScanFixture
{
    public static void Verify()
    {
        string uid="0123456789abcdef01234567";
        if (EloData.Url(uid) != EloData.ApiUrl + "?uid=" + uid) throw new Exception("Single UID URL is not a direct query");
        if (EloData.BatchUrl(new string[] { uid, uid }) != EloData.ApiUrl + "?uid=" + uid + "&uid=" + uid) throw new Exception("Batch UID URL mismatch");
        bool rejected = false;
        try { EloData.BatchUrl(new string[] { "../../file" }); } catch (ArgumentException) { rejected = true; }
        if (!rejected) throw new Exception("Invalid query UID accepted");
        var root=new Dictionary<string,object>();
        for(int i=0;i<500;i++){var row=new Dictionary<string,object>();row["h"]=new List<object>{"braces } ] and quotes "+(char)34+" slash "+(char)92};row["rating"]=3000+i;root["skip"+i.ToString(System.Globalization.CultureInfo.InvariantCulture)]=row;}
        var chosen=new Dictionary<string,object>();chosen["rating"]=4200;chosen["sigma"]=150;chosen["dx"]=10;root[uid]=chosen;
        string json=Json.Serialize(root);
        foreach(int budget in new int[]{1,7,256})
        {
            var scan=new EloShardScan(json,new string[]{uid});int count=0;
            while(!scan.Done){int before=scan.Position;scan.Step(budget);if(scan.Position-before>budget)throw new Exception("Scan exceeded character budget");if(++count>json.Length+5)throw new Exception("Scan stalled");}
            if(scan.Rows.Count!=1||!EloData.ReadPlayer(scan.Rows,uid).Found||EloData.ReadPlayer(scan.Rows,uid).Score!=4200)throw new Exception("Selective shard read failed");
        }
        foreach(string broken in new string[]{"[]","{", "{\"x\":[]}","{\"x\":{]} ","{} trailing","{\"x\":{},}"})
        {
            bool failed=false;
            try{var scan=new EloShardScan(broken,new string[]{uid});while(!scan.Done)scan.Step(2);}catch(FormatException){failed=true;}
            if(!failed)throw new Exception("Malformed shard accepted");
        }
        // Exercise BCL skip paths at string/escape and bracket boundaries in the interpreter too.
        string payload = "";
        for (int i = 0; i < 128; i++) payload += "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        string longText = "{\"skip\":{\"text\":\"" + payload + "\"},\"" + uid + "\":{\"rating\":4200,\"sigma\":150}}";
        var fast = new EloShardScan(longText, new string[] { uid });
        while (!fast.Done) fast.Step(1024);
        if (EloData.ReadPlayer(fast.Rows, uid).Score != 4200) throw new Exception("Long native skip lost target row");
    }
}
