import {RoomError} from './rooms.mjs';
// Only these guide endpoints are relayed. No cross-domain browser cookie or auth DB copy.
export function createAuthRelay({authOrigin=process.env.PREDICTION_AUTH_ORIGIN??'https://auth.kaigua.vip',webOrigin=process.env.PREDICTION_WEB_ORIGIN??'https://duma.kaigua.vip',fetchAuth=fetch}={}) {
  const origin=new URL(authOrigin);if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)))throw new Error('Auth origin requires HTTPS');
  const paths={'/auth/login':'/v1/guides/login','/auth/logout':'/v1/guides/logout','/auth/ticket':'/v1/guides/prediction-ticket'};
  return async(req,res,body)=>{
    const path=paths[req.url];if(!path)throw new RoomError('接口不存在',404);
    const session=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>/^yx_guide_session=[a-f0-9]{64}$/.test(s));
    const headers={'Content-Type':'application/json','X-Guide-Client':'1',Origin:origin.origin};if(session)headers.Cookie=session;
    let response,data;
    try{
      response=await fetchAuth(origin.origin+path,{method:'POST',headers,body:JSON.stringify(req.url==='/auth/login'?{code:body.code}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});
      const text=await response.text();if(text.length>8192)throw new Error('Oversized auth response');data=JSON.parse(text);
    }catch{throw new RoomError('登录服务暂时不可用，请稍后重试',502);}
    if(!response.ok)throw new RoomError(typeof data.error==='string'?data.error:'登录失败',response.status>=400&&response.status<500?response.status:502);
    if(req.url==='/auth/login'){
      const raw=response.headers.get('set-cookie')??'',match=raw.match(/(?:^|;\s*)yx_guide_session=([a-f0-9]{64})(?:;|$)/);
      if(!match)throw new RoomError('登录会话未确认，请重新登录',502);
      res.setHeader('Set-Cookie','yx_guide_session='+match[1]+'; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=604800'+(webOrigin.startsWith('https:')?'; Secure':''));
    }
    if(req.url==='/auth/logout')res.setHeader('Set-Cookie','yx_guide_session=; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=0'+(webOrigin.startsWith('https:')?'; Secure':''));
    res.end(JSON.stringify(req.url==='/auth/ticket'?{ticket:data.ticket}:{ok:true}));
  };
}
