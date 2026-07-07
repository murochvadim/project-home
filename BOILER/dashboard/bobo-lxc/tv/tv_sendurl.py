import json, ssl, base64, time, os, sys
import websocket
HOST='192.168.1.199'; TF='/opt/media-agent/tv55_bobo_token.txt'
url = sys.argv[1] if len(sys.argv)>1 else 'http://192.168.1.138:8770/'
tok=open(TF).read().strip() if os.path.exists(TF) else ''
name=base64.b64encode(b'BoBoGame').decode()
u='wss://%s:8002/api/v2/channels/samsung.remote.control?name=%s'%(HOST,name)
if tok: u+='&token=%s'%tok
ws=websocket.create_connection(u, sslopt={'cert_reqs':ssl.CERT_NONE}); ws.settimeout(3)
t=time.time(); ok=False
while time.time()-t<10:
    try: m=json.loads(ws.recv())
    except Exception: continue
    if m.get('event')=='ms.channel.connect': ok=True; break
print('ws connected:',ok)
ws.send(json.dumps({'method':'ms.remote.control','params':{'Cmd':base64.b64encode(url.encode()).decode(),'DataOfCmd':'base64','TypeOfRemote':'SendInputString'}}))
print('sent text:', url)
ws.close()
