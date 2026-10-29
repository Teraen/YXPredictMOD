import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandler} from './server.mjs';
import {Rooms} from './rooms.mjs';
const origin='https://duma.kaigua.vip';
test('same-origin auth relay uses central YG login and host-scoped HttpOnly cookie without forwarding arbitrary credentials',async()=>{
 const calls=[],token='f'.repeat(64),upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({path:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks))});
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/guides/login'){res.setHeader('set-cookie','yx_guide_session='+token+'; Path=/v1/guides; HttpOnly; SameSite=Strict');res.end('{"ok":true}');}
  else if(req.url==='/v1/guides/prediction-ticket')res.end('{"ticket":"signed-proof"}');
  else res.end('{"ok":true}');
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const authOrigin='http://127.0.0.1:'+upstream.address().port;
 const server=http.createServer(createHandler(new Rooms(),{authOrigin,webOrigin:origin}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const headers={'content-type':'application/json','x-prediction-client':'1',origin};
 const post=(path,body={},extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 try{
  assert.equal((await post('/auth/login',{code:'YG-test'},{origin:'https://evil.test'})).status,403);assert.equal(calls.length,0);
  const login=await post('/auth/login',{code:'YG-test',injected:'discard'}, {authorization:'Bearer secret'});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/Path=\/auth; HttpOnly; SameSite=Strict.*Secure/);assert.equal(login.headers.get('set-cookie').includes('Domain='),false);
  assert.deepEqual(calls[0].body,{code:'YG-test'});assert.equal(calls[0].headers.authorization,undefined);assert.equal(calls[0].headers.origin,authOrigin);assert.equal(calls[0].headers['x-guide-client'],'1');
  const ticket=await post('/auth/ticket',{}, {cookie:'unrelated=private; yx_guide_session='+token});assert.equal((await ticket.json()).ticket,'signed-proof');assert.equal(calls[1].headers.cookie,'yx_guide_session='+token);
  const logout=await post('/auth/logout',{}, {cookie:'yx_guide_session='+token});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await post('/auth/admin')).status,404);assert.equal(calls.length,3);
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));}
});
test('auth relay fails closed on upstream network errors or missing session confirmation',async()=>{
 for(const fetchAuth of [async()=>{throw Error('private network diagnostic')},async()=>new Response('{"ok":true}',{status:200})]){
  const server=http.createServer(createHandler(new Rooms(),{fetchAuth,webOrigin:origin}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-prediction-client':'1',origin},body:'{"code":"YG-test"}'});assert.equal(r.status,502);assert.equal((await r.text()).includes('private network diagnostic'),false);}finally{await new Promise(r=>server.close(r));}
 }
});
